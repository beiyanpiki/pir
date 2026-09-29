import { test } from "node:test";
import assert from "node:assert/strict";
import { renameSync, rmSync } from "node:fs";
import path from "node:path";
import { buildChangeSet } from "../../dist/changes/change-set.js";
import { readReviewFile, resolveReviewRevision, safeResolve } from "../../dist/tools/context.js";
import {
  createReadCodeTool, createSearchTextTool, createGetChangeTool,
  createFindSymbolTool, createFindCallersTool, createFindCalleesTool, createFindReferencesTool,
} from "../../dist/tools/review-tools.js";
import { createTempGitRepo, git } from "../fixtures/helpers.js";

const codeMap = {
  kind: "degraded", structuralQueries: false,
  searchSymbols: async () => [], callers: async () => [],
  callees: async () => [], dependents: async () => [],
};

async function context(repo, base = "HEAD^", head = "HEAD") {
  return { repoRoot: repo.dir, headCommit: head, changeSet: await buildChangeSet(repo.dir, base, head), codeMap, memory: null };
}

function continuation(text) {
  const match = /(?:^|; |\n)continuation: (.+)/.exec(text);
  assert.ok(match, `missing continuation: ${text}`);
  return JSON.parse(match[1]);
}

function matches(text) {
  return text.split("\n").filter((line) => /^.+:\d+: /.test(line));
}

function body(text) {
  return text.split("\n").filter((line) => /^\s*\d+\| /.test(line)).map((line) => line.replace(/^\s*\d+\| /, ""));
}

test("read_code ignores dirty/index/untracked data and branch movement after change-set construction", async () => {
  const repo = createTempGitRepo();
  try {
    repo.write("source.ts", "base evidence\n");
    const base = repo.commit("base");
    git(repo.dir, ["switch", "-q", "-c", "review-branch"]);
    repo.write("source.ts", "reviewed evidence\n");
    const head = repo.commit("review");
    const ctx = await context(repo, base, "review-branch");
    assert.equal(ctx.changeSet.head, "review-branch");
    assert.equal(ctx.changeSet.baseCommit, base);
    assert.equal(ctx.changeSet.headCommit, head);
    repo.write("source.ts", "later branch evidence\n");
    repo.commit("branch advanced");
    git(repo.dir, ["switch", "-q", "main"]);
    repo.write("source.ts", "staged evidence\n");
    git(repo.dir, ["add", "source.ts"]);
    repo.write("source.ts", "dirty evidence\n");
    repo.write("untracked.ts", "untracked evidence\n");
    const read = createReadCodeTool(ctx);
    const result = await read.execute({ path: "source.ts" });
    assert.match(result.text, new RegExp(`revision=head commit=${head}`));
    assert.deepEqual(body(result.text), ["reviewed evidence"]);
    assert.match((await read.execute({ path: "untracked.ts" })).text, /file not found/);
    assert.equal(await resolveReviewRevision(ctx), head);
    assert.deepEqual(await readReviewFile(ctx, "./source.ts"), { path: "source.ts", revision: "head", commit: head, content: "reviewed evidence\n" });
    const search = createSearchTextTool(ctx);
    const searchResult = await search.execute({ pattern: "evidence" });
    assert.deepEqual(matches(searchResult.text), ["source.ts:1: reviewed evidence"]);
    assert.match(searchResult.text, new RegExp(`commit=${head}`));
  } finally { repo.cleanup(); }
});

