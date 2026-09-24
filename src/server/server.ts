import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { promisify } from "node:util";
import { USAGE, UsageError, executePirCommand, readVersion } from "../cli/executor.js";

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
    if (req.method === "POST" && url.pathname === "/v1/exec") {
      if (input.token && req.headers.authorization !== `Bearer ${input.token}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing or invalid bearer token" }));
        return;
      }
      void handleExec(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", endpoints: ["GET /health", "POST /v1/exec"] }));
  };

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

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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
