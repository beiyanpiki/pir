import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { promisify } from "node:util";
import { sha256 } from "../core/types.js";
import { MEMORY_SCHEMA_VERSION, applySnapshot, emptySnapshot, exportSnapshot, mergeSnapshots, openSyncTargetStore, syncTargetDbPath, type MemorySnapshot } from "../memory/sync.js";
import { SqliteStore } from "../memory/sqlite-store.js";
import { USAGE, UsageError, executePirCommand, parseArgs, pinRefsToShas, readVersion } from "../cli/executor.js";

const execFileAsync = promisify(execFile);

export interface ServeOptions {
  host?: string;
  port?: number;
  cert?: string;
  key?: string;
  token?: string;
  /** Requests' --cwd must resolve under this directory. */
  workspace?: string;
}

const MAX_BODY_BYTES = 1024 * 1024;
// Bundle uploads carry the client's history (full bundles on first contact).
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
// Memory snapshots carry every summary row of one project.
const MAX_SYNC_BYTES = 64 * 1024 * 1024;

/**
 * /v1/review reviews the bundle the client shipped — nothing else. Registry
 * management (repos: server-side clones, purge) belongs to /v1/exec, and
 * models/config/skill/serve have no business running against a worktree.
 */
const REVIEW_ENDPOINT_COMMANDS = new Set(["find", "memory", "findings", "feedback", "remember", "verify-fix"]);

/**
 * HTTPS wrapper around the shared command executor. One request = one pir
 * invocation: POST /v1/exec {"argv": ["find", "--json", ...]} returns
 * {code, output, log}. Commands run serially — review sessions and the
 * sqlite store assume single-writer access per workspace.
 */
