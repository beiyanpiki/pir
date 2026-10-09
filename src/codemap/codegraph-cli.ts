import { spawn } from "node:child_process";
import type {
  AffectedTests,
  CodeMapProvider,
  CodeSymbol,
  FileSummary,
  IndexStatus,
} from "./types.js";

const QUERY_TIMEOUT_MS = 30_000;
/** Exported for the seed lock's staleness math in app/repos.ts. */
export const CODEGRAPH_SYNC_TIMEOUT_MS = 120_000;
// A first-time init is a full index build — far heavier than a sync.
const INIT_TIMEOUT_MS = 300_000;
/** Same as CODEGRAPH_SYNC_TIMEOUT_MS: bounds how long an activation can hold
 *  the per-project seed lock when it has to build the initial index. */
export const CODEGRAPH_INIT_TIMEOUT_MS = INIT_TIMEOUT_MS;

export class CodeMapError extends Error {
  constructor(
    message: string,
    readonly kind: "not_installed" | "not_initialized" | "timeout" | "bad_output" | "failed",
  ) {
    super(message);
    this.name = "CodeMapError";
  }
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function execCodegraph(args: string[], options: { stdin?: string; timeoutMs?: number }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("codegraph", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new CodeMapError(`codegraph ${args[0]} timed out`, "timeout"));
    }, options.timeoutMs ?? QUERY_TIMEOUT_MS);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new CodeMapError("codegraph executable not found", "not_installed"));
      } else {
        reject(new CodeMapError(`codegraph failed to start: ${err.message}`, "failed"));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    // The child may exit before consuming stdin (e.g. it errors out at
    // startup): an EPIPE here must not surface as an unhandled stream
    // error — the close event and the exit code carry the real outcome.
    child.stdin.on("error", () => {});
    if (options.stdin !== undefined) child.stdin.write(options.stdin);
    child.stdin.end();
  });
}

// Known "no index here" wordings from codegraph 1.6.0: `CodeGraph not
// initialized in …`, `no .codegraph/ index exists in …`, and the quoted
// `Run "codegraph init" …` advice. Matched by shape, not by bare substring —
// an unquoted `codegraph init` also shows up in hard-failure hints (e.g.
// index-corruption suggesting `codegraph init --force`) that a re-init will
// not fix and must stay classified as `failed`.
const NOT_INITIALIZED_RE = /not initialized|no \.codegraph[/-] index exists|run ["']codegraph init["']/i;

function classifyExit(args: string[], result: ExecResult): void {
  if (result.code === 0) return;
  if (NOT_INITIALIZED_RE.test(result.stderr)) {
    throw new CodeMapError("codegraph index not initialized for this project", "not_initialized");
  }
  throw new CodeMapError(`codegraph ${args[0]} exited ${result.code}: ${result.stderr.trim()}`, "failed");
}

async function runJson<T>(args: string[], options: { stdin?: string; timeoutMs?: number } = {}): Promise<T> {
  const result = await execCodegraph(args, options);
  classifyExit(args, result);
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new CodeMapError(`codegraph ${args[0]} produced non-JSON output`, "bad_output");
  }
}

// ---- recorded CLI payload shapes (codegraph 1.6.0) ----

interface QueryHit {
  node: {
    kind: string;
    name: string;
    qualifiedName: string;
    filePath: string;
    language?: string;
    startLine: number;
    endLine?: number;
    signature?: string;
  };
  score?: number;
}

interface RelationPayload {
  symbol: string;
  callers?: RelationEntry[];
  callees?: RelationEntry[];
  affected?: RelationEntry[];
}

interface RelationEntry {
  name: string;
  kind?: string;
  filePath?: string;
  startLine?: number;
}

interface StatusPayload {
  initialized: boolean;
  version?: string;
  lastIndexed?: string | null;
  fileCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  pendingChanges?: number | Record<string, number>;
}

function toSymbol(entry: RelationEntry): CodeSymbol {
  return {
    name: entry.name,
    qualifiedName: entry.name,
    kind: entry.kind ?? "unknown",
    filePath: entry.filePath ?? "",
    startLine: entry.startLine ?? 0,
  };
}

function pendingCount(pending: number | Record<string, number> | undefined): number {
  if (pending === undefined) return 0;
  if (typeof pending === "number") return pending;
  return Object.values(pending).reduce((a, b) => a + b, 0);
}

/**
 * Opt-in index bootstrap for pir's own server-side state (#64): create an
 * index where none exists. This is the one place pir runs `codegraph init`,
 * and only ever on directories pir owns (registered clones, bundle cache
 * dirs, throwaway review worktrees) — never on a user's checkout, which
 * `createCodeMap` deliberately leaves alone.
 */
