import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveServeConcurrency } from "../../dist/server/server.js";

const run = promisify(execFile);

test("serve concurrency: serial defaults and independent flag/environment precedence", () => {
  assert.deepEqual(resolveServeConcurrency({}, {}), { reviewConcurrency: 1, projectReviewConcurrency: 1 });
  assert.deepEqual(resolveServeConcurrency({}, { PIR_REVIEW_CONCURRENCY: "4", PIR_PROJECT_REVIEW_CONCURRENCY: "2" }), {
    reviewConcurrency: 4, projectReviewConcurrency: 2,
  });
  assert.deepEqual(resolveServeConcurrency({ reviewConcurrency: 3 }, { PIR_REVIEW_CONCURRENCY: "invalid", PIR_PROJECT_REVIEW_CONCURRENCY: "2" }), {
    reviewConcurrency: 3, projectReviewConcurrency: 2,
  });
  assert.deepEqual(resolveServeConcurrency({ projectReviewConcurrency: 3 }, { PIR_REVIEW_CONCURRENCY: "4", PIR_PROJECT_REVIEW_CONCURRENCY: "invalid" }), {
    reviewConcurrency: 4, projectReviewConcurrency: 3,
  });
  assert.deepEqual(resolveServeConcurrency({}, { PIR_REVIEW_CONCURRENCY: "", PIR_PROJECT_REVIEW_CONCURRENCY: "  " }), {
    reviewConcurrency: 1, projectReviewConcurrency: 1,
  });
});

test("serve concurrency: invalid environment and numeric inputs fail rather than silently disabling bounds", () => {
  for (const raw of ["0", "-1", "1.5", "1e2", "Infinity", "NaN", " 2", "two", "9007199254740992"]) {
    assert.throws(() => resolveServeConcurrency({}, { PIR_REVIEW_CONCURRENCY: raw }), /positive decimal safe integer/);
    assert.throws(() => resolveServeConcurrency({}, { PIR_PROJECT_REVIEW_CONCURRENCY: raw }), /positive decimal safe integer/);
  }
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveServeConcurrency({ reviewConcurrency: value }, {}), /positive decimal safe integer/);
    assert.throws(() => resolveServeConcurrency({ projectReviewConcurrency: value }, {}), /positive decimal safe integer/);
  }
});

test("serve concurrency: the built CLI reports invalid flags before starting a listener or generating TLS files", async () => {
  for (const flag of ["--review-concurrency", "--project-review-concurrency"]) {
    const error = await run(process.execPath, ["dist/cli/cli.js", "serve", flag, "0"], {
      env: { ...process.env, PIR_NO_WIZARD: "1" }, timeout: 10000,
    }).then(() => assert.fail("invalid concurrency must fail"), (failure) => failure);
    assert.equal(error.code, 2);
    assert.match(error.stderr, new RegExp(`${flag}.*positive decimal safe integer`));
    assert.doesNotMatch(error.stderr, /listening on/);
  }
  const help = await run(process.execPath, ["dist/cli/cli.js", "serve", "--help"]);
  assert.match(help.stdout, /--review-concurrency/);
  assert.match(help.stdout, /--project-review-concurrency/);
});
