import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { CodeGraphCliAdapter, CodeMapError } from "./codegraph-cli.js";
export { CodeGraphCliAdapter, CodeMapError } from "./codegraph-cli.js";
import type { CodeMapProvider, FileSummary, IndexStatus } from "./types.js";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".codegraph",
  ".venv",
  "__pycache__",
  "target",
  "vendor",
]);

const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "rb",
  "c", "h", "cpp", "hpp", "cs", "swift", "php", "scala", "sh", "sql", "yaml", "yml", "toml", "json",
]);

/**
 * Fallback when codegraph is absent or has no index: no structural queries,
 * file listing only. Structural tool calls report themselves unavailable so
 * agents can adapt instead of guessing.
 */
export class DegradedCodeMap implements CodeMapProvider {
  readonly kind = "degraded" as const;
  readonly structuralQueries = false;

  constructor(
    private readonly repoRoot: string,
    readonly reason: string,
  ) {}

  async status(): Promise<IndexStatus> {
    return {
      initialized: false,
      available: false,
      lastIndexed: null,
      nodeCount: 0,
      edgeCount: 0,
      fileCount: await this.countFiles(),
      pendingChanges: 0,
    };
  }

  async ensureSynced(): Promise<IndexStatus> {
    return this.status();
  }

  async searchSymbols(): Promise<never[]> {
    throw new CodeMapError(`structural queries unavailable (${this.reason})`, "not_initialized");
  }

  async callers(): Promise<never[]> {
    throw new CodeMapError(`structural queries unavailable (${this.reason})`, "not_initialized");
  }

  async callees(): Promise<never[]> {
    throw new CodeMapError(`structural queries unavailable (${this.reason})`, "not_initialized");
  }

  async dependents(): Promise<never[]> {
    throw new CodeMapError(`structural queries unavailable (${this.reason})`, "not_initialized");
  }

  async affectedTests(): Promise<{ changedFiles: string[]; affectedTests: string[] }> {
    return { changedFiles: [], affectedTests: [] };
  }

  async fileOverview(): Promise<FileSummary[]> {
    const out: FileSummary[] = [];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry)) continue;
        const full = path.join(dir, entry);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile() && TEXT_EXTENSIONS.has(path.extname(entry).slice(1).toLowerCase())) {
          const rel = path.relative(this.repoRoot, full);
          if (!isListable(rel)) continue;
          out.push({ path: rel.split(path.sep).join("/"), language: path.extname(entry).slice(1), nodeCount: 0, size: st.size });
        }
      }
    };
    walk(this.repoRoot);
    return out;
  }

  private async countFiles(): Promise<number> {
    return (await this.fileOverview()).length;
  }
}

function isListable(relPath: string): boolean {
  // Skip lock files and vendored blobs that carry no review signal.
  return !/(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|poetry\.lock)$/.test(relPath);
}

export interface CreateCodeMapResult {
  provider: CodeMapProvider;
  degraded: boolean;
  reason?: string;
}

/**
 * Probe the external codegraph CLI; use it when installed AND initialized for
 * this repo, otherwise degrade. Never runs `codegraph init` on the user's repo.
 */
export async function createCodeMap(repoRoot: string): Promise<CreateCodeMapResult> {
  const adapter = new CodeGraphCliAdapter(repoRoot);
  try {
    const status = await adapter.status();
    if (!status.initialized) {
      return {
        provider: new DegradedCodeMap(repoRoot, "codegraph index not initialized; run `codegraph init` to enable structural queries"),
        degraded: true,
        reason: "not_initialized",
      };
    }
    return { provider: adapter, degraded: false };
  } catch (err) {
    if (err instanceof CodeMapError && (err.kind === "not_installed" || err.kind === "timeout")) {
      return {
        provider: new DegradedCodeMap(repoRoot, "codegraph CLI not available"),
        degraded: true,
        reason: err.kind,
      };
    }
    if (err instanceof CodeMapError && err.kind === "not_initialized") {
      return {
        provider: new DegradedCodeMap(repoRoot, "codegraph index not initialized; run `codegraph init` to enable structural queries"),
        degraded: true,
        reason: "not_initialized",
      };
    }
    // Unexpected failure probing the CLI: degrade rather than block review.
    return {
      provider: new DegradedCodeMap(repoRoot, `codegraph probe failed: ${err instanceof Error ? err.message : String(err)}`),
      degraded: true,
      reason: "probe_failed",
    };
  }
}
