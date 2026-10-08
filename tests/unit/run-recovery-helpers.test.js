import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseRunUrl, resolveViewerToken, resolveInsecure, runUrl, runRefFromFlags } from "../../dist/cli/web-client.js";
import { parseArgs } from "../../dist/cli/executor.js";
import { listReceipts, updateReceiptFromResult, writeSubmissionReceipt, findReceipts } from "../../dist/cli/receipts.js";

/** #48/#50/#52 helper contracts: pure URL/credential/receipt behavior. */

const PID = "a".repeat(64);
const RID = "run-1234";

test("parseRunUrl: accepts web-shaped run urls only", () => {
  const ref = parseRunUrl(`https://pir.example:8790/runs/${PID}/${RID}`);
  assert.deepEqual(ref, { origin: "https://pir.example:8790", projectId: PID, runId: RID });
  // trailing slash + query are fine
  assert.equal(parseRunUrl(`http://127.0.0.1:3000/runs/${PID}/${RID}/?x=1`)?.runId, RID);
  // refusals
  assert.equal(parseRunUrl(`https://pir.example/runs/${PID}/${RID}/findings`), null, "extra segments");
  assert.equal(parseRunUrl(`https://pir.example/projects/${PID}/runs/${RID}`), null, "wrong path");
  assert.equal(parseRunUrl(`https://pir.example/runs/not-hex/${RID}`), null, "project id must be 64-hex");
  assert.equal(parseRunUrl(`https://pir.example/runs/${PID}/bad id`), null, "run id charset");
  assert.equal(parseRunUrl("not a url"), null);
  assert.equal(parseRunUrl("ftp://x/runs/a/b"), null);
  assert.equal(parseRunUrl(`ssh://git@host/runs/${PID}/${RID}`), null);
});

test("runRefFromFlags: requires and validates the trio", () => {
  const flags = parseArgs(["--server", "https://s.example", "--project", PID, "--run", RID]).flags;
  assert.deepEqual(runRefFromFlags(flags), { origin: "https://s.example", projectId: PID, runId: RID });
  assert.throws(() => runRefFromFlags(parseArgs(["--project", PID, "--run", RID]).flags), /needs a run URL/);
  assert.throws(() => runRefFromFlags(parseArgs(["--server", "https://s.example", "--run", RID]).flags), /--project/);
  assert.throws(() => runRefFromFlags(parseArgs(["--server", "https://s.example", "--project", "zz", "--run", RID]).flags), /64-hex/);
});

test("runUrl: stable printable form", () => {
  assert.equal(runUrl({ origin: "https://s.example", projectId: PID, runId: RID }), `https://s.example/runs/${PID}/${RID}`);
});

const ORIGIN_A = "https://pir-a.example";
const ORIGIN_B = "https://pir-b.example";

test("resolveViewerToken (#50): precedence and origin binding", () => {
  const config = { schemaVersion: 1, mode: "local", server: { url: ORIGIN_A, viewerToken: "cfg-view" } };
  const base = { env: {}, config };

  // flag wins, any origin — including foreign ones (explicit user intent)
  assert.equal(resolveViewerToken(ORIGIN_B, { argv: ["--viewer-token", "flag-tok"], ...base }).token, "flag-tok");
  // --viewer-token= form
  assert.equal(resolveViewerToken(ORIGIN_B, { argv: ["--viewer-token=flag2"], ...base }).token, "flag2");
  // env credentials are bound to the env-configured origin (PIR_SERVER_URL
  // names the server the pair belongs to; alone the token goes nowhere)
  assert.equal(
    resolveViewerToken(ORIGIN_A, { argv: [], env: { PIR_SERVER_URL: ORIGIN_A, PIR_VIEWER_TOKEN: "env-tok" }, config: null }).token,
    "env-tok",
  );
  assert.equal(resolveViewerToken(ORIGIN_A, { argv: [], env: { PIR_VIEWER_TOKEN: "env-tok" }, config: null }).token, undefined);
  // config for the matching origin (even in local mode)
  assert.equal(resolveViewerToken(ORIGIN_A, base).token, "cfg-view");
  // a --server flag rebinds the ENV pair (dogfood F-45 keeps this)...
  assert.equal(
    resolveViewerToken(ORIGIN_B, { argv: ["--server", ORIGIN_B], env: { PIR_VIEWER_TOKEN: "env-tok" }, config: null }).token,
    "env-tok",
  );
  // ...but never carries the CONFIG token to a different host (dogfood F-45)
  assert.equal(
    resolveViewerToken(ORIGIN_B, { argv: ["--server", ORIGIN_B], env: {}, config }).token,
    undefined,
    "--server must not rebind server.viewerToken to another origin",
  );
  // THE RULE (#50): configured credentials never travel to a foreign origin
  const foreign = resolveViewerToken(ORIGIN_B, base);
  assert.equal(foreign.token, undefined, "config viewerToken must not leak to another origin");
  assert.equal(foreign.originMatchesConfig, false);
  // ...and the execution token is never a fallback for the viewer tier
  const execOnly = { schemaVersion: 1, mode: "remote", server: { url: ORIGIN_A, token: "exec-tok" } };
  assert.equal(resolveViewerToken(ORIGIN_A, { argv: [], env: {}, config: execOnly }).token, undefined);
});

