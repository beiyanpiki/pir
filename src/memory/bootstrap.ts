import { Type } from "typebox";
import type { GeneratedArrays } from "../core/types.js";
import { getHeadCommit } from "../changes/git.js";
import type { CodeMapProvider } from "../codemap/types.js";
import type { Memory } from "./index.js";
import type { AgentSessionFactory, ReviewTool } from "../agents/types.js";
import { READONLY_BUILTIN_TOOLS } from "../agents/types.js";
import { bootstrapAggregatePrompt, bootstrapModulePrompt } from "../agents/prompts.js";
import { createReadCodeTool, createSearchTextTool, createFindSymbolTool } from "../tools/review-tools.js";
import type { ToolContext } from "../tools/context.js";
import { hashFilesAtCommit } from "./freshness.js";
import { getNameStatus } from "../changes/git.js";
import { loadBuiltInPacks } from "../plugins/index.js";

export interface BootstrapOptions {
  model?: string;
  /** Max module batches summarized (cost control). */
  maxBatches?: number;
  maxFilesPerBatch?: number;
}

export interface BootstrapResult {
  modulesSummarized: number;
  batchesSkipped: number;
  featuresCreated: number;
  entitiesCreated: number;
  headCommit: string;
}

interface ModuleSummary {
  module: string;
  summary: string;
  responsibilities: string[];
  symbols: Array<{
    name: string;
    path: string;
    kind: string;
    responsibility: string;
    invariants: string[];
  }>;
  invariants: string[];
}

interface ProjectDraft {
  architectureSummary: string;
  responsibilities: string[];
  invariants: string[];
  conventions: string[];
  riskAreas: string[];
  features: Array<{
    key: string;
    name: string;
    summary: string;
    invariants: string[];
    entryPoints: string[];
    symbols: string[];
  }>;
}

function submitModuleSummaryTool(collector: { summary?: ModuleSummary }): ReviewTool {
  return {
    name: "submit_module_summary",
    description: "Submit the structured summary of the module you analyzed.",
    parameters: Type.Object({
      summary: Type.String(),
      responsibilities: Type.Array(Type.String()),
      symbols: Type.Array(
        Type.Object({
          name: Type.String(),
          path: Type.String(),
          kind: Type.String(),
          responsibility: Type.String(),
          invariants: Type.Array(Type.String()),
        }),
      ),
      invariants: Type.Array(Type.String()),
    }),
    async execute(params) {
      collector.summary = {
        module: "",
        summary: String(params.summary),
        responsibilities: (params.responsibilities as string[]) ?? [],
        symbols: (params.symbols as ModuleSummary["symbols"]) ?? [],
        invariants: (params.invariants as string[]) ?? [],
      };
      return { text: "Summary recorded.", terminate: true };
    },
  };
}

function submitProjectMemoryTool(collector: { draft?: ProjectDraft }): ReviewTool {
  return {
    name: "submit_project_memory",
    description: "Submit the aggregated project memory: architecture, features and their symbols.",
    parameters: Type.Object({
      architectureSummary: Type.String(),
      responsibilities: Type.Array(Type.String()),
      invariants: Type.Array(Type.String()),
      conventions: Type.Array(Type.String()),
      riskAreas: Type.Array(Type.String()),
      features: Type.Array(
        Type.Object({
          key: Type.String(),
          name: Type.String(),
          summary: Type.String(),
          invariants: Type.Array(Type.String()),
          entryPoints: Type.Array(Type.String()),
          symbols: Type.Array(Type.String()),
        }),
      ),
    }),
    async execute(params) {
      collector.draft = {
        architectureSummary: String(params.architectureSummary),
        responsibilities: (params.responsibilities as string[]) ?? [],
        invariants: (params.invariants as string[]) ?? [],
        conventions: (params.conventions as string[]) ?? [],
        riskAreas: (params.riskAreas as string[]) ?? [],
        features: (params.features as ProjectDraft["features"]) ?? [],
      };
      return { text: "Project memory recorded.", terminate: true };
    },
  };
}

interface ModuleGroup {
  module: string;
  files: Array<{ path: string; nodeCount: number }>;
}

/**
 * Merge an array field across a re-bootstrap: entries the previous agent pass
 * generated drop out unless re-asserted; entries never listed as generated
 * (user-added by construction) always survive. `next` becomes the new
 * generated set for the following run.
 */
function mergeGenerated(
  existing: readonly string[] | null | undefined,
  oldGenerated: readonly string[] | undefined,
  next: readonly string[],
): string[] {
  return [...new Set([...(existing ?? []).filter((entry) => !oldGenerated?.includes(entry)), ...next])];
}