export async function codegraphInit(repoRoot: string): Promise<void> {
  const result = await execCodegraph(["init", "-y", repoRoot], { timeoutMs: INIT_TIMEOUT_MS });
  classifyExit(["init"], result);
}

/**
 * Unconditional sync. `status`'s pendingChanges signal is unreliable in the
 * worktree/copy setups pir builds (verified against 1.6.0: it reports zero
 * changes while the index is a commit behind), so index preparation must not
 * gate on it the way `ensureSynced` does.
 */
export async function codegraphSync(repoRoot: string): Promise<void> {
  const result = await execCodegraph(["sync", "-q", repoRoot], { timeoutMs: CODEGRAPH_SYNC_TIMEOUT_MS });
  classifyExit(["sync"], result);
}

/**
 * Adapter over the external `codegraph` CLI. Process-level isolation only:
 * every call spawns the CLI and consumes its `--json` output; nothing is
 * imported from the codegraph package.
 */
export class CodeGraphCliAdapter implements CodeMapProvider {
  readonly kind = "codegraph" as const;
  readonly structuralQueries = true;

  constructor(private readonly repoRoot: string) {}

  async status(): Promise<IndexStatus> {
    // codegraph 1.6.0 `status` takes only -j plus a positional path — no -p.
    const payload = await runJson<StatusPayload>(["status", "-j", this.repoRoot]);
    return {
      initialized: payload.initialized === true,
      available: true,
      lastIndexed: payload.lastIndexed ?? null,
      nodeCount: payload.nodeCount ?? 0,
      edgeCount: payload.edgeCount ?? 0,
      fileCount: payload.fileCount ?? 0,
      pendingChanges: pendingCount(payload.pendingChanges),
      version: payload.version,
    };
  }

  async ensureSynced(): Promise<IndexStatus> {
    const current = await this.status();
    if (!current.initialized) return current;
    if (current.pendingChanges > 0) {
      // `sync` has no -p and never emits JSON: -q + positional path, judge by exit code.
      const result = await execCodegraph(["sync", "-q", this.repoRoot], { timeoutMs: CODEGRAPH_SYNC_TIMEOUT_MS });
      classifyExit(["sync"], result);
      return this.status();
    }
    return current;
  }

  async searchSymbols(query: string, opts: { kind?: string; limit?: number } = {}): Promise<CodeSymbol[]> {
    const args = ["query", query, "-p", this.repoRoot, "-l", String(opts.limit ?? 10), "-j"];
    if (opts.kind) args.push("-k", opts.kind);
    const hits = await runJson<QueryHit[]>(args);
    return hits.map((hit) => ({
      name: hit.node.name,
      qualifiedName: hit.node.qualifiedName,
      kind: hit.node.kind,
      filePath: hit.node.filePath,
      startLine: hit.node.startLine,
      endLine: hit.node.endLine,
      signature: hit.node.signature,
      language: hit.node.language,
      score: hit.score,
    }));
  }

  async callers(symbol: string, opts: { limit?: number } = {}): Promise<CodeSymbol[]> {
    const payload = await runJson<RelationPayload>([
      "callers",
      symbol,
      "-p",
      this.repoRoot,
      "-l",
      String(opts.limit ?? 20),
      "-j",
    ]);
    return (payload.callers ?? []).map(toSymbol);
  }

  async callees(symbol: string, opts: { limit?: number } = {}): Promise<CodeSymbol[]> {
    const payload = await runJson<RelationPayload>([
      "callees",
      symbol,
      "-p",
      this.repoRoot,
      "-l",
      String(opts.limit ?? 20),
      "-j",
    ]);
    return (payload.callees ?? []).map(toSymbol);
  }

  async dependents(symbol: string, opts: { depth?: number } = {}): Promise<CodeSymbol[]> {
    const payload = await runJson<RelationPayload>([
      "impact",
      symbol,
      "-p",
      this.repoRoot,
      "-d",
      String(opts.depth ?? 2),
      "-j",
    ]);
    return (payload.affected ?? []).map(toSymbol);
  }

  async affectedTests(files: string[]): Promise<AffectedTests> {
    const payload = await runJson<{ changedFiles?: string[]; affectedTests?: string[] }>(
      ["affected", "-p", this.repoRoot, "--stdin", "-j"],
      { stdin: files.join("\n") },
    );
    return { changedFiles: payload.changedFiles ?? [], affectedTests: payload.affectedTests ?? [] };
  }

  async fileOverview(): Promise<FileSummary[]> {
    return runJson<FileSummary[]>(["files", "-p", this.repoRoot, "-j"]);
  }
}