export async function runServe(argv: string[]): Promise<void> {
  const options = parseServeArgs(argv);
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 8790;
  const token = options.token ?? process.env.PIR_SERVER_TOKEN;
  const workspace = path.resolve(options.workspace ?? process.env.PIR_WORKSPACE ?? process.cwd());
  const handle = await startServer({ host, port, token, workspace, tls: await resolveTls(options) });
  const log = handle.log;

  log(
    `listening on ${handle.url} | workspace ${workspace} | auth ${token ? "bearer" : "NONE"} | tls ${handle.tls ? "on" : "OFF"}`,
  );
  if (!handle.tls) {
    log("WARNING: serving plain HTTP (no cert/key and no openssl available)");
  }
  if (!token) {
    log("WARNING: no PIR_SERVER_TOKEN set — the executor endpoint is unauthenticated");
  }

  const shutdown = (): void => {
    handle.close();
    // If connections keep the socket alive, force-exit after a grace period.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Keep the process (and the server) alive; exit happens via signals only.
  await new Promise<never>(() => {});
}

export interface ServerHandle {
  url: string;
  tls: boolean;
  log: (message: string) => void;
  close: () => void;
}

export async function startServer(input: {
  host: string;
  port: number;
  token?: string;
  workspace: string;
  tls: TlsMaterial | null;
}): Promise<ServerHandle> {
  const log = (message: string): void => {
    process.stderr.write(`[pir-serve ${new Date().toISOString()}] ${message}\n`);
  };

  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://local");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: readVersion(), tls: Boolean(input.tls) }));
      return;
    }
    if (
      req.method === "POST" &&
      (url.pathname === "/v1/exec" || url.pathname === "/v1/review" || url.pathname === "/v1/memory/sync")
    ) {
      if (input.token && req.headers.authorization !== `Bearer ${input.token}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing or invalid bearer token" }));
        return;
      }
      if (url.pathname === "/v1/review") {
        void handleReview(req, res);
      } else if (url.pathname === "/v1/memory/sync") {
        void handleMemorySync(req, res);
      } else {
        void handleExec(req, res);
      }
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: "not found",
        endpoints: ["GET /health", "POST /v1/exec", "POST /v1/review", "POST /v1/memory/sync"],
      }),
    );
  };

  /**
   * coderabbit-cli style flow: the client ships its LOCAL state as a git
   * bundle (unpushed commits included); we materialize a throwaway worktree
   * and run the requested command there under the repo's stable projectId.
   */
  async function handleReview(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const logLines: string[] = [];
    try {
      const body = await readBody(req, MAX_BUNDLE_BYTES);
      const parsed = JSON.parse(body) as {
        remoteUrl?: string | null;
        rootCommit?: string;
        base?: string | null;
        head?: string;
        bundleBase64?: string;
        argv?: string[];
      };
      if (!parsed.head || !parsed.rootCommit || typeof parsed.bundleBase64 !== "string") {
        throw new Error("body must include rootCommit, head and bundleBase64");
      }
      if (parsed.argv !== undefined && (!Array.isArray(parsed.argv) || parsed.argv.some((a) => typeof a !== "string"))) {
        throw new Error('body argv must be an array of strings');
      }
      const argv = Array.isArray(parsed.argv) ? (parsed.argv as string[]) : ["find"];
      // Whitelist the command: parseArgs is the authority on what the first
      // positional is (it skips value-flag arguments, so a URL after --repo
      // can't masquerade as the command).
      const command = parseArgs(argv).positional[0] ?? "find";
      if (!REVIEW_ENDPOINT_COMMANDS.has(command)) {
        throw new Error(`command not allowed on /v1/review: ${command} (use /v1/exec for repos/models)`);
      }

      const bundle = Buffer.from(parsed.bundleBase64, "base64");
      const { materializeFromBundle, reviewDbPath } = await import("../app/repos.js");
      let materialized: import("../app/repos.js").MaterializedReview;
      try {
        materialized = (await materializeFromBundle(bundle, {
          remoteUrl: parsed.remoteUrl ?? null,
          rootCommit: parsed.rootCommit,
          base: parsed.base ?? null,
          head: parsed.head,
        })).review;
      } catch (err) {
        if ((err as { needFull?: boolean }).needFull) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ needFull: true }));
          return;
        }
        throw err;
      }
      log(`materialized worktree at ${materialized.headCommit.slice(0, 10)}`);

      // Force the review into the worktree; drop any client --cwd (both the
      // two-token and the --cwd=path form).
      const cleanedArgv: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--cwd") {
          i += 1;
          continue;
        }
        if (argv[i]!.startsWith("--cwd=")) continue;
        cleanedArgv.push(argv[i]!);
      }
      // Older clients also forward raw refs in argv — pin them to the SHAs
      // this request actually materialized so the diff resolves in a repo
      // without remote-tracking refs.
      const pinnedArgv = pinRefsToShas(cleanedArgv, {
        base: parsed.base ?? null,
        head: materialized.headCommit,
      });
      const effectiveArgv = ["--cwd", materialized.worktree, ...pinnedArgv];
      try {
        const result = await enqueue(() =>
          executePirCommand(effectiveArgv, {
            cwdGuard: materialized!.worktree,
            dbPath: reviewDbPath(materialized!.projectId),
            onLog: (message) => {
              logLines.push(message);
              log(`${cleanedArgv.join(" ")} :: ${message}`);
            },
          }),
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: result.code, output: result.output, log: logLines }));
      } finally {
        await materialized.cleanup();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof UsageError) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 2, output: "", log: [...logLines, `pir: ${message}`, USAGE] }));
        return;
      }
      log(`review error: ${message}`);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  }

  /**
   * Bidirectional memory merge: the client ships its snapshot, we merge it
   * with the server-side DB for that project (the same deterministic,
   * symmetric function the client applies), persist the result and return it
   * so both sides converge. projectId is re-derived from the shipped identity
   * so a token holder cannot clobber another project's memory.
   */
  async function handleMemorySync(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await readBody(req, MAX_SYNC_BYTES);
      const parsed = JSON.parse(body) as {
        projectId?: string;
        remoteUrl?: string | null;
        normalizedRemote?: string | null;
        rootCommit?: string;
        snapshot?: MemorySnapshot;
        dryRun?: boolean;
      };
      if (!parsed.projectId || !parsed.rootCommit || !parsed.snapshot) {
        throw new Error("body must include projectId, rootCommit and snapshot");
      }
      const normalizedRemote = parsed.normalizedRemote ?? null;
      const derived = sha256(`${normalizedRemote ?? "local"}\u0000${parsed.rootCommit}`);
      if (derived !== parsed.projectId) {
        throw new Error("projectId does not match the shipped identity (remote + rootCommit)");
      }
      const snapshot = parsed.snapshot;
      if (snapshot.projectId !== parsed.projectId) {
        throw new Error("snapshot belongs to a different project than the request");
      }
      if (snapshot.schemaVersion !== MEMORY_SCHEMA_VERSION) {
        throw new Error(
          `snapshot schema ${snapshot.schemaVersion} != server schema ${MEMORY_SCHEMA_VERSION}; upgrade pir so both sides match`,
        );
      }
      const payload = await enqueue(async () => {
        // dryRun must not leave a trace: when the project has no server DB
        // yet, merge against a synthetic empty snapshot instead of creating
        // one. The client's snapshot goes FIRST so the stats read from the
        // caller's perspective.
        const dbPath = syncTargetDbPath(parsed.projectId!);
        if (parsed.dryRun) {
          if (!existsSync(dbPath)) {
            return mergeSnapshots(snapshot, emptySnapshot(parsed.projectId!));
          }
          const store = SqliteStore.open(dbPath);
          try {
            return mergeSnapshots(snapshot, exportSnapshot(store, parsed.projectId!));
          } finally {
            store.close();
          }
        }
        const store = openSyncTargetStore(parsed.projectId!, {
          remote: parsed.remoteUrl ?? null,
          normalizedRemote,
          rootCommit: parsed.rootCommit!,
        });
        try {
          const result = mergeSnapshots(snapshot, exportSnapshot(store, parsed.projectId!));
          applySnapshot(store, parsed.projectId!, result.merged);
          return result;
        } finally {
          store.close();
        }
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`memory sync error: ${message}`);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  }

  async function handleExec(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body) as { argv?: unknown };
      if (!Array.isArray(parsed.argv) || parsed.argv.some((a) => typeof a !== "string")) {
        throw new Error('body must be {"argv": [string, ...]}');
      }
      const argv = parsed.argv as string[];
      if (argv.includes("serve")) {
        throw new Error("refusing to execute serve recursively");
      }
      // Requests without an explicit --cwd operate on the workspace root.
      const effectiveArgv = argv.includes("--cwd") ? argv : ["--cwd", input.workspace, ...argv];
      const logLines: string[] = [];
      const result = await enqueue(() =>
        executePirCommand(effectiveArgv, {
          cwdGuard: input.workspace,
          onLog: (message) => {
            logLines.push(message);
            log(`${argv.join(" ")} :: ${message}`);
          },
        }),
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: result.code, output: result.output, log: logLines }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof UsageError) {
        // Mirror the local CLI contract: usage problems are exit code 2 with
        // the message on the log channel, not an HTTP error.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 2, output: "", log: [`pir: ${message}`, USAGE] }));
        return;
      }
      log(`error: ${message}`);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  }

  const server = input.tls
    ? https.createServer({ cert: input.tls.cert, key: input.tls.key }, handler)
    : http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(input.port, input.host, resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : input.port;
  return {
    url: `${input.tls ? "https" : "http"}://${input.host}:${actualPort}`,
    tls: Boolean(input.tls),
    log,
    close: () => server.close(),
  };
}

function parseServeArgs(argv: string[]): ServeOptions {
  const options: ServeOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const value = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new UsageError(`missing value for ${token}`);
      i += 1;
      return v;
    };
    if (token === "--host") options.host = value();
    else if (token === "--port") options.port = Number(value());
    else if (token === "--cert") options.cert = value();
    else if (token === "--key") options.key = value();
    else if (token === "--token") options.token = value();
    else if (token === "--workspace") options.workspace = value();
    else throw new UsageError(`unknown serve option: ${token}`);
  }
  return options;
}

