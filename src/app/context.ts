import { isGitRepo } from "../changes/git.js";
import { createCodeMap } from "../codemap/provider.js";
import type { CodeMapProvider } from "../codemap/types.js";
import { Memory } from "../memory/index.js";
import type { ProjectIdentity } from "../memory/identity.js";
import { PiSessionFactory } from "../agents/session-factory.js";
import type { AgentSessionFactory } from "../agents/types.js";

export interface AppContext {
  repoRoot: string;
  memory: Memory;
  codeMap: CodeMapProvider;
  codeMapDegraded: boolean;
  factory: AgentSessionFactory;
}

export interface AppContextOptions {
  /** Test seam: inject a fake session factory. */
  factory?: AgentSessionFactory;
  /** Skip the codegraph sync probe. */
  noSyncIndex?: boolean;
  /** Test seam: custom sqlite location. */
  dbPath?: string;
  /**
   * Server read lane: open the memory db as a WAL reader (no migrations,
   * no project-row insert, no index sync) so pure-read commands can run
   * while a review holds single-writer access. The db file must already
   * exist; callers route first contact through a normal (queued) open.
   */
  readOnlyMemory?: boolean;
  /**
   * Identity override for the server's bundle-free read lane: the request's
   * remoteUrl + rootCommit pin the project without materializing a worktree
   * (there is nothing to run git against — that is the point). Only meaningful
   * together with dbPath + readOnlyMemory.
   */
  identity?: ProjectIdentity;
}

export async function createAppContext(repoRoot: string, options: AppContextOptions = {}): Promise<AppContext> {
  if (!options.identity && !(await isGitRepo(repoRoot))) {
    throw new Error(`not a git repository: ${repoRoot}`);
  }
  const memory = options.identity
    ? Memory.openDirect(options.identity, {
        dbPath: options.dbPath!,
        ...(options.readOnlyMemory ? { readOnly: true } : {}),
      })
    : await Memory.open(repoRoot, {
        ...(options.dbPath ? { dbPath: options.dbPath } : {}),
        ...(options.readOnlyMemory ? { readOnly: true } : {}),
      });
  const codeMapResult = await createCodeMap(repoRoot);
  if (codeMapResult.degraded) {
    // Structural context silently missing is the worst failure mode for a
    // reviewer; make the degradation observable once per review run.
    process.stderr.write(`pir: codegraph degraded (${codeMapResult.reason}): ${codeMapResult.detail}\n`);
  }
  // A reader must not sync the index either: ensureSynced writes the shared
  // codegraph index a queued command may be relying on.
  if (!codeMapResult.degraded && !options.noSyncIndex && !options.readOnlyMemory) {
    try {
      await codeMapResult.provider.ensureSynced();
    } catch {
      // sync is best-effort; queries still work off the existing index
    }
  }
  return {
    repoRoot,
    memory,
    codeMap: codeMapResult.provider,
    codeMapDegraded: codeMapResult.degraded,
    factory: options.factory ?? new PiSessionFactory(),
  };
}