test("base selects the actual requested base while merge-base selects the old side of a divergent diff", async () => {
  const repo = createTempGitRepo();
  try {
    repo.write("shared.ts", "common evidence\n");
    const ancestor = repo.commit("common");
    git(repo.dir, ["switch", "-q", "-c", "feature"]);
    repo.write("shared.ts", "feature evidence\n");
    const head = repo.commit("feature");
    git(repo.dir, ["switch", "-q", "main"]);
    repo.write("shared.ts", "requested base evidence\n");
    repo.write("base-only.ts", "base-only evidence\n");
    const base = repo.commit("base advances independently");
    const ctx = await context(repo, "main", "feature");
    assert.equal(ctx.changeSet.mergeBase, ancestor);
    assert.equal(ctx.changeSet.baseCommit, base);
    assert.equal(ctx.changeSet.headCommit, head);
    assert.deepEqual(ctx.changeSet.files.map((f) => f.path), ["shared.ts"]);
    const read = createReadCodeTool(ctx);
    const search = createSearchTextTool(ctx);
    for (const [revision, commit, text] of [["head", head, "feature evidence"], ["base", base, "requested base evidence"], ["merge-base", ancestor, "common evidence"]]) {
      const result = await read.execute({ path: "shared.ts", revision });
      assert.deepEqual(body(result.text), [text]);
      assert.match(result.text, new RegExp(`revision=${revision} commit=${commit}`));
      const found = await search.execute({ pattern: text, revision });
      assert.deepEqual(matches(found.text), [`shared.ts:1: ${text}`]);
      assert.match(found.text, new RegExp(`revision=${revision} commit=${commit}`));
    }
    git(repo.dir, ["update-ref", "refs/heads/main", ancestor]);
    assert.equal((await readReviewFile(ctx, "shared.ts", "base")).content, "requested base evidence\n");
    const change = (await createGetChangeTool(ctx).execute({})).text;
    assert.match(change, new RegExp(`merge-base ${ancestor} -> head ${head}`));
    assert.match(change, new RegExp(`requested base: ${base}`));
    assert.match(change, /-common evidence/);
    assert.match(change, /\+feature evidence/);
    assert.doesNotMatch(change, /base-only\.ts/);
  } finally { repo.cleanup(); }
});

test("deleted and renamed paths are read explicitly without filesystem or rename fallback", async () => {
  const repo = createTempGitRepo();
  try {
    repo.write("old.ts", "rename evidence\n");
    repo.write("removed.ts", "deletion evidence\n");
    repo.commit("before");
    renameSync(path.join(repo.dir, "old.ts"), path.join(repo.dir, "new.ts"));
    rmSync(path.join(repo.dir, "removed.ts"));
    repo.commit("rename and delete");
    const ctx = await context(repo);
    repo.write("old.ts", "dirty old path\n");
    repo.write("removed.ts", "dirty recreated deletion\n");
    const read = createReadCodeTool(ctx);
    for (const file of ["old.ts", "removed.ts"]) {
      assert.match((await read.execute({ path: file })).text, /file not found/);
      assert.doesNotMatch((await read.execute({ path: file, revision: "merge-base" })).text, /ERROR|dirty/);
    }
    assert.match((await read.execute({ path: "new.ts", revision: "base" })).text, /file not found/);
    assert.deepEqual(body((await read.execute({ path: "new.ts" })).text), ["rename evidence"]);
    const change = createGetChangeTool(ctx);
    assert.match((await change.execute({ path: "old.ts" })).text, /renamed from "old\.ts"/);
    assert.match((await change.execute({ path: "removed.ts", hunkIndex: 0 })).text, /-deletion evidence/);
    const search = createSearchTextTool(ctx);
    assert.deepEqual(matches((await search.execute({ pattern: "deletion", revision: "head" })).text), []);
    assert.deepEqual(matches((await search.execute({ pattern: "deletion", revision: "merge-base" })).text), ["removed.ts:1: deletion evidence"]);
    assert.deepEqual(matches((await search.execute({ pattern: "rename", revision: "head" })).text), ["new.ts:1: rename evidence"]);
  } finally { repo.cleanup(); }
});

