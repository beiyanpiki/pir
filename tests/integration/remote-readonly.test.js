import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTempGitRepo } from "../fixtures/helpers.js";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli/cli.js");
const CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "pir-ro-cfg-"));

async function pir(args, opts = {}) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PIR_CONFIG_DIR: CONFIG_DIR, PIR_NO_WIZARD: "1", ...opts.env },
  });
  return { stdout, stderr, code: 0 };
}

async function pirExpectFail(args, opts = {}) {
  try {
    await pir(args, opts);
  } catch (err) {
    return { stderr: err.stderr ?? "", stdout: err.stdout ?? "", code: err.code ?? 1 };
  }
  throw new Error(`expected failure: pir ${args.join(" ")}`);
}

/**
 * #44, the incident from #42: a sandbox whose .git is readable but read-only.
 * The bundle-free findings read gets needFull, the fallback tries to prepare
 * the full bundle locally, and update-ref fails on the read-only .git. That
 * failure is a LOCAL preparation error — it must name the local stage and
 * must never claim the server is unreachable.
 */
test("#44: bundle preparation on a read-only .git is reported as a local error, not 'cannot reach'", async (t) => {
  if (process.getuid?.() === 0) return t.skip("chmod-based read-only fixtures do not bind under root");

  const repo = createTempGitRepo("pir-ro-");
  repo.write("src/a.ts", "export const a = 1;\n");
  repo.commit("second");

  const posts = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      posts.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ needFull: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  try {
    // Read-only .git: git update-ref cannot create refs/pir/bundle-head.lock.
    chmodSync(path.join(repo.dir, ".git"), 0o500);
    chmodSync(path.join(repo.dir, ".git", "refs"), 0o500);

    const res = await pirExpectFail(["findings", "list", "--json", "--server", base, "--cwd", repo.dir]);
    assert.equal(res.code, 3);
    assert.match(res.stderr, /failed to prepare the review bundle locally/);
    assert.match(res.stderr, /local git error, not a server connectivity problem/);
    assert.doesNotMatch(res.stderr, /cannot reach/);
    assert.doesNotMatch(res.stderr, /PIR_REMOTE_TIMEOUT/);
    // The stub saw only the bundle-free probe — the failure happened before
    // any history upload (#44: the stub receives zero uploads).
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.noBundle, true);
    assert.equal(posts[0].body.bundleBase64, "");
  } finally {
    chmodSync(path.join(repo.dir, ".git", "refs"), 0o700);
    chmodSync(path.join(repo.dir, ".git"), 0o700);
    repo.cleanup();
  }
});
