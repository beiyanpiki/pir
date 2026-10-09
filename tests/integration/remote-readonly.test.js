import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTempGitRepo, git } from "../fixtures/helpers.js";

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

/**
 * #46 (supersedes the #44 incident fixture): a sandbox whose .git is readable
 * but read-only. Bundles are now packed in a temporary bare repo that reads
 * the source objects through alternates, so a read-only .git no longer fails
 * preparation at all — the bundle-free probe gets needFull and the full
 * bundle resend carries real history, with zero writes to the source repo.
 * (#44's error classification for genuinely broken local prep stays covered
 * by the reportBundlePrepFailure unit test.)
 */
test("#46: a read-only .git packs a full bundle without writing the source repo", async (t) => {
  if (process.getuid?.() === 0) return t.skip("chmod-based read-only fixtures do not bind under root");

  const repo = createTempGitRepo("pir-ro-");
  repo.write("src/a.ts", "export const a = 1;\n");
  repo.commit("second");
  const refsBefore = git(repo.dir, ["for-each-ref"]);

  const posts = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      posts.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      if (posts.length === 1) {
        // First contact: the bundle-free probe is refused with needFull.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ needFull: true }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 0, output: "", log: [] }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  try {
    // Read-only .git: the old flow died here on update-ref; the new flow
    // never writes a single byte to the source repository.
    chmodSync(path.join(repo.dir, ".git"), 0o500);
    chmodSync(path.join(repo.dir, ".git", "refs"), 0o500);

    const res = await pir(["findings", "list", "--json", "--server", base, "--cwd", repo.dir]);
    assert.equal(res.code, 0);
    assert.doesNotMatch(res.stderr, /cannot reach/);
    // Probe first, then a full-bundle resend with real history — both made
    // it past a read-only .git (#46).
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body.noBundle, true);
    assert.equal(posts[0].body.bundleBase64, "");
    assert.ok(posts[1].body.bundleBase64.length > 0, "the resend carries a real bundle");
    assert.equal(posts[1].body.noBundle, undefined);
    // Zero source-repo writes: refs and HEAD are byte-identical.
    assert.equal(git(repo.dir, ["for-each-ref"]), refsBefore);
  } finally {
    chmodSync(path.join(repo.dir, ".git", "refs"), 0o700);
    chmodSync(path.join(repo.dir, ".git"), 0o700);
    repo.cleanup();
  }
});
