import { readFileAtCommit } from "../changes/git.js";
import { renderGuidance } from "./loader.js";
import type { ActivePack, LanguagePack, LanguagePackRun, PluginSelection } from "./types.js";

/** True when any marker file exists at the pinned commit. */
async function packMatches(repoRoot: string, commit: string, pack: LanguagePack): Promise<boolean> {
  for (const marker of pack.markerFiles) {
    if ((await readFileAtCommit(repoRoot, commit, marker)) !== null) return true;
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
 * guidance the user explicitly asked for would mislead.
 */
export async function resolveLanguagePacks(deps: {
  repoRoot: string;
  headCommit: string;
  packs: LanguagePack[];
  selection: PluginSelection;
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
  return {
    active: entries.map(({ pack, activation }) => ({ name: pack.name, version: pack.version, activation })),
    reviewerGuidance: renderGuidance(entries, "reviewer"),
    verifierGuidance: renderGuidance(entries, "verifier"),
  };
}