function groupByModule(files: Array<{ path: string; nodeCount: number }>): ModuleGroup[] {
  const groups = new Map<string, ModuleGroup>();
  for (const file of files) {
    const seg = file.path.split("/");
    const module = seg.length > 2 ? seg.slice(0, 2).join("/") : seg.length > 1 ? seg[0]! : ".";
    const group = groups.get(module) ?? { module, files: [] };
    group.files.push(file);
    groups.set(module, group);
  }
  return [...groups.values()].sort((a, b) => b.files.length - a.files.length);
}

/**
 * Bootstrap Project Memory: module-by-module summarization (isolated sessions,
 * never the whole repo in one context), then one aggregation session.
 * Everything is written with source=agent_summary — navigation-grade context
 * that can never suppress a finding.
 */
export async function bootstrapProjectMemory(deps: {
  repoRoot: string;
  memory: Memory;
  codeMap: CodeMapProvider;
  factory: AgentSessionFactory;
  options?: BootstrapOptions;
  onProgress?: (message: string) => void;
}): Promise<BootstrapResult> {
  const options = deps.options ?? {};
  const maxBatches = options.maxBatches ?? 8;
  const maxFiles = options.maxFilesPerBatch ?? 40;
  const head = await getHeadCommit(deps.repoRoot);

  const files = await deps.codeMap.fileOverview();
  // Default code extensions plus every built-in language pack's extensions, so
  // bootstrap sees all languages pir knows about, not a frozen list.
  const codeExtensions = [
    ...new Set(["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "rb", "c", "cpp", "h", ...loadBuiltInPacks().flatMap((pack) => pack.extensions)]),
  ];
  const codeFileRe = new RegExp(`\\.(?:${codeExtensions.map((ext) => ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`, "i");
  const codeFiles = files.filter((f) => f.nodeCount > 0 || codeFileRe.test(f.path));
  const groups = groupByModule(codeFiles);

  const ctx: ToolContext = {
    repoRoot: deps.repoRoot,
    headCommit: head,
    changeSet: {
      repoRoot: deps.repoRoot,
      base: head,
      head,
      mergeBase: head,
      files: [],
      patch: "",
      churn: 0,
    },
    codeMap: deps.codeMap,
    memory: deps.memory,
  };

  const summaries: ModuleSummary[] = [];
  let skipped = 0;
  for (const group of groups.slice(0, maxBatches)) {
    deps.onProgress?.(`summarizing module ${group.module} (${group.files.length} files)`);
    const collector: { summary?: ModuleSummary } = {};
    const session = await deps.factory.createSession({
      cwd: deps.repoRoot,
      systemRole: "module analyst",
      tools: [
        createReadCodeTool(ctx),
        createSearchTextTool(ctx),
        createFindSymbolTool(ctx),
        submitModuleSummaryTool(collector),
      ],
      builtinTools: [...READONLY_BUILTIN_TOOLS],
      model: options.model,
    });
    try {
      await session.prompt(bootstrapModulePrompt({ modulePath: group.module, files: group.files.slice(0, maxFiles) }));
    } finally {
      session.dispose();
    }
    if (collector.summary) {
      collector.summary.module = group.module;
      summaries.push(collector.summary);
    } else {
      skipped += 1;
    }
  }
  skipped += Math.max(0, groups.length - maxBatches);

  deps.onProgress?.(`aggregating ${summaries.length} module summaries into project memory`);
  const aggCollector: { draft?: ProjectDraft } = {};
  if (summaries.length > 0) {
    const session = await deps.factory.createSession({
      cwd: deps.repoRoot,
      systemRole: "project analyst",
      tools: [submitProjectMemoryTool(aggCollector)],
      builtinTools: [],
      model: options.model,
    });
    try {
      await session.prompt(
        bootstrapAggregatePrompt({
          modules: summaries.map((s) => ({
            module: s.module,
            summary: [s.summary, `invariants: ${s.invariants.join("; ")}`, `symbols: ${s.symbols.map((sym) => `${sym.name} (${sym.path})`).join(", ")}`].join("\n"),
          })),
        }),
      );
    } finally {
      session.dispose();
    }
  }

  const headHashes = await hashFilesAtCommit(
    deps.repoRoot,
    head,
    [...new Set(summaries.flatMap((s) => s.symbols.map((sym) => sym.path)))],
  );

  let featuresCreated = 0;
  let entitiesCreated = 0;
  const draft = aggCollector.draft;
  if (draft) {
    // Merge with existing knowledge instead of replacing it: the upserts
    // overwrite array fields wholesale, and user-supplied entries (pir
    // remember, feedback) must survive an agent re-bootstrap. Replacing the
    // agent-generated portion (mergeGenerated) keeps a re-bootstrap from
    // retaining entries the agent no longer asserts.
    const existingProject = deps.memory.projectMemory.get();
    const prevProjectGenerated = existingProject?.agentGenerated;
    const agentGenerated: GeneratedArrays = {
      responsibilities: draft.responsibilities,
      invariants: draft.invariants,
      conventions: draft.conventions,
      riskAreas: draft.riskAreas,
      featureKeys: draft.features.map((f) => f.key),
    };
    deps.memory.projectMemory.upsert({
      architectureSummary: draft.architectureSummary,
      responsibilities: mergeGenerated(existingProject?.responsibilities, prevProjectGenerated?.responsibilities, agentGenerated.responsibilities!),
      invariants: mergeGenerated(existingProject?.invariants, prevProjectGenerated?.invariants, agentGenerated.invariants!),
      conventions: mergeGenerated(existingProject?.conventions, prevProjectGenerated?.conventions, agentGenerated.conventions!),
      riskAreas: mergeGenerated(existingProject?.riskAreas, prevProjectGenerated?.riskAreas, agentGenerated.riskAreas!),
      featureKeys: mergeGenerated(existingProject?.featureKeys, prevProjectGenerated?.featureKeys, agentGenerated.featureKeys!),
      agentGenerated,
      source: existingProject?.source === "user_explicit" ? "user_explicit" : "agent_summary",
      createdAtCommit: head,
      validatedAtCommit: head,
      stale: false,
    });
    for (const feature of draft.features) {
      const existingFeature = deps.memory.features.get(feature.key);
      deps.memory.features.upsert({
        key: feature.key,
        name: feature.name,
        summary: feature.summary,
        responsibilities: [...new Set(existingFeature?.responsibilities ?? [])],
        invariants: mergeGenerated(existingFeature?.invariants, existingFeature?.agentGenerated?.invariants, feature.invariants),
        agentGenerated: { invariants: feature.invariants },
        entryPoints: feature.entryPoints,
        dependencies: [],
        relatedFeatureKeys: [],
        source: "agent_summary",
        confidence: 0.6,
        createdAtCommit: head,
        validatedAtCommit: head,
        stale: false,
      });
      featuresCreated += 1;
      for (const symbolName of feature.symbols) {
        const fromModule = summaries.flatMap((s) => s.symbols).find((sym) => sym.name === symbolName || sym.name.endsWith(`.${symbolName}`));
        if (!fromModule) continue;
        const existingEntity = deps.memory.entities.get(fromModule.name);
        const prevGenerated = existingEntity?.agentGenerated;
        const entityResponsibilities = [fromModule.responsibility].filter(Boolean);
        // Features claim entities one at a time; the generated key set accumulates.
        const entityFeatureKeys = [...new Set([...(prevGenerated?.featureKeys ?? []), feature.key])];
        deps.memory.entities.upsert({
          symbolKey: fromModule.name,
          qualifiedName: fromModule.name,
          kind: fromModule.kind,
          path: fromModule.path,
          signature: null,
          responsibilities: mergeGenerated(existingEntity?.responsibilities, prevGenerated?.responsibilities, entityResponsibilities),
          invariants: mergeGenerated(existingEntity?.invariants, prevGenerated?.invariants, fromModule.invariants),
          agentGenerated: {
            responsibilities: entityResponsibilities,
            invariants: fromModule.invariants,
            featureKeys: entityFeatureKeys,
          },
          notes: [...new Set(existingEntity?.notes ?? [])],
          featureKeys: mergeGenerated(existingEntity?.featureKeys, prevGenerated?.featureKeys, entityFeatureKeys),
          source: "agent_summary",
          signatureHash: null,
          bodyHash: headHashes.get(fromModule.path) ?? null,
          lastSeenCommit: head,
          stale: false,
        });
        entitiesCreated += 1;
      }
    }
  }
  deps.memory.setLastIndexedCommit(head);

  return {
    modulesSummarized: summaries.length,
    batchesSkipped: skipped,
    featuresCreated,
    entitiesCreated,
    headCommit: head,
  };
}

export interface RefreshResult {
  lastIndexedCommit: string | null;
  changedFiles: string[];
  staleMarked: number;
  entitiesRefreshed: number;
  headCommit: string;
}

/**
 * Incremental maintenance: only entities/features touched by commits since
 * lastIndexedCommit are refreshed; unchanged memory stays valid.
 */
export async function refreshMemory(deps: {
  repoRoot: string;
  memory: Memory;
  factory: AgentSessionFactory;
  model?: string;
  onProgress?: (message: string) => void;
}): Promise<RefreshResult> {
  const head = await getHeadCommit(deps.repoRoot);
  const lastIndexed = deps.memory.getLastIndexedCommit();

  if (!lastIndexed || lastIndexed === head) {
    return { lastIndexedCommit: lastIndexed, changedFiles: [], staleMarked: 0, entitiesRefreshed: 0, headCommit: head };
  }

  const changes = await getNameStatus(deps.repoRoot, lastIndexed, head);
  const changedFiles = [...new Set(changes.flatMap((change) => change.oldPath ? [change.oldPath, change.path] : [change.path]))];
  if (changedFiles.length === 0) {
    deps.memory.setLastIndexedCommit(head);
    return { lastIndexedCommit: lastIndexed, changedFiles, staleMarked: 0, entitiesRefreshed: 0, headCommit: head };
  }

  const headHashes = await hashFilesAtCommit(deps.repoRoot, head, changedFiles);
  const staleMarked = deps.memory.entities.markStaleWhereHashMismatch(head, headHashes, changedFiles);

  const existingPaths = changedFiles.filter((path) => headHashes.has(path));
  const affected = deps.memory.entities.byPaths(existingPaths);
  const ctx: ToolContext = {
    repoRoot: deps.repoRoot,
    headCommit: head,
    changeSet: {
      repoRoot: deps.repoRoot,
      base: lastIndexed,
      head,
      mergeBase: lastIndexed,
      files: [],
      patch: "",
      churn: 0,
    },
    codeMap: {
      kind: "degraded",
      structuralQueries: false,
      status: async () => ({ initialized: false, available: false, lastIndexed: null, nodeCount: 0, edgeCount: 0, fileCount: 0, pendingChanges: 0 }),
      ensureSynced: async () => ({ initialized: false, available: false, lastIndexed: null, nodeCount: 0, edgeCount: 0, fileCount: 0, pendingChanges: 0 }),
      searchSymbols: async () => [],
      callers: async () => [],
      callees: async () => [],
      dependents: async () => [],
      affectedTests: async () => ({ changedFiles: [], affectedTests: [] }),
      fileOverview: async () => [],
    },
    memory: deps.memory,
  };

  let refreshed = 0;
  if (affected.length > 0) {
    const collector: { summary?: ModuleSummary } = {};
    const session = await deps.factory.createSession({
      cwd: deps.repoRoot,
      systemRole: "module analyst",
      tools: [
        createReadCodeTool(ctx),
        createSearchTextTool(ctx),
        submitModuleSummaryTool(collector),
      ],
      builtinTools: [...READONLY_BUILTIN_TOOLS],
      model: deps.model,
    });
    try {
      await session.prompt(
        [
          "Re-summarize these changed files for repository memory. Focus on responsibilities and invariants of the symbols they define.",
          ...existingPaths.slice(0, 30).map((p) => `- ${p}`),
          "Call submit_module_summary exactly once.",
        ].join("\n"),
      );
    } finally {
      session.dispose();
    }
    if (collector.summary) {
      for (const sym of collector.summary.symbols) {
        if (!sym.path || !headHashes.has(sym.path)) continue;
        const existing = deps.memory.entities.byPaths([sym.path]).find((e) => e.qualifiedName === sym.name);
        // What this refresh re-asserts; untouched fields keep the previous
        // generated set so their replace rule stays stable.
        const nextResponsibilities = sym.responsibility ? [sym.responsibility] : (existing?.agentGenerated?.responsibilities ?? []);
        const nextInvariants = sym.invariants.length > 0 ? sym.invariants : (existing?.agentGenerated?.invariants ?? []);
        deps.memory.entities.upsert({
          symbolKey: existing?.symbolKey ?? sym.name,
          qualifiedName: sym.name,
          kind: sym.kind || existing?.kind || "unknown",
          path: sym.path,
          signature: existing?.signature ?? null,
          // Same replace-generated/keep-user rule as bootstrap: the refresh
          // re-asserts what it summarizes; anything else in the arrays was
          // user-added and survives.
          responsibilities: mergeGenerated(existing?.responsibilities, existing?.agentGenerated?.responsibilities, nextResponsibilities),
          invariants: mergeGenerated(existing?.invariants, existing?.agentGenerated?.invariants, nextInvariants),
          agentGenerated: {
            responsibilities: nextResponsibilities,
            invariants: nextInvariants,
            featureKeys: existing?.agentGenerated?.featureKeys ?? [],
          },
          notes: existing?.notes ?? [],
          featureKeys: mergeGenerated(existing?.featureKeys, existing?.agentGenerated?.featureKeys, existing?.agentGenerated?.featureKeys ?? []),
          source: existing?.source ?? "agent_summary",
          signatureHash: existing?.signatureHash ?? null,
          bodyHash: headHashes.get(sym.path) ?? existing?.bodyHash ?? null,
          lastSeenCommit: head,
          stale: false,
        });
        refreshed += 1;
      }
    }
  }

  deps.memory.setLastIndexedCommit(head);
  return { lastIndexedCommit: lastIndexed, changedFiles, staleMarked, entitiesRefreshed: refreshed, headCommit: head };
}
