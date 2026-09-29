import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguagePack, PluginActivation } from "./types.js";

/** Hard ceiling on rendered guidance per role; keeps sessions lean (memory pack is the other big block). */
export const GUIDANCE_BUDGET_CHARS = 8000;

/** plugins/ ships next to dist/: dist/plugins/loader.js -> <package root>/plugins. */
export function pluginsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins");
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`language pack field ${field} must be a non-empty string`);
  }
  return value;
}

function expectStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`language pack field ${field} must be a non-empty array of strings`);
  }
  return value as string[];
}

/** Marker paths are repo-relative git paths: no traversal, no absolute form. */
function expectRepoRelative(paths: string[], field: string): string[] {
  for (const p of paths) {
    if (p.startsWith("/") || p.includes("\\") || p.split("/").includes("..") || p.includes("\0")) {
      throw new Error(`language pack field ${field} must be repo-relative paths, got: ${p}`);
    }
  }
  return paths;
}

/**
 * Load one pack directory (plugin.json + both guidance files). Built-in packs
 * ship with pir, so a malformed pack is a release bug, not user input: fail loud.
 */
export function loadLanguagePack(dir: string): LanguagePack {
  const manifestPath = path.join(dir, "plugin.json");
  if (!existsSync(manifestPath)) throw new Error(`missing plugin.json in ${dir}`);
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`invalid plugin.json in ${dir}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const detect = (manifest.detect ?? {}) as Record<string, unknown>;
  const guidance = (manifest.guidance ?? {}) as Record<string, unknown>;
  const name = expectString(manifest.name, "name");
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`language pack name must be kebab-case, got: ${name}`);
  const markerFiles = expectRepoRelative(expectStringArray(detect.markerFiles, "detect.markerFiles"), "detect.markerFiles");
  const rawExtensions = Array.isArray(detect.extensions) ? detect.extensions : [];
  const extensions = rawExtensions.map((ext) => expectString(ext, "detect.extensions").replace(/^\./, "").toLowerCase());
  const reviewerPath = path.resolve(dir, expectString(guidance.reviewer, "guidance.reviewer"));
  const verifierPath = path.resolve(dir, expectString(guidance.verifier, "guidance.verifier"));
  const reviewerGuidance = readFileSync(reviewerPath, "utf8").trim();
  const verifierGuidance = readFileSync(verifierPath, "utf8").trim();
  if (!reviewerGuidance) throw new Error(`empty reviewer guidance in ${dir}`);
  if (!verifierGuidance) throw new Error(`empty verifier guidance in ${dir}`);
  // Audit variants are optional: a pack shipping only change guidance must
  // stay loadable (its guidance is simply withheld from audit sessions).
  const readOptional = (key: string): string | undefined => {
    if (guidance[key] === undefined) return undefined;
    const file = readFileSync(path.resolve(dir, expectString(guidance[key], `guidance.${key}`)), "utf8").trim();
    return file.length > 0 ? file : undefined;
  };
  const reviewerAuditGuidance = readOptional("reviewerAudit");
  const verifierAuditGuidance = readOptional("verifierAudit");
  return {
    name,
    title: expectString(manifest.title, "title"),
    version: expectString(manifest.version, "version"),
    markerFiles,
    extensions,
    reviewerGuidance,
    verifierGuidance,
    ...(reviewerAuditGuidance ? { reviewerAuditGuidance } : {}),
    ...(verifierAuditGuidance ? { verifierAuditGuidance } : {}),
  };
}

/** All built-in packs, sorted by name for deterministic activation and output. */
export function loadBuiltInPacks(): LanguagePack[] {
  const dir = pluginsDir();
  if (!existsSync(dir)) throw new Error(`built-in plugins directory missing: ${dir}`);
  const packs: LanguagePack[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const packDir = path.join(dir, entry.name);
    if (!existsSync(path.join(packDir, "plugin.json"))) continue;
    packs.push(loadLanguagePack(packDir));
  }
  return packs;
}

/**
 * Render the prompt section for one role. Returns "" when nothing is active.
 * The header frames the content as trusted pir-shipped directions — the same
 * trust line as the rest of the prompt, deliberately unlike repository memory
 * (untrusted evidence).
 */
export function renderGuidance(
  entries: Array<{ pack: LanguagePack; activation: PluginActivation }>,
  role: "reviewer" | "verifier",
  budgetChars = GUIDANCE_BUDGET_CHARS,
  mode: "change" | "audit" = "change",
): string {
  const sections = entries
    .map((entry) => ({
      entry,
      // Audit sessions only receive packs with audit-aware variants: change
      // guidance assumes diff attribution and must not leak into audits.
      text: role === "reviewer"
        ? (mode === "audit" ? entry.pack.reviewerAuditGuidance : entry.pack.reviewerGuidance)
        : (mode === "audit" ? entry.pack.verifierAuditGuidance : entry.pack.verifierGuidance),
    }))
    .filter(({ text }) => (text ?? "").length > 0);
  if (sections.length === 0) return "";
  const body = sections
    .map(({ entry, text }) => `[${entry.pack.name}@${entry.pack.version}, ${entry.activation}]\n${text}`)
    .join("\n\n");
  const header =
    "=== LANGUAGE GUIDANCE (trusted review directions from pir built-in language packs; they sharpen where to look and never lower the evidence bar) ===";
  let out = `${header}\n${body}`;
  if (out.length > budgetChars) {
    out = `${out.slice(0, budgetChars)}\n[LANGUAGE GUIDANCE TRUNCATED at ${budgetChars} characters to fit the context budget]`;
  }
  return `${out}\n=== END LANGUAGE GUIDANCE ===`;
}
