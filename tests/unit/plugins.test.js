import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTempGitRepo } from "../fixtures/helpers.js";
import {
  GUIDANCE_BUDGET_CHARS,
  detectPacks,
  loadBuiltInPacks,
  loadLanguagePack,
  pluginsDir,
  renderGuidance,
  resolveLanguagePacks,
} from "../../dist/plugins/index.js";
import { reviewerPrompt, verifierPrompt } from "../../dist/agents/prompts.js";
import { runReviewerRound } from "../../dist/agents/reviewer.js";

test("the docker image ships plugins/ and skills/ next to dist/", () => {
  // loadBuiltInPacks() throws when the directory is absent, which made every
  // server review fail on v0.3.0 images built without these COPY lines.
  const dockerfile = readFileSync(path.resolve("Dockerfile"), "utf8");
  assert.match(dockerfile, /^COPY plugins \/\S*\/plugins$/m, "Dockerfile must COPY plugins/ into the image");
  assert.match(dockerfile, /^COPY skills \/\S*\/skills$/m, "Dockerfile must COPY skills/ into the image");
  assert.doesNotMatch(
    readFileSync(path.resolve(".dockerignore"), "utf8"),
    /^\*\*\/\*\.md$/m,
    ".dockerignore must not exclude the packs' nested guidance markdown",
  );
});

