import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodeMap } from "../../dist/codemap/provider.js";
import { CodeGraphCliAdapter } from "../../dist/codemap/codegraph-cli.js";

// Option specs mirroring `codegraph --help` for 1.6.0, the version the image
// installs (Dockerfile pins @colbymchenry/codegraph@1.6.0). The fake CLI below
// rejects any option a real commander-built CLI would reject, so a flag the
// adapter is not allowed to use fails here exactly like in production
// (`error: unknown option '-p'`, exit 1) instead of being silently accepted.
//
// value: options that consume the next argument; bool: flag-only options;
// positional: max positional args (-1 = variadic).
const CLI_SPEC = {
  init: { value: [], bool: ["--force", "--incremental", "--language", "--exclude", "--no-gitignore"], positional: 1 },
  uninit: { value: [], bool: ["--yes"], positional: 1 },
  sync: { value: [], bool: ["-q", "--quiet"], positional: 1 },
  status: { value: [], bool: ["-j", "--json"], positional: 1 },
  query: { value: ["-p", "--path", "-l", "--limit", "-k", "--kind"], bool: ["-j", "--json"], positional: 1 },
  callers: { value: ["-p", "--path", "-l", "--limit"], bool: ["-j", "--json"], positional: 1 },
  callees: { value: ["-p", "--path", "-l", "--limit"], bool: ["-j", "--json"], positional: 1 },
  impact: { value: ["-p", "--path", "-d", "--depth"], bool: ["-j", "--json"], positional: 1 },
  affected: { value: ["-p", "--path", "-d", "--depth", "-f", "--filter"], bool: ["--stdin", "-j", "--json", "-q", "--quiet"], positional: -1 },
  files: { value: ["-p", "--path", "--filter", "--pattern", "--format", "--max-depth"], bool: ["-j", "--json", "--no-metadata"], positional: 0 },
};

// handler per subcommand: { json: value } prints JSON, { stdout: text } prints
// raw text, { exit: n, stderr: text } fails like the real CLI would.
function makeFakeCodegraph(handlers) {
  const binDir = mkdtempSync(path.join(tmpdir(), "pir-fakebin-"));
  const script = path.join(binDir, "codegraph");
  const body = `#!/usr/bin/env node
const spec = ${JSON.stringify(CLI_SPEC)};
const handlers = ${JSON.stringify(handlers)};
const [sub, ...rest] = process.argv.slice(2);
const handler = handlers[sub];
if (!handler) { process.stderr.write("unknown command '" + sub + "'\\n"); process.exit(1); }
const s = spec[sub] || { value: [], bool: [], positional: 0 };
const positionals = [];
let readStdin = false;
for (let i = 0; i < rest.length; i++) {
  const tok = rest[i];
  if (tok === "--") { positionals.push(...rest.slice(i + 1)); break; }
  if (tok.startsWith("-") && tok !== "-") {
    if (s.bool.includes(tok)) { if (tok === "--stdin") readStdin = true; continue; }
    if (s.value.includes(tok)) { i++; continue; }
    process.stderr.write("error: unknown option '" + tok + "'\\n");
    process.exit(1);
  }
  positionals.push(tok);
}
if (readStdin) { try { require("node:fs").readFileSync(0, "utf8"); } catch {} }
if (handler.exit !== undefined) {
  if (handler.stderr) process.stderr.write(handler.stderr);
  process.exit(handler.exit);
}
if (handler.stdout !== undefined) { process.stdout.write(handler.stdout); process.exit(0); }
if (handler.json !== undefined) { console.log(JSON.stringify(handler.json)); process.exit(0); }
`;
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  return { binDir, script };
}

async function withPath(binDir, fn) {
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = oldPath;
  }
}

test("CodeGraphCliAdapter maps query/callers/impact/affected/files payloads", async () => {
  const { binDir } = makeFakeCodegraph({
    status: { json: { initialized: true, version: "1.6.0", fileCount: 10, nodeCount: 100, edgeCount: 200, lastIndexed: "2026-01-01", pendingChanges: 2 } },
    query: {
      json: [
        { node: { kind: "function", name: "retry", qualifiedName: "PaymentService.retry", filePath: "src/pay.ts", startLine: 10, endLine: 40, signature: "retry()" }, score: 0.9 },
      ],
    },
    callers: { json: { symbol: "PaymentService.retry", callers: [{ name: "PaymentController.post", kind: "method", filePath: "src/api.ts", startLine: 5 }] } },
    callees: { json: { symbol: "PaymentService.retry", callees: [{ name: "PaymentGateway.charge", kind: "method", filePath: "src/gw.ts", startLine: 9 }] } },
    impact: { json: { symbol: "PaymentService.retry", depth: 2, nodeCount: 3, edgeCount: 4, affected: [{ name: "Reconciliation.run", kind: "function", filePath: "src/recon.ts", startLine: 1 }] } },
    affected: { json: { changedFiles: ["src/pay.ts"], affectedTests: ["test/pay.test.ts"], totalDependentsTraversed: 5 } },
    files: { json: [{ path: "src/pay.ts", language: "typescript", nodeCount: 12, size: 400 }] },
    // Real quiet sync prints nothing; ensureSynced must judge by exit code only.
    sync: { stdout: "" },
  });
  await withPath(binDir, async () => {
    const adapter = new CodeGraphCliAdapter("/tmp/repo");
    const status = await adapter.status();
    assert.equal(status.initialized, true);
    assert.equal(status.pendingChanges, 2);

    const symbols = await adapter.searchSymbols("retry");
    assert.equal(symbols[0].qualifiedName, "PaymentService.retry");

    const callers = await adapter.callers("PaymentService.retry");
    assert.equal(callers[0].name, "PaymentController.post");

    const dependents = await adapter.dependents("PaymentService.retry");
    assert.equal(dependents[0].name, "Reconciliation.run");

    const affected = await adapter.affectedTests(["src/pay.ts"]);
    assert.deepEqual(affected.affectedTests, ["test/pay.test.ts"]);

    const files = await adapter.fileOverview();
    assert.equal(files[0].path, "src/pay.ts");

    const synced = await adapter.ensureSynced();
    assert.equal(synced.pendingChanges, 2); // fake sync doesn't change status payload
  });
});

