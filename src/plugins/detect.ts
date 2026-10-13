import { listFilesAtCommit, readFileAtCommit } from "../changes/git.js";
import { renderGuidance } from "./loader.js";
import type { ActivePack, LanguagePack, LanguagePackRun, PluginSelection } from "./types.js";

/**
 * Glob marker semantics (validated in the loader): a leading double-star
 * slash prefix matches at any depth, root included; a star as a whole
 * segment matches one directory level.
 */
function markerRegExp(marker: string): RegExp {
  const depthAny = marker.startsWith("**/");
  const body = depthAny ? marker.slice(3) : marker;
  const pattern = body
    .split("/")
    .map((seg) => (seg === "*" ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${depthAny ? "(?:.*/)?" : ""}${pattern}$`);
}

/** True when any marker file exists at the pinned commit. */
async function packMatches(repoRoot: string, commit: string, pack: LanguagePack): Promise<boolean> {
  let tree: string[] | null = null;
  for (const marker of pack.markerFiles) {
    if (!marker.includes("*")) {
      if ((await readFileAtCommit(repoRoot, commit, marker)) !== null) return true;
      continue;
    }
    // One tree listing shared by every glob marker of this pack.
    tree ??= await listFilesAtCommit(repoRoot, commit);
    const re = markerRegExp(marker);
    if (tree.some((path) => re.test(path))) return true;
  }
  return false;
}

/**
 * Auto-activate packs whose marker files exist at the reviewed head commit —
 * the same pinned snapshot every other evidence tool reads, so working-tree
 * state can never influence activation.
 */
export async function detectPacks(repoRoot: string, headCommit: string, packs: LanguagePack[]): Promise<ActivePack[]> {
  const active: ActivePack[] = [];
  for (const pack of packs) {
    if (await packMatches(repoRoot, headCommit, pack)) {
      active.push({ name: pack.name, version: pack.version, activation: "auto" });
    }
  }
  return active;
}

/**
 * Resolve the run's packs: detect at head (auto), honor the manual list, or
 * disable. Unknown manual names are a hard error — silently reviewing without
 * guidance the user explicitly asked for would mislead. In audit mode only
 * packs with audit-aware guidance variants are rendered.
 */
export async function resolveLanguagePacks(deps: {
  repoRoot: string;
  headCommit: string;
  packs: LanguagePack[];
  selection: PluginSelection;
  mode?: "change" | "audit";
}): Promise<LanguagePackRun> {
  if (deps.selection.mode === "off") return { active: [], reviewerGuidance: "", verifierGuidance: "" };
  const byName = new Map(deps.packs.map((pack) => [pack.name, pack]));
  let entries: Array<{ pack: LanguagePack; activation: "auto" | "manual" }>;
  if (deps.selection.mode === "manual") {
    const missing = deps.selection.manual.filter((name) => !byName.has(name));
    if (missing.length > 0) {
      const available = deps.packs.map((pack) => pack.name).join(", ") || "none";
      throw new Error(`unknown language pack(s): ${missing.join(", ")} (available: ${available})`);
    }
    entries = deps.selection.manual.map((name) => ({ pack: byName.get(name)!, activation: "manual" as const }));
  } else {
    const detected = await detectPacks(deps.repoRoot, deps.headCommit, deps.packs);
    entries = detected.map((active) => ({ pack: byName.get(active.name)!, activation: "auto" as const }));
  }
  const mode = deps.mode ?? "change";
  return {
    active: entries.map(({ pack, activation }) => ({ name: pack.name, version: pack.version, activation })),
    reviewerGuidance: renderGuidance(entries, "reviewer", undefined, mode),
    verifierGuidance: renderGuidance(entries, "verifier", undefined, mode),
  };
}