test("built-in golang pack loads with a valid manifest and guidance within budget", () => {
  const packs = loadBuiltInPacks();
  assert.ok(pluginsDir().endsWith("plugins"));
  const golang = packs.find((pack) => pack.name === "golang");
  assert.ok(golang, `golang pack present among: ${packs.map((p) => p.name).join(", ")}`);
  assert.equal(golang.title, "Go");
  assert.match(golang.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(golang.markerFiles, ["go.mod"]);
  assert.deepEqual(golang.extensions, ["go"]);
  assert.match(golang.reviewerGuidance, /^# Go review directions/);
  assert.match(golang.reviewerGuidance, /## Concurrency/);
  assert.match(golang.reviewerGuidance, /## Backend boundaries/);
  assert.match(golang.verifierGuidance, /^# Go verification playbooks/);
  assert.match(golang.verifierGuidance, /Version gate/);
  for (const role of ["reviewer", "verifier"]) {
    const rendered = renderGuidance([{ pack: golang, activation: "auto" }], role);
    assert.ok(!rendered.includes("TRUNCATED"), `${role} guidance must not truncate (got ${rendered.length} chars)`);
    assert.ok(rendered.length <= GUIDANCE_BUDGET_CHARS, `${role} guidance within budget`);
  }
});

test("built-in typescript pack loads with a valid manifest and guidance within budget", () => {
  const packs = loadBuiltInPacks();
  const typescript = packs.find((pack) => pack.name === "typescript");
  assert.ok(typescript, `typescript pack present among: ${packs.map((p) => p.name).join(", ")}`);
  assert.equal(typescript.title, "TypeScript");
  assert.match(typescript.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(typescript.markerFiles, ["tsconfig.json"]);
  assert.deepEqual(typescript.extensions, ["ts", "tsx", "mts", "cts"]);
  assert.match(typescript.reviewerGuidance, /^# TypeScript review directions/);
  assert.match(typescript.reviewerGuidance, /## Async and the event loop/);
  assert.match(typescript.reviewerGuidance, /## Modules and ESM\/CJS/);
  assert.match(typescript.verifierGuidance, /^# TypeScript verification playbooks/);
  assert.match(typescript.verifierGuidance, /Config gate/);
  for (const role of ["reviewer", "verifier"]) {
    const rendered = renderGuidance([{ pack: typescript, activation: "auto" }], role);
    assert.ok(!rendered.includes("TRUNCATED"), `${role} guidance must not truncate (got ${rendered.length} chars)`);
    assert.ok(rendered.length <= GUIDANCE_BUDGET_CHARS, `${role} guidance within budget`);
  }
});

test("built-in frontend pack loads with a valid manifest and guidance within budget", () => {
  const packs = loadBuiltInPacks();
  const frontend = packs.find((pack) => pack.name === "frontend");
  assert.ok(frontend, `frontend pack present among: ${packs.map((p) => p.name).join(", ")}`);
  assert.equal(frontend.title, "Frontend");
  assert.match(frontend.version, /^\d+\.\d+\.\d+$/);
  // Framework configs and the vite SPA entry, matched at any repo depth.
  for (const marker of ["**/next.config.ts", "**/nuxt.config.ts", "**/svelte.config.js", "**/astro.config.mjs", "**/vite.config.ts", "**/index.html"]) {
    assert.ok(frontend.markerFiles.includes(marker), `marker ${marker} present`);
  }
  assert.ok(frontend.markerFiles.every((marker) => marker.startsWith("**/")), "frontend markers match at any repo depth");
  assert.ok(!frontend.markerFiles.includes("**/package.json"), "package.json is not a frontend marker");
  assert.deepEqual(frontend.extensions, ["vue", "svelte", "astro", "css", "scss"]);
  assert.match(frontend.reviewerGuidance, /^# Frontend review directions/);
  assert.match(frontend.reviewerGuidance, /## Hydration and the server\/client boundary/);
  assert.match(frontend.reviewerGuidance, /## XSS and client-side secrets/);
  assert.match(frontend.reviewerGuidance, /## Performance \(reachable hot paths only\)/);
  assert.match(frontend.verifierGuidance, /^# Frontend verification playbooks/);
  assert.match(frontend.verifierGuidance, /Config gate/);
  assert.match(frontend.reviewerAuditGuidance, /^# Frontend audit directions/);
  assert.match(frontend.verifierAuditGuidance, /^# Frontend audit verification playbooks/);
  assert.ok(!frontend.reviewerAuditGuidance.includes("this change"), "audit reviewer guidance must not leak change attribution");
  assert.ok(!frontend.verifierAuditGuidance.includes("this change"), "audit verifier guidance must not leak change attribution");
  for (const role of ["reviewer", "verifier"]) {
    const rendered = renderGuidance([{ pack: frontend, activation: "auto" }], role);
    assert.ok(!rendered.includes("TRUNCATED"), `${role} guidance must not truncate (got ${rendered.length} chars)`);
    assert.ok(rendered.length <= GUIDANCE_BUDGET_CHARS, `${role} guidance within budget`);
  }
});

test("frontend and typescript packs co-activate without truncating each other", () => {
  // Every framework web repo matches both marker sets; the shared single
  // pool used to cut whichever pack rendered first mid-section.
  const packs = loadBuiltInPacks();
  const frontend = packs.find((pack) => pack.name === "frontend");
  const typescript = packs.find((pack) => pack.name === "typescript");
  for (const role of ["reviewer", "verifier"]) {
    const rendered = renderGuidance([
      { pack: frontend, activation: "auto" },
      { pack: typescript, activation: "auto" },
    ], role);
    assert.ok(!rendered.includes("TRUNCATED"), `${role} co-render must not truncate (got ${rendered.length} chars)`);
    assert.ok(rendered.includes(`[frontend@${frontend.version}, auto]`), "frontend section present");
    assert.ok(rendered.includes(`[typescript@${typescript.version}, auto]`), "typescript section present");
    // Tail markers: the last content of each pack's guidance for this role.
    const tails = role === "reviewer"
      ? ["## Tests this diff touches", /No reachable path, no finding\./]
      : ["Accessibility: confirm the element lacks every accessible path", /prefer uncertain over confirmed when tooling-dependent/];
    assert.ok(rendered.includes(tails[0]) && tails[1].test(rendered), `${role} both packs' tails intact`);
  }
});

test("marker glob rules: leading '**/' depth prefix allowed, stray globs are release bugs", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "pir-pack-glob-"));
  const writePack = (markers) => {
    const dir = path.join(scratch, `pack-${markers.length}-${markers[0].replace(/[^a-z]+/g, "")}`);
    mkdirSync(path.join(dir, "guidance"), { recursive: true });
    writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
      name: "scratch-pack",
      title: "Scratch",
      version: "1.0.0",
      detect: { markerFiles: markers },
      guidance: { reviewer: "guidance/reviewer.md", verifier: "guidance/verifier.md" },
    }));
    writeFileSync(path.join(dir, "guidance", "reviewer.md"), "# Scratch review directions\n");
    writeFileSync(path.join(dir, "guidance", "verifier.md"), "# Scratch verification playbooks\n");
    return dir;
  };
  try {
    assert.doesNotThrow(() => loadLanguagePack(writePack(["go.mod", "**/vite.config.ts", "apps/*/vite.config.ts"])));
    assert.throws(() => loadLanguagePack(writePack(["**/a/**/b.ts"])), /leading '\*\*\/' depth prefix/);
    assert.throws(() => loadLanguagePack(writePack(["vite*.ts"])), /whole path segment/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("renderGuidance returns empty string without packs and truncates over budget", () => {
  assert.equal(renderGuidance([], "reviewer"), "");
  const verbose = {
    name: "verbose",
    title: "Verbose",
    version: "9.9.9",
    markerFiles: ["x.txt"],
    extensions: [],
    reviewerGuidance: "x".repeat(GUIDANCE_BUDGET_CHARS + 500),
    verifierGuidance: "y",
  };
  const rendered = renderGuidance([{ pack: verbose, activation: "manual" }], "reviewer", GUIDANCE_BUDGET_CHARS);
  assert.ok(rendered.startsWith("=== LANGUAGE GUIDANCE"));
  assert.ok(rendered.endsWith("=== END LANGUAGE GUIDANCE ==="));
  assert.match(rendered, /TRUNCATED at \d+ characters/);
  assert.ok(rendered.length <= GUIDANCE_BUDGET_CHARS + 300);
  assert.match(rendered, /\[verbose@9\.9\.9, manual\]/);
});

test("renderGuidance scales the default budget with the number of contributing packs", () => {
  // Two near-budget packs: a shared 8000-char pool would truncate the first
  // one's tail (the golang+typescript co-activation case on every monorepo).
  const mkPack = (name, char) => ({
    name,
    title: name,
    version: "1.0.0",
    markerFiles: [`${name}.txt`],
    extensions: [],
    reviewerGuidance: char.repeat(GUIDANCE_BUDGET_CHARS - 100),
    verifierGuidance: "y",
  });
  const entries = [
    { pack: mkPack("pack-a", "a"), activation: "manual" },
    { pack: mkPack("pack-b", "b"), activation: "manual" },
  ];
  const rendered = renderGuidance(entries, "reviewer");
  assert.ok(!rendered.includes("TRUNCATED"), `two packs must not truncate (got ${rendered.length} chars)`);
  assert.ok(rendered.includes("a".repeat(50)) && rendered.includes("b".repeat(50)), "both packs' bodies present in full");
  // An explicit budget still caps the output: callers can opt back into a hard pool.
  const capped = renderGuidance(entries, "reviewer", GUIDANCE_BUDGET_CHARS);
  assert.match(capped, /TRUNCATED at 8000 characters/);
  // Audit mode scales with packs that actually ship audit variants, not raw entries.
  const withAudit = entries.map(({ pack }) => ({ pack: { ...pack, reviewerAuditGuidance: pack.reviewerGuidance } , activation: "manual" }));
  const auditOnly = renderGuidance(withAudit, "reviewer", undefined, "audit");
  assert.ok(!auditOnly.includes("TRUNCATED"), `audit contributors must not truncate (got ${auditOnly.length} chars)`);
});

test("detectPacks activates by marker file at the pinned head commit, not the working tree", async () => {
  const packs = loadBuiltInPacks();
  const repo = createTempGitRepo("pir-plugins-detect-");
  try {
    const before = await detectPacks(repo.dir, repo.commit("empty history"), packs);
    assert.equal(before.some((p) => p.name === "golang"), false);

    repo.write("go.mod", "module example.com/foo\n\ngo 1.22\n");
    repo.write("main.go", "package main\n\nfunc main() {}\n");
    const head = repo.commit("add go module");
    rmSync(path.join(repo.dir, "go.mod"));
    const active = await detectPacks(repo.dir, head, packs);
    const golang = active.find((p) => p.name === "golang");
    assert.ok(golang, "go.mod at head activates golang even when the working tree lost it");
    assert.equal(golang.activation, "auto");
    assert.match(golang.version, /^\d+\.\d+\.\d+$/);
  } finally {
    repo.cleanup();
  }
});

test("detectPacks activates frontend by framework markers, not package.json alone", async () => {
  const packs = loadBuiltInPacks();
  const repo = createTempGitRepo("pir-plugins-frontend-detect-");
  try {
    repo.write("package.json", '{ "name": "web", "dependencies": { "next": "15.0.0" } }\n');
    const plainHead = repo.commit("node project without framework config");
    const before = await detectPacks(repo.dir, plainHead, packs);
    assert.equal(before.some((p) => p.name === "frontend"), false, "package.json alone does not activate frontend");

    repo.write("next.config.ts", "import type { NextConfig } from 'next';\nconst config: NextConfig = {};\nexport default config;\n");
    const head = repo.commit("add next config");
    const active = await detectPacks(repo.dir, head, packs);
    const frontend = active.find((p) => p.name === "frontend");
    assert.ok(frontend, "next.config.ts at head activates frontend");
    assert.equal(frontend.activation, "auto");
    assert.match(frontend.version, /^\d+\.\d+\.\d+$/);

    // Monorepo layout: the only frontend marker sits one directory down.
    const repo2 = createTempGitRepo("pir-plugins-frontend-sub-");
    try {
      repo2.write("package.json", '{ "name": "monorepo" }\n');
      repo2.write("web/vite.config.ts", "import { defineConfig } from 'vite';\nexport default defineConfig({});\n");
      const subHead = repo2.commit("frontend in a subdirectory");
      const subdirActive = await detectPacks(repo2.dir, subHead, packs);
      assert.ok(subdirActive.find((p) => p.name === "frontend"), "vite.config.ts one level down activates frontend");
    } finally {
      repo2.cleanup();
    }

    // Non-ASCII path components: ls-tree C-quotes these without -z (dogfood F-162).
    const repo3 = createTempGitRepo("pir-plugins-frontend-uni-");
    try {
      repo3.write("前端/vite.config.ts", "export default {};\n");
      const uniHead = repo3.commit("frontend under a non-ascii directory");
      const uniActive = await detectPacks(repo3.dir, uniHead, packs);
      assert.ok(uniActive.find((p) => p.name === "frontend"), "non-ASCII directory path activates frontend");

      // A broken listing degrades to "no activation", never a dead run (dogfood F-163).
      const ghost = await detectPacks(repo3.dir, "9".repeat(40), packs);
      assert.deepEqual(ghost, [], "unresolvable commit degrades to no packs");
    } finally {
      repo3.cleanup();
    }

    // Directory names with line terminators: the basename fast path slices at
    // the last slash, so terminators in parent components cannot break it
    // (dogfood F-168).
    const repo4 = createTempGitRepo("pir-plugins-frontend-nl-");
    try {
      repo4.write("we\nb/vite.config.ts", "export default {};\n");
      const nlHead = repo4.commit("frontend under a newline directory");
      const nlActive = await detectPacks(repo4.dir, nlHead, packs);
      assert.ok(nlActive.find((p) => p.name === "frontend"), "newline directory path activates frontend");
    } finally {
      repo4.cleanup();
    }
  } finally {
    repo.cleanup();
  }
});

test("composed glob markers match through the wildmatch fallback (dogfood F-169, F-171)", async () => {
  const mkPack = (name, markerFiles) => ({
    name,
    title: name,
    version: "1.0.0",
    markerFiles,
    extensions: [],
    reviewerGuidance: "# Composed review directions\n",
    verifierGuidance: "# Composed verification playbooks\n",
  });
  // Newline-parent fixture holds the ONLY marker path, so hitting it at all
  // requires the depth prefix's `.*` to cross the terminator (the s flag);
  // dropping the flag leaves nothing else to match (dogfood F-171).
  const repo = createTempGitRepo("pir-plugins-composed-glob-");
  try {
    repo.write("we\nb/apps/foo/vite.config.ts", "export default {};\n");
    const head = repo.commit("newline parent is the only layout");
    const deep = await detectPacks(repo.dir, head, [mkPack("composed-deep", ["**/apps/*/vite.config.ts"])]);
    assert.equal(deep.length, 1, "depth prefix crosses the newline directory (pins the s flag)");
    const rootOnly = await detectPacks(repo.dir, head, [mkPack("composed-root", ["apps/*/vite.config.ts"])]);
    assert.equal(rootOnly.length, 0, "a marker without the depth prefix stays root-anchored");
  } finally {
    repo.cleanup();
  }

  const repo2 = createTempGitRepo("pir-plugins-composed-seg-");
  try {
    repo2.write("apps/bar/vite.config.ts", "export default {};\n");
    repo2.write("apps/bar/other.config.ts", "export default {};\n");
    const head2 = repo2.commit("plain one-level layout");
    const segment = await detectPacks(repo2.dir, head2, [mkPack("composed-seg", ["apps/*/vite.config.ts"])]);
    assert.equal(segment.length, 1, "whole-segment star matches one directory level");
    const wrongName = await detectPacks(repo2.dir, head2, [mkPack("composed-wrong", ["apps/*/vite.config.mts"])]);
    assert.equal(wrongName.length, 0, "whole-segment star does not widen the filename");
  } finally {
    repo2.cleanup();
  }
});

test("detectPacks activates typescript by tsconfig.json at the pinned head commit", async () => {
  const packs = loadBuiltInPacks();
  const repo = createTempGitRepo("pir-plugins-detect-ts-");
  try {
    const before = await detectPacks(repo.dir, repo.commit("empty history"), packs);
    assert.equal(before.some((p) => p.name === "typescript"), false);

    repo.write("tsconfig.json", '{ "compilerOptions": { "strict": true } }\n');
    repo.write("src/index.ts", "export const x: number = 1;\n");
    const head = repo.commit("add typescript project");
    const active = await detectPacks(repo.dir, head, packs);
    const typescript = active.find((p) => p.name === "typescript");
    assert.ok(typescript, "tsconfig.json at head activates typescript");
    assert.equal(typescript.activation, "auto");
  } finally {
    repo.cleanup();
  }
});

test("resolveLanguagePacks honors manual selection and rejects unknown names", async () => {
  const packs = loadBuiltInPacks();
  const repo = createTempGitRepo("pir-plugins-resolve-");
  try {
    const head = repo.commit("no markers");
    await assert.rejects(
      resolveLanguagePacks({ repoRoot: repo.dir, headCommit: head, packs, selection: { mode: "manual", manual: ["nope"] } }),
      /unknown language pack\(s\): nope/,
    );

    const manual = await resolveLanguagePacks({
      repoRoot: repo.dir, headCommit: head, packs, selection: { mode: "manual", manual: ["golang"] },
    });
    assert.equal(manual.active.length, 1);
    assert.equal(manual.active[0].name, "golang");
    assert.equal(manual.active[0].activation, "manual");
    assert.match(manual.reviewerGuidance, /# Go review directions/);
    assert.match(manual.verifierGuidance, /# Go verification playbooks/);

    const off = await resolveLanguagePacks({ repoRoot: repo.dir, headCommit: head, packs, selection: { mode: "off", manual: [] } });
    assert.deepEqual(off, { active: [], reviewerGuidance: "", verifierGuidance: "" });

    const auto = await resolveLanguagePacks({ repoRoot: repo.dir, headCommit: head, packs, selection: { mode: "auto", manual: [] } });
    assert.deepEqual(auto.active, []);
    assert.equal(auto.reviewerGuidance, "");
  } finally {
    repo.cleanup();
  }
});

test("prompts embed the guidance section before repository memory and omit it when empty", () => {
  const base = {
    base: "base", head: "head", mergeBase: "old", round: 1, maxRounds: 2, maxFindings: 5, findingsRemaining: 5,
    focus: [], memoryPack: "MEMORY_PACK_TEXT", structuralQueries: false,
  };
  const section = "=== LANGUAGE GUIDANCE (trusted) ===\nGO_DIRECTIONS\n=== END LANGUAGE GUIDANCE ===";
  const withGuidance = reviewerPrompt({ ...base, languageGuidance: section });
  assert.match(withGuidance, /GO_DIRECTIONS/);
  assert.ok(withGuidance.indexOf("LANGUAGE GUIDANCE") < withGuidance.indexOf("=== REPOSITORY MEMORY ==="));
  assert.equal(reviewerPrompt(base).includes("LANGUAGE GUIDANCE"), false);

  const candidate = {
    title: "t", claim: "c", trigger: "tr", category: "correctness", severity: "P2",
    anchors: [{ path: "a.go", startLine: 1 }],
  };
  const verifierWith = verifierPrompt({ candidate, head: "head", priorDecisions: [], fixHistory: [], languageGuidance: "GO_PLAYBOOKS" });
  assert.match(verifierWith, /GO_PLAYBOOKS/);
  assert.ok(verifierWith.indexOf("GO_PLAYBOOKS") < verifierWith.indexOf("PRIOR DECISIONS"));
  assert.equal(verifierPrompt({ candidate, head: "head", priorDecisions: [], fixHistory: [] }).includes("GO_PLAYBOOKS"), false);
});

test("runReviewerRound forwards language guidance into the session prompt", async () => {
  const prompts = [];
  const factory = {
    async createSession() {
      return {
        async prompt(text) { prompts.push(text); },
        getLastAssistantText: () => "done",
        getLastAssistantError: () => undefined,
        getUsage: () => undefined,
        dispose: () => {},
      };
    },
  };
  const ctx = {
    repoRoot: "/unused", headCommit: "h",
    changeSet: { base: "b", head: "h", mergeBase: "m", files: [], patch: "" },
    codeMap: { structuralQueries: false }, memory: null,
  };
  // The round fails on the missing finish_round terminal call; the prompt has
  // already been delivered, which is all this test asserts.
  await assert.rejects(
    runReviewerRound({
      factory, ctx, memoryPack: "mem", round: 1, maxRounds: 1, maxFindings: 1, findingsRemaining: 1,
      focus: [], languageGuidance: "GO_DIRECTIONS_INLINE",
    }),
    /finish_round/,
  );
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /GO_DIRECTIONS_INLINE/);
});

test("audit-aware guidance renders in audit mode and is withheld without variants", async () => {
  const { loadBuiltInPacks, renderGuidance } = await import("../../dist/plugins/loader.js");
  const packs = loadBuiltInPacks();
  const go = packs.find((pack) => pack.name === "golang");
  assert.ok(go, "golang pack present");
  assert.ok(go.reviewerAuditGuidance && go.verifierAuditGuidance, "golang ships audit variants");

  const entries = [{ pack: go, activation: "manual" }];
  const auditReviewer = renderGuidance(entries, "reviewer", undefined, "audit");
  const changeReviewer = renderGuidance(entries, "reviewer", undefined, "change");
  assert.match(auditReviewer, /current-state audit/i);
  assert.doesNotMatch(auditReviewer, /this change touched/i);
  assert.match(changeReviewer, /this change touched/i);

  // A pack without audit variants must render nothing in audit mode.
  const changeOnly = { ...go, reviewerAuditGuidance: undefined };
  assert.equal(renderGuidance([{ pack: changeOnly, activation: "manual" }], "reviewer", undefined, "audit"), "");
});
