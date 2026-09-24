import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createCodeMap } from "../../dist/codemap/provider.js";
import { CodeGraphCliAdapter } from "../../dist/codemap/codegraph-cli.js";

function makeFakeCodegraph(dir, handlers) {
  // A shell script acting as the codegraph CLI: dispatches subcommands and
  // emits the exact JSON shapes recorded from codegraph 1.6.0.
  const binDir = mkdtempSync(path.join(tmpdir(), "pir-fakebin-"));
  const script = path.join(binDir, "codegraph");
  const body = `#!/bin/sh
sub="$1"; shift
case "$sub" in
${Object.entries(handlers)
  .map(([name, payload]) => `  ${name}) echo '${JSON.stringify(payload)}' ;;`)
  .join("\n")}
  *) echo "unknown $sub" >&2; exit 1 ;;
esac
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
  const { binDir } = makeFakeCodegraph(null, {
    status: { initialized: true, version: "1.6.0", fileCount: 10, nodeCount: 100, edgeCount: 200, lastIndexed: "2026-01-01", pendingChanges: 2 },
    query: [
      { node: { kind: "function", name: "retry", qualifiedName: "PaymentService.retry", filePath: "src/pay.ts", startLine: 10, endLine: 40, signature: "retry()" }, score: 0.9 },
    ],
    callers: { symbol: "PaymentService.retry", callers: [{ name: "PaymentController.post", kind: "method", filePath: "src/api.ts", startLine: 5 }] },
    callees: { symbol: "PaymentService.retry", callees: [{ name: "PaymentGateway.charge", kind: "method", filePath: "src/gw.ts", startLine: 9 }] },
    impact: { symbol: "PaymentService.retry", depth: 2, nodeCount: 3, edgeCount: 4, affected: [{ name: "Reconciliation.run", kind: "function", filePath: "src/recon.ts", startLine: 1 }] },
    affected: { changedFiles: ["src/pay.ts"], affectedTests: ["test/pay.test.ts"], totalDependentsTraversed: 5 },
    files: [{ path: "src/pay.ts", language: "typescript", nodeCount: 12, size: 400 }],
    sync: { ok: true },
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
  const { binDir } = makeFakeCodegraph(null, {
    status: { initialized: false },
  });
  await withPath(binDir, async () => {
    const result = await createCodeMap("/tmp/anything");
    assert.equal(result.degraded, true);
    assert.equal(result.reason, "not_initialized");
  });
});