interface TlsMaterial {
  cert: string;
  key: string;
}

/**
 * TLS material resolution: explicit --cert/--key > PIR_TLS_CERT/PIR_TLS_KEY >
 * a self-signed pair generated with openssl (persisted so restarts keep the
 * same key). Plain HTTP only as an explicit PIR_ALLOW_HTTP=1 escape hatch.
 */
async function resolveTls(options: ServeOptions): Promise<TlsMaterial | null> {
  const certPath = options.cert ?? process.env.PIR_TLS_CERT;
  const keyPath = options.key ?? process.env.PIR_TLS_KEY;
  if (certPath && keyPath) {
    return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
  }
  if (certPath || keyPath) {
    throw new Error("TLS requires both --cert and --key (or PIR_TLS_CERT and PIR_TLS_KEY)");
  }

  const certDir = process.env.PIR_CERT_DIR ?? "/tmp/pir-certs";
  const generatedCert = path.join(certDir, "pir-cert.pem");
  const generatedKey = path.join(certDir, "pir-key.pem");
  if (existsSync(generatedCert) && existsSync(generatedKey)) {
    return { cert: readFileSync(generatedCert, "utf8"), key: readFileSync(generatedKey, "utf8") };
  }
  try {
    mkdirSync(certDir, { recursive: true });
    await execFileAsync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-days", "3650",
      "-subj", "/CN=pir",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout", generatedKey,
      "-out", generatedCert,
    ]);
    return { cert: readFileSync(generatedCert, "utf8"), key: readFileSync(generatedKey, "utf8") };
  } catch (err) {
    if (process.env.PIR_ALLOW_HTTP === "1") return null;
    throw new Error(
      `cannot obtain TLS material (openssl unavailable: ${err instanceof Error ? err.message : String(err)}); ` +
        "provide --cert/--key or set PIR_ALLOW_HTTP=1 explicitly",
    );
  }
}

function readBody(req: http.IncomingMessage, limitBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