test("legacy bootstrap contexts retain pinned HEAD reads, including directories and empty files", async () => {
  const repo = createTempGitRepo();
  try {
    repo.write("src/a.ts", "bootstrap evidence\n");
    repo.write("empty.ts", "");
    const head = repo.commit("bootstrap");
    const ctx = { repoRoot: repo.dir, headCommit: head, changeSet: { repoRoot: repo.dir, base: head, head, mergeBase: head, files: [], patch: "", churn: 0 }, codeMap, memory: null };
    repo.write("src/a.ts", "dirty bootstrap data\n");
    const read = createReadCodeTool(ctx);
    assert.deepEqual(body((await read.execute({ path: "src/a.ts" })).text), ["bootstrap evidence"]);
    assert.match((await read.execute({ path: "src" })).text, /file not found/);
    assert.match((await read.execute({ path: "empty.ts" })).text, /totalLines: 0/);
    assert.deepEqual(matches((await createSearchTextTool(ctx).execute({ pattern: "evidence" })).text), ["src/a.ts:1: bootstrap evidence"]);
  } finally { repo.cleanup(); }
});

test("read_code pages complete long files and oversized single lines within global bounds", async () => {
  const repo = createTempGitRepo();
  try {
    const lines = Array.from({ length: 550 }, (_, i) => `source line ${i + 1}`);
    const huge = "h".repeat(40_000) + "END";
    repo.write("large.ts", lines.join("\n") + "\n");
    repo.write("huge.ts", huge);
    repo.commit("large files");
    const read = createReadCodeTool(await context(repo));
    const all = [];
    let params = { path: "large.ts" };
    let count = 0;
    do {
      const result = await read.execute(params);
      assert.ok(result.text.length <= 24_000);
      all.push(...body(result.text));
      assert.ok(++count < 10);
      params = continuation(result.text);
    } while (params);
    assert.deepEqual(all, lines);
    assert.equal(count, 3);
    let recovered = "";
    params = { path: "huge.ts" };
    count = 0;
    do {
      const result = await read.execute(params);
      assert.ok(result.text.length <= 24_000);
      recovered += body(result.text).join("");
      params = continuation(result.text);
      assert.ok(++count < 10);
    } while (params);
    assert.equal(recovered, huge);
    const window = await read.execute({ path: "large.ts", startLine: 42, endLine: 44 });
    assert.deepEqual(body(window.text), lines.slice(41, 44));
    assert.equal(continuation(window.text), null);
  } finally { repo.cleanup(); }
});

test("get_change recovers BOTH sides of long hunks and emits concise default navigation", async () => {
  const repo = createTempGitRepo();
  try {
    const old = Array.from({ length: 360 }, (_, i) => `removed_${i + 1}`);
    const added = Array.from({ length: 370 }, (_, i) => `added_${i + 1}`);
    repo.write("long.ts", old.join("\n") + "\n");
    repo.commit("old");
    repo.write("long.ts", added.join("\n") + "\n");
    repo.commit("new");
    const ctx = await context(repo);
    const change = createGetChangeTool(ctx);
    const overview = (await change.execute({})).text;
    assert.ok(overview.length < 2000);
    assert.match(overview, /Hunk bodies omitted/);
    assert.doesNotMatch(overview, /removed_360/);
    assert.match((await change.execute({ path: "long.ts" })).text, /hunkIndex: 0/);
    const recovered = [];
    let params = { path: "long.ts", hunkIndex: 0, offset: 0, limit: 83 };
    let count = 0;
    do {
      const result = await change.execute(params);
      assert.ok(result.text.length <= 24_000);
      recovered.push(...result.text.split("\n").filter((line) => /^[+-](removed_|added_)/.test(line)));
      params = continuation(result.text);
      assert.ok(++count < 20);
    } while (params);
    assert.deepEqual(recovered, [...old.map((s) => `-${s}`), ...added.map((s) => `+${s}`)]);
    assert.ok(recovered.includes("-removed_360"));
    assert.ok(recovered.includes("+added_370"));
  } finally { repo.cleanup(); }
});

