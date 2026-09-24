import { isGitRepo } from "../changes/git.js";
import { createCodeMap } from "../codemap/provider.js";
import type { CodeMapProvider } from "../codemap/types.js";
import { Memory } from "../memory/index.js";
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
}

export async function createAppContext(repoRoot: string, options: AppContextOptions = {}): Promise<AppContext> {
  if (!(await isGitRepo(repoRoot))) {
    throw new Error(`not a git repository: ${repoRoot}`);
  }
  const memory = await Memory.open(repoRoot, options.dbPath ? { dbPath: options.dbPath } : {});
  const codeMapResult = await createCodeMap(repoRoot);
  if (!codeMapResult.degraded && !options.noSyncIndex) {
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