test("createCodeMap activates codegraph when the index is initialized", async () => {
  // Regression guard for flags the real CLI does not accept: the fake rejects
  // them like commander would, so this fails if any adapter invocation drifts
  // from codegraph 1.6.0's signatures (e.g. `status -j -p <path>`).
  const { binDir } = makeFakeCodegraph({
    status: { json: { initialized: true, version: "1.6.0", pendingChanges: 0 } },
  });
  await withPath(binDir, async () => {
    const result = await createCodeMap("/tmp/repo");
    assert.equal(result.degraded, false);
    assert.equal(result.provider.kind, "codegraph");
    assert.equal(result.provider.structuralQueries, true);
  });
});

test("createCodeMap degrades when codegraph is not installed", async () => {
  const emptyBin = mkdtempSync(path.join(tmpdir(), "pir-emptybin-"));
  const oldPath = process.env.PATH;
  process.env.PATH = emptyBin; // no codegraph anywhere
  try {
    const repo = mkdtempSync(path.join(tmpdir(), "pir-repo-"));
    writeFileSync(path.join(repo, "a.ts"), "export const a = 1;");
    const result = await createCodeMap(repo);
    assert.equal(result.degraded, true);
    assert.equal(result.provider.structuralQueries, false);
    const files = await result.provider.fileOverview();
    assert.equal(files.length, 1);
    await assert.rejects(() => result.provider.searchSymbols("a"));
  } finally {
    process.env.PATH = oldPath;
  }
});

test("createCodeMap degrades when index not initialized", async () => {
  const { binDir } = makeFakeCodegraph({
    status: { json: { initialized: false } },
  });
  await withPath(binDir, async () => {
    const result = await createCodeMap("/tmp/anything");
    assert.equal(result.degraded, true);
    assert.equal(result.reason, "not_initialized");
    assert.ok(result.detail);
  });
});

test("createCodeMap classifies probe crashes as probe_failed, not not_initialized", async () => {
  const { binDir } = makeFakeCodegraph({
    status: { exit: 1, stderr: "error: unknown option '-p'\n" },
  });
  await withPath(binDir, async () => {
    const result = await createCodeMap("/tmp/anything");
    assert.equal(result.degraded, true);
    assert.equal(result.reason, "probe_failed");
    assert.match(result.detail, /probe failed/);
  });
});

test("runJson recognizes the real 1.6.0 not-initialized wording", async () => {
  // 1.6.0 prints: CodeGraph not initialized in <path> / Run "codegraph init"...
  const { binDir } = makeFakeCodegraph({
    status: { json: { initialized: true, pendingChanges: 0 } },
    query: { exit: 1, stderr: 'Run "codegraph init" to initialize\n' },
  });
  await withPath(binDir, async () => {
    const adapter = new CodeGraphCliAdapter("/tmp/repo");
    await assert.rejects(
      () => adapter.searchSymbols("x"),
      (err) => err.kind === "not_initialized",
    );
  });
});

test("hard failures mentioning codegraph init stay classified as failed", async () => {
  // e.g. an index-corruption hint suggesting an unquoted `codegraph init
  // --force` rebuild: a plain re-init will not fix it, so it must not be
  // sniffed into the clean not_initialized degradation.
  const { binDir } = makeFakeCodegraph({
    status: { json: { initialized: true, pendingChanges: 0 } },
    query: { exit: 1, stderr: "index corrupt: run codegraph init --force to rebuild\n" },
  });
  await withPath(binDir, async () => {
    const adapter = new CodeGraphCliAdapter("/tmp/repo");
    await assert.rejects(
      () => adapter.searchSymbols("x"),
      (err) => err.kind === "failed" && /index corrupt/.test(err.message),
    );
  });
});

test("the 1.6.0 'no .codegraph/ index exists' wording classifies as not_initialized", async () => {
  const { binDir } = makeFakeCodegraph({
    status: { json: { initialized: true, pendingChanges: 0 } },
    query: {
      exit: 1,
      stderr: "CodeGraph isn't available here — no .codegraph/ index exists in /tmp/repo. (The project owner can enable CodeGraph with 'codegraph init'.)\n",
    },
  });
  await withPath(binDir, async () => {
    const adapter = new CodeGraphCliAdapter("/tmp/repo");
    await assert.rejects(
      () => adapter.searchSymbols("x"),
      (err) => err.kind === "not_initialized",
    );
  });
});
