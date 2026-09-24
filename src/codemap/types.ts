/** A code symbol as surfaced by the structural index. */
export interface CodeSymbol {
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine?: number;
  signature?: string;
  language?: string;
  score?: number;
}

export interface FileSummary {
  path: string;
  language: string;
  nodeCount: number;
  size: number;
}

export interface IndexStatus {
  initialized: boolean;
  available: boolean;
  lastIndexed: string | null;
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  pendingChanges: number;
  version?: string;
}

export interface AffectedTests {
  changedFiles: string[];
  affectedTests: string[];
}

/**
 * Structural view over the codebase ("what the code is now"). Implementations:
 * CodeGraphCliAdapter (external CLI, JSON-only) and DegradedCodeMap
 * (no structural queries, file-level only). Completely decoupled from the
 * semantic Repository Memory.
 */
export interface CodeMapProvider {
  readonly kind: "codegraph" | "degraded";
  /** False when structural queries are unavailable (degraded mode). */
  readonly structuralQueries: boolean;
  status(): Promise<IndexStatus>;
  /** Sync the index if one exists; never initializes a new index. */
  ensureSynced(): Promise<IndexStatus>;
  searchSymbols(query: string, opts?: { kind?: string; limit?: number }): Promise<CodeSymbol[]>;
  callers(symbol: string, opts?: { limit?: number }): Promise<CodeSymbol[]>;
  callees(symbol: string, opts?: { limit?: number }): Promise<CodeSymbol[]>;
  dependents(symbol: string, opts?: { depth?: number }): Promise<CodeSymbol[]>;
  affectedTests(files: string[]): Promise<AffectedTests>;
  fileOverview(): Promise<FileSummary[]>;
}

export function symbolKeyOf(symbol: CodeSymbol): string {
  return symbol.qualifiedName || symbol.name;
}
