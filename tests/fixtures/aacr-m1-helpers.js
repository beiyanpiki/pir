/**
 * Shared M1 test fixtures: tiny positive_samples records, a pin-verified
 * fixture document, a local bare mirror that accepts exact-SHA fetches, and a
 * fake `pir` CLI. None of these touch the network or a model.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTempGitRepo, git } from "./helpers.js";
import { buildFixtureDocument, sha256 } from "../eval/aacr/fixtures/build-fixture.js";

export async function temporary(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "pir-aacr-m1-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const comment = (over = {}) => ({
  is_ai_comment: true,
  note: "The counter can race.\n",
  path: "src/app.ts",
  side: "right",
  source_model: "Gemini-3-Pro",
  from_line: 2,
  to_line: 2,
  category: "Code Defect",
  context: "Diff Level",
  ...over,
});

export const positiveSample = (over = {}) => ({
  change_line_count: 12,
  project_main_language: "TypeScript",
  source_commit: "a".repeat(40),
  target_commit: "b".repeat(40),
  githubPrUrl: "https://github.com/example/repo/pull/7",
  category: "Bug Fix",
  comments: [comment()],
  ...over,
});

/** Temp meta.json + upstream body for the builder (pin computed from the body). */
export function makeMeta(records) {
  const bytes = Buffer.from(JSON.stringify(records));
  const meta = {
    dataset: { id: "Alibaba-Aone/aacr-bench" },
    citation: { arxiv: "2601.19494", bibtex: "@misc{test}", notice: "Cite arXiv 2601.19494." },
    fixtures: {
      repo: "https://github.com/alibaba/aacr-bench",
      commit: "e".repeat(40),
      file: "dataset/positive_samples.json",
      url: "https://raw.githubusercontent.com/alibaba/aacr-bench/" + "e".repeat(40) + "/dataset/positive_samples.json",
      sha256: sha256(bytes),
      bytes: bytes.length,
      records: records.length,
      comments: records.reduce((sum, record) => sum + record.comments.length, 0),
      commentSides: records.reduce((sides, record) => {
        for (const entry of record.comments) {
          if (!String(entry.note ?? "").trim() || !String(entry.path ?? "").trim()) continue;
          if (entry.side === "left" || entry.side === "right") sides[entry.side] += 1;
        }
        return sides;
      }, { left: 0, right: 0 }),
      instanceId: "owner__name@<target_commit[:7]>",
      baseCommit: "source_commit",
      headCommit: "target_commit",
      cloneUrl: "https://github.com/<owner>/<name>.git",
      license: "Apache-2.0",
    },
  };
  return { bytes, meta, doc: buildFixtureDocument(records, meta, bytes) };
}

/** Local git history exposed as a bare upload-pack that accepts exact-SHA fetches. */
export function buildLocalRepo(root) {
  const source = createTempGitRepo("pir-aacr-m1-src-");
  source.write("src/app.ts", "one\n");
  const base = source.commit("base");
  source.write("src/app.ts", "one\ntwo\n");
  const head = source.commit("head");
  const mirrorDir = path.join(root, "mirror.git");
  git(source.dir, ["clone", "-q", "--bare", source.dir, mirrorDir]);
  git(mirrorDir, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  source.cleanup();
  return { mirrorDir, base, head };
}

/**
 * Fake CLI: records its argv + checkout HEAD and emits the `find --json`
 * envelope. Options let tests exercise the incomplete path (exit 3 with a
 * valid envelope) and the malformed path (exit 3 with garbage stdout).
 */
export function writeFakeCli(dir, { exitCode = 0, incomplete = false, pendingCandidates = 0, stoppedBecause = null, garbage = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "fake-pir.js");
  writeFileSync(file, `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
const cwd = args[args.indexOf("--cwd") + 1];
let cwdHead = null;
try { cwdHead = cp.execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ args, cwdHead }) + "\\n");
${garbage ? "process.stdout.write(\"this is not the find envelope\\n\");" : `process.stdout.write(JSON.stringify({ data: {
  findings: [
    { displayId: "F-1", status: "confirmed", title: "Race", claim: "Counter race", trigger: "two writers", anchors: [{ path: "src/app.ts", startLine: 2, endLine: 2 }] },
    { displayId: "F-2", status: "uncertain", title: "Maybe", claim: "Possible issue", trigger: "", anchors: [{ path: "src/app.ts", startLine: 1 }] },
    { displayId: "F-3", status: "confirmed", title: "No anchor", claim: "Nowhere", trigger: "", anchors: [] }
  ],
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  durationMs: 1500,
  pendingCandidates: ${pendingCandidates},
  incomplete: ${incomplete},
  stoppedBecause: ${JSON.stringify(stoppedBecause)}
} }));`}
process.exitCode = ${exitCode};
`);
  return file;
}