test("get_change pages files and hunk indexes and fully recovers oversized diff lines", async () => {
  const repo = createTempGitRepo();
  try {
    const initial = Array.from({ length: 30 }, (_, i) => `stable ${i}`);
    const hugeOld = "-" + "o".repeat(40_000);
    const hugeNew = "+" + "n".repeat(41_000);
    repo.write("multi.ts", initial.join("\n") + "\n");
    repo.write("huge.ts", hugeOld.slice(1) + "\n");
    repo.commit("before");
    const modified = [...initial];
    modified[1] = "changed first";
    modified[25] = "changed last";
    repo.write("multi.ts", modified.join("\n") + "\n");
    repo.write("huge.ts", hugeNew.slice(1) + "\n");
    for (let i = 0; i < 70; i++) repo.write(`files/f${String(i).padStart(2, "0")}.ts`, `new ${i}\n`);
    repo.commit("after");
    const ctx = await context(repo);
    const change = createGetChangeTool(ctx);
    const paths = [];
    let params = { limit: 7 };
    let count = 0;
    do {
      const result = await change.execute(params);
      assert.ok(result.text.length <= 24_000);
      paths.push(...result.text.split("\n").filter((line) => line.startsWith("## ")));
      params = continuation(result.text);
      assert.ok(++count < 20);
    } while (params);
    assert.equal(paths.length, ctx.changeSet.files.length);
    assert.equal(new Set(paths).size, paths.length);
    const first = await change.execute({ path: "multi.ts", limit: 1 });
    assert.match(first.text, /hunkIndex: 0/);
    const second = await change.execute(continuation(first.text));
    assert.match(second.text, /hunkIndex: 1/);
    assert.equal(continuation(second.text), null);
    const chunks = [];
    params = { path: "huge.ts", hunkIndex: 0, limit: 1 };
    count = 0;
    do {
      const result = await change.execute(params);
      assert.ok(result.text.length <= 24_000);
      const lines = result.text.split("\n");
      const firstBodyLine = lines.findIndex((line) => line.startsWith("raw diff lines:")) + 1;
      const endBody = lines.findIndex((line) => line.startsWith("truncated:"));
      chunks.push(lines.slice(firstBodyLine, endBody).join(""));
      params = continuation(result.text);
      assert.ok(++count < 20);
    } while (params);
    assert.equal(chunks.join(""), hugeOld + hugeNew);
  } finally { repo.cleanup(); }
});

test("search_text honors literal, ERE, glob, matching-line counts and bounded continuation", async () => {
  const repo = createTempGitRepo();
  try {
    repo.write("top.ts", "token token\nneedle.value\nneedleXvalue\n--flag\n");
    repo.write("src/a.ts", "token\n");
    repo.write("src/deep/b.ts", "token\n");
    repo.write("src/a.js", "token\n");
    repo.write("notes.txt", "token\n");
    repo.write("colon:name.ts", "colon-only\n");
    repo.write("line\nname.ts", "newline-only\n");
    repo.write("binary.ts", "token\0binary");
    repo.commit("search fixtures");
    for (const setting of ["grep.column", "grep.heading", "grep.break"]) git(repo.dir, ["config", setting, "true"]);
    const search = createSearchTextTool(await context(repo));
    const literal = await search.execute({ pattern: "needle.value", glob: "*.ts" });
    assert.deepEqual(matches(literal.text), ["top.ts:2: needle.value"]);
    const regex = await search.execute({ pattern: "needle.value", isRegex: true, glob: "*.ts" });
    assert.deepEqual(matches(regex.text), ["top.ts:2: needle.value", "top.ts:3: needleXvalue"]);
    assert.deepEqual(matches((await search.execute({ pattern: "--flag" })).text), ["top.ts:4: --flag"]);
    for (const [glob, expected] of [
      ["*.ts", ["src/a.ts:1: token", "src/deep/b.ts:1: token", "top.ts:1: token token"]],
      ["src/*.ts", ["src/a.ts:1: token"]],
      ["src/**/*.ts", ["src/a.ts:1: token", "src/deep/b.ts:1: token"]],
      ["src/[a-z].?s", ["src/a.js:1: token", "src/a.ts:1: token"]],
      ["!*.ts", ["notes.txt:1: token", "src/a.js:1: token"]],
    ]) {
      assert.deepEqual(matches((await search.execute({ pattern: "token", glob })).text), expected, glob);
    }
    const all = [];
    let params = { pattern: "token", glob: "*.ts", limit: 1 };
    let count = 0;
    do {
      const result = await search.execute(params);
      assert.ok(result.text.length <= 24_000);
      assert.match(result.text, /returned: 1/);
      all.push(...matches(result.text));
      params = continuation(result.text);
      if (params) assert.match(result.text, /matchingLines: >=\d+;.*truncated: true/);
      else assert.match(result.text, /matchingLines: 3;.*truncated: false/);
      assert.ok(++count < 10);
    } while (params);
    assert.equal(all.length, 3);
    assert.equal(new Set(all).size, 3);
    assert.match((await search.execute({ pattern: "no such match" })).text, /matchingLines: 0; returned: 0/);
    assert.deepEqual(matches((await search.execute({ pattern: "colon-only" })).text), ["colon:name.ts:1: colon-only"]);
    assert.match((await search.execute({ pattern: "newline-only" })).text, /"line\\nname\.ts":1: newline-only/);
  } finally { repo.cleanup(); }
});

