import { test } from "node:test";
import assert from "assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseOptions, readPinnedSha, depsMarker } from "../eval/reviewbench/judge.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JUDGE_JS = path.join(HERE, "..", "eval", "reviewbench", "judge.js");

function temporary(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "pir-rb-judge-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseOptions maps flags and env, forwarding post-separator args to the judge", () => {
  const options = parseOptions(["--candidate", "./out/round/candidate-run1", "--", "--limit", "3"], {
    RB_JUDGE_PROVIDER: "p",
    RB_JUDGE_MODEL: "m",
  });
  assert.ok(path.isAbsolute(options.candidate));
  assert.equal(options.provider, "p");
  assert.equal(options.model, "m");
  assert.deepEqual(options.extra, ["--limit", "3"]);

  const flagged = parseOptions(["--provider", "p2", "--model", "m2"], {});
  assert.equal(flagged.provider, "p2");
  assert.equal(flagged.model, "m2");

  assert.throws(() => parseOptions(["--candidate"], {}), /missing value/);
});

test("readPinnedSha validates the vendored pin file", () => {
  const sha = readPinnedSha();
  assert.match(sha, /^[0-9a-f]{40}$/);
  temporary((dir) => {
    const bad = path.join(dir, "SHA");
    writeFileSync(bad, "not-a-sha\n");
    assert.throws(() => readPinnedSha(bad), /invalid pinned SHA/);
  });
});

test("depsMarker is one file whose content ties node_modules to a pinned SHA", () => {
  assert.equal(depsMarker("/d"), path.join("/d", ".pir-npm-ci", "done"));
});

test("PIR_EVAL gate: parseable skip JSON, exit 0, no clone", () => {
  const result = spawnSync(process.execPath, [JUDGE_JS, "--json"], {
    encoding: "utf8",
    env: { ...process.env, PIR_EVAL: "0" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { skipped: true, reason: "PIR_EVAL=1 required" });
  assert.equal(
    spawnSync(process.execPath, [JUDGE_JS], { encoding: "utf8", env: { ...process.env, PIR_EVAL: "0" } }).stdout,
    "skipped: set PIR_EVAL=1 to allow model evaluation\n",
  );
});

test("validation fails before any clone when provider/model or candidate are missing", () => {
  temporary((dir) => {
    // Sandbox the clone location (RB_JUDGE_CACHE_DIR): the test must never
    // touch the real .cache/reviewbench — npm test would otherwise wipe a
    // user's pinned judge clone and its npm ci marker.
    const candidate = path.join(dir, "round", "candidate-run1");
    mkdirSync(candidate, { recursive: true });
    const sandbox = path.join(dir, "sandbox-cache");
    const wouldClone = path.join(sandbox, "reviewbench");

    const missingProvider = spawnSync(process.execPath, [JUDGE_JS, "--candidate", candidate], {
      encoding: "utf8",
      env: { ...process.env, PIR_EVAL: "1", RB_JUDGE_MODEL: "m", RB_JUDGE_CACHE_DIR: sandbox },
    });
    assert.equal(missingProvider.status, 3);
    assert.match(missingProvider.stderr, /RB_JUDGE_PROVIDER/);
    assert.equal(existsSync(wouldClone), false, "must not clone before validation");

    const missingModel = spawnSync(process.execPath, [JUDGE_JS, "--candidate", candidate], {
      encoding: "utf8",
      env: { ...process.env, PIR_EVAL: "1", RB_JUDGE_PROVIDER: "p", RB_JUDGE_CACHE_DIR: sandbox },
    });
    assert.equal(missingModel.status, 3);
    assert.match(missingModel.stderr, /RB_JUDGE_MODEL/);

    const missingCandidate = spawnSync(process.execPath, [JUDGE_JS], {
      encoding: "utf8",
      env: { ...process.env, PIR_EVAL: "1", RB_JUDGE_PROVIDER: "p", RB_JUDGE_MODEL: "m", RB_JUDGE_CACHE_DIR: sandbox },
    });
    assert.equal(missingCandidate.status, 3);
    assert.match(missingCandidate.stderr, /--candidate/);
    assert.equal(existsSync(wouldClone), false, "must not clone before validation");

    // A nonexistent path hits the designed message, not a raw ENOENT.
    const ghostCandidate = spawnSync(process.execPath, [JUDGE_JS, "--candidate", path.join(dir, "no-such-dir")], {
      encoding: "utf8",
      env: { ...process.env, PIR_EVAL: "1", RB_JUDGE_PROVIDER: "p", RB_JUDGE_MODEL: "m", RB_JUDGE_CACHE_DIR: sandbox },
    });
    assert.equal(ghostCandidate.status, 3);
    assert.match(ghostCandidate.stderr, /--candidate must be an existing judging-input directory/);
    assert.equal(existsSync(wouldClone), false, "must not clone before validation");
  });
});
