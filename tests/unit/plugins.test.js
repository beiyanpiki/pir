import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { createTempGitRepo } from "../fixtures/helpers.js";
import {
  GUIDANCE_BUDGET_CHARS,
  detectPacks,
  loadBuiltInPacks,
  pluginsDir,
  renderGuidance,
  resolveLanguagePacks,
} from "../../dist/plugins/index.js";
import { reviewerPrompt, verifierPrompt } from "../../dist/agents/prompts.js";
import { runReviewerRound } from "../../dist/agents/reviewer.js";

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