test("search_text caps counts globally, handles huge lines, and exposes recoverable next offsets", async () => {
  const repo = createTempGitRepo();
  try {
    repo.write("many.ts", Array.from({ length: 125 }, (_, i) => `token ${i}`).join("\n") + "\n");
    repo.write("wide.ts", "x".repeat(200_000) + "tailneedle\n");
    for (let i = 0; i < 100; i++) repo.write(`${"p".repeat(200)}/${"q".repeat(200)}/${i}.ts`, "pathneedle " + "s".repeat(230) + "\n");
    repo.commit("large search");
    const search = createSearchTextTool(await context(repo));
    const first = await search.execute({ pattern: "token", limit: 500 });
    assert.equal(matches(first.text).length, 50);
    assert.match(first.text, /matchingLines: >=51/);
    const second = await search.execute(continuation(first.text));
    assert.equal(matches(second.text).length, 50);
    const third = await search.execute(continuation(second.text));
    assert.equal(matches(third.text).length, 25);
    assert.match(third.text, /matchingLines: 125/);
    assert.equal(continuation(third.text), null);
    const huge = await search.execute({ pattern: "tailneedle" });
    assert.equal(matches(huge.text).length, 1);
    assert.ok(huge.text.length < 2000);
    assert.match(huge.text, /Line previews are capped/);
    const wideMatches = [];
    let params = { pattern: "pathneedle" };
    let pages = 0;
    do {
      const wide = await search.execute(params);
      assert.ok(wide.text.length <= 24_000);
      wideMatches.push(...matches(wide.text));
      params = continuation(wide.text);
      assert.ok(++pages < 10);
    } while (params);
    assert.equal(wideMatches.length, 100);
    assert.equal(new Set(wideMatches).size, 100);
    assert.ok(pages > 2);
  } finally { repo.cleanup(); }
});