test("resolveInsecure (dogfood F-41/F-45): flag and env apply anywhere, config only to its origin", () => {
  const config = { schemaVersion: 1, mode: "local", server: { url: ORIGIN_A, insecure: true } };
  assert.equal(resolveInsecure(ORIGIN_B, { argv: ["--insecure"], env: {}, config: null }), true);
  assert.equal(resolveInsecure(ORIGIN_B, { argv: [], env: { PIR_INSECURE: "1" }, config: null }), true);
  assert.equal(resolveInsecure(ORIGIN_A, { argv: [], env: {}, config }), true);
  assert.equal(resolveInsecure(ORIGIN_B, { argv: [], env: {}, config }), false, "config insecure must not relax a foreign origin");
  assert.equal(
    resolveInsecure(ORIGIN_B, { argv: ["--server", ORIGIN_B], env: {}, config }),
    false,
    "--server must not rebind config server.insecure to another origin",
  );
  assert.equal(resolveInsecure(ORIGIN_A, { argv: [], env: {}, config: null }), false);
});

function isolatedReceiptsEnv() {
  const dir = mkdtempSync(path.join(tmpdir(), "pir-receipts-unit-"));
  process.env.PIR_CONFIG_DIR = dir;
  return () => rmSync(dir, { recursive: true, force: true });
}

test("receipts (#52): write, argv scrub, runId update, lookup", () => {
  const restore = isolatedReceiptsEnv();
  try {
    const file = writeSubmissionReceipt({
      kind: "audit",
      origin: ORIGIN_A,
      jobId: "job-abcdef123456",
      projectId: PID,
      base: null,
      head: "h".repeat(40),
      argv: ["audit", "--path", "src", "--json"],
    });
    assert.ok(file, "receipt written");
    // owner-only
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(raw.runId, null);
    assert.equal(raw.mode, "async");

    // no result envelope -> runId stays null
    updateReceiptFromResult("job-abcdef123456", "not json at all");
    assert.equal(findReceipts("job-abcdef")[0].receipt.runId, null);
    // envelope without data.run (memory status) -> stays null
    updateReceiptFromResult("job-abcdef123456", JSON.stringify({ command: "memory.status", data: {} }));
    assert.equal(findReceipts("job-abcdef")[0].receipt.runId, null);

    // authoritative update from a real find/audit envelope
    updateReceiptFromResult(
      "job-abcdef123456",
      JSON.stringify({ command: "find", project: { id: PID }, data: { run: { id: RID, head: "h".repeat(40) } } }),
    );
    const updated = findReceipts("job-abcdef123456")[0].receipt;
    assert.equal(updated.runId, RID);
    assert.equal(updated.projectId, PID);

    // prefix lookup: unambiguous and missing
    assert.equal(findReceipts("job-abcdef123456").length, 1);
    assert.equal(findReceipts("job-zzzz").length, 0);
    assert.equal(listReceipts().length, 1);
  } finally {
    restore();
  }
});

test("receipts (#52, dogfood F-46): text results record the run id via the 'run id:' line", () => {
  const restore = isolatedReceiptsEnv();
  try {
    const jobId = "job-textoutput1";
    writeSubmissionReceipt({
      kind: "audit", origin: ORIGIN_A, jobId, projectId: PID, base: null,
      head: "h".repeat(40), argv: ["audit"],
    });
    // A realistic text tail from a non---json run.
    updateReceiptFromResult(
      jobId,
      "stopped: work units completed\nrun id: run-text-123\ntranscripts: /tmp/x\n\nNo confirmed findings.\n",
    );
    assert.equal(findReceipts(jobId)[0].receipt.runId, "run-text-123");

    // Text output without the line keeps null; so does junk JSON.
    const jobId2 = "job-textoutput2";
    writeSubmissionReceipt({
      kind: "audit", origin: ORIGIN_A, jobId: jobId2, projectId: PID, base: null,
      head: "h".repeat(40), argv: ["audit"],
    });
    updateReceiptFromResult(jobId2, "No confirmed findings.\n");
    assert.equal(findReceipts(jobId2)[0].receipt.runId, null);
  } finally {
    restore();
  }
});

test("receipts (#52): credential-looking argv tokens are scrubbed even if they sneak in", () => {
  const restore = isolatedReceiptsEnv();
  try {
    const file = writeSubmissionReceipt({
      kind: "find",
      origin: ORIGIN_A,
      jobId: "job-secretoken1",
      projectId: null,
      base: "b".repeat(40),
      head: "h".repeat(40),
      argv: ["find", "--token", "SUPER-SECRET-1", "--viewer-token=SUPER-SECRET-2", "--json"],
    });
    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.includes("SUPER-SECRET"), "no credential value may reach the receipt file");
    const receipt = JSON.parse(raw);
    assert.deepEqual(receipt.argv, ["find", "--json"]);
  } finally {
    restore();
  }
});
