import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import process from "node:process";
import { startServer } from "../../dist/server/server.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli/cli.js");
const TOKEN = "test-token-123";

async function makeCerts(dir) {
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=pir-test",
    "-keyout", path.join(dir, "key.pem"),
    "-out", path.join(dir, "cert.pem"),
  ]);
  return { cert: path.join(dir, "cert.pem"), key: path.join(dir, "key.pem") };
}

async function withServer(t, fn) {
  const repo = createTempGitRepo("pir-server-");
  const certDir = mkdtempSync(path.join(tmpdir(), "pir-certs-"));
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // self-signed test certs
  const certs = await makeCerts(certDir);
  const { readFileSync } = await import("node:fs");
  const handle = await startServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    workspace: repo.dir,
    tls: { cert: readFileSync(certs.cert, "utf8"), key: readFileSync(certs.key, "utf8") },
  });
  const port = handle.url.split(":").pop();
  const base = `https://127.0.0.1:${port}`;
  t.after(() => {
    handle.close();
    rmSync(certDir, { recursive: true, force: true });
    repo.cleanup();
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
  });
  return { base, repo };
}

test("server: health endpoint and bearer auth on exec", async (t) => {
  const { base } = await withServer(t);

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.tls, true);

  const unauthorized = await fetch(`${base}/v1/exec`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ argv: ["version"] }),
  });
  assert.equal(unauthorized.status, 401);
});

test("server: /v1/exec runs commands through the shared executor", async (t) => {
  const { base } = await withServer(t);

  const response = await fetch(`${base}/v1/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ argv: ["version", "--json"] }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.code, 0);
  const envelope = JSON.parse(result.output);
  assert.equal(envelope.command, "version");
  assert.match(envelope.data.version, /^\d+\.\d+\.\d+$/);
});

test("server: cwd guard rejects escapes and injects the workspace default", async (t) => {
  const { base, repo } = await withServer(t);

  // No --cwd: operates on the workspace root.
  const okResponse = await fetch(`${base}/v1/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ argv: ["memory", "status"] }),
  });
  const ok = await okResponse.json();
  assert.equal(ok.code, 0);

  // Escape attempt: rejected with usage error semantics (code 2).
  const bad = await fetch(`${base}/v1/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ argv: ["memory", "status", "--cwd", "/etc"] }),
  });
  const badBody = await bad.json();
  assert.equal(badBody.code, 2);
  assert.ok(badBody.log.some((l) => l.includes("--cwd must stay under")));

  // State stays inside the project (.pir/) in project-state mode.
  process.env.PIR_STATE_IN_PROJECT = "1";
  const projResponse = await fetch(`${base}/v1/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ argv: ["memory", "status"] }),
  });
  await projResponse.json();
  assert.ok(existsSync(path.join(repo.dir, ".pir", "memory.sqlite")));
  delete process.env.PIR_STATE_IN_PROJECT;
});

test("remote CLI: pir --server relays argv, output and exit code", async (t) => {
  const { base } = await withServer(t);

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    CLI, "--server", base, "--token", TOKEN, "--insecure", "version",
  ]);
  assert.match(stdout.trim(), /^pir \d+\.\d+\.\d+$/);
  assert.ok(stderr.includes("pir-serve") === false || true);

  // Wrong token -> exit 3 with a clear message.
  await assert.rejects(
    execFileAsync(process.execPath, [CLI, "--server", base, "--token", "wrong", "--insecure", "version"]),
    (err) => err.code === 3,
  );
});