test("tool validation rejects invalid numeric, revision, regex and path parameters", async () => {
  const repo = createTempGitRepo();
  try {
    repo.write("src/a.ts", "ok\n");
    repo.commit("fixture");
    const ctx = await context(repo);
    const read = createReadCodeTool(ctx), search = createSearchTextTool(ctx), change = createGetChangeTool(ctx);
    for (const invalidPath of ["", ".", "..", "../a.ts", "src/..", "src/../src/a.ts", "/etc/passwd", "C:\\secret", "C:secret", "src\\..\\a.ts", "src/a\0.ts"]) {
      assert.equal(safeResolve(repo.dir, invalidPath), null, invalidPath);
      assert.match((await read.execute({ path: invalidPath })).text, /ERROR/, invalidPath);
      assert.match((await change.execute({ path: invalidPath })).text, /ERROR/, invalidPath);
      assert.match((await search.execute({ pattern: "ok", glob: invalidPath })).text, /ERROR/, invalidPath);
      await assert.rejects(readReviewFile(ctx, invalidPath), /invalid/);
    }
    assert.equal(safeResolve(repo.dir, "./src//a.ts"), path.join(repo.dir, "src/a.ts"));
    assert.equal(safeResolve(repo.dir, "..valid.ts"), path.join(repo.dir, "..valid.ts"));
    for (const params of [
      {}, { path: 5 }, { path: "src/a.ts", revision: "HEAD" },
      { path: "src/a.ts", startLine: 0 }, { path: "src/a.ts", startLine: 1.1 },
      { path: "src/a.ts", startLine: "1" }, { path: "src/a.ts", endLine: NaN },
      { path: "src/a.ts", startLine: 2, endLine: 1 }, { path: "src/a.ts", startLine: 10 },
      { path: "src/a.ts", charOffset: 100 }, { path: "src/a.ts", charOffset: -1 },
    ]) assert.match((await read.execute(params)).text, /ERROR/, JSON.stringify(params));
    for (const params of [
      {}, { pattern: "" }, { pattern: "a\nb" }, { pattern: "a\0b" },
      { pattern: "[", isRegex: true }, { pattern: "a", isRegex: "true" },
      { pattern: "a", revision: "HEAD" }, { pattern: "a", limit: 0 },
      { pattern: "a", limit: Infinity }, { pattern: "a", offset: -1 },
      { pattern: "a", offset: 0.5 }, { pattern: "a", glob: 42 },
    ]) assert.match((await search.execute(params)).text, /ERROR/, JSON.stringify(params));
    for (const params of [
      { hunkIndex: 0 }, { charOffset: 0 }, { limit: 0 }, { offset: -1 },
      { limit: 0.5 }, { path: "src/a.ts", hunkIndex: 999 },
      { path: "src/a.ts", hunkIndex: 0, offset: 999 }, { path: "src/a.ts", offset: 999 },
      { path: "src/a.ts", hunkIndex: 0, charOffset: 999 },
    ]) assert.match((await change.execute(params)).text, /ERROR/, JSON.stringify(params));
    await assert.rejects(resolveReviewRevision(ctx, "HEAD"), /revision/);
  } finally { repo.cleanup(); }
});

test("all structural results clearly label unpinned navigation-only provenance", async () => {
  const repo = createTempGitRepo();
  try {
    repo.write("a.ts", "old snapshot\n");
    repo.commit("fixture");
    const ctx = await context(repo);
    const symbol = { qualifiedName: "dirtySymbol", kind: "function", filePath: "dirty-only.ts", startLine: 99 };
    ctx.codeMap = { ...codeMap, kind: "structural", searchSymbols: async () => [symbol], callers: async () => [symbol], callees: async () => [symbol], dependents: async () => [symbol] };
    for (const tool of [createFindSymbolTool(ctx), createFindCallersTool(ctx), createFindCalleesTool(ctx), createFindReferencesTool(ctx)]) {
      const result = await tool.execute({ query: "dirty", symbol: "dirtySymbol" });
      assert.match(result.text, /provenance: unpinned/);
      assert.match(result.text, /navigation only, not evidence of the reviewed snapshot/);
      assert.match(result.text, /read_code/);
      assert.match(result.text, /dirtySymbol/);
    }
    ctx.codeMap = codeMap;
    assert.match((await createFindSymbolTool(ctx).execute({ query: "missing" })).text, /unpinned.*\nNo results/);
  } finally { repo.cleanup(); }
});
