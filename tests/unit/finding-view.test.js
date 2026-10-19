import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Memory } from "../../dist/memory/index.js";
import { toFindingView } from "../../dist/app/find.js";
import { buildIdentity } from "../../dist/findings/identity.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

function finding(overrides) {
  const claim = overrides.claim ?? "The running total ignores the per-item rate";
  return {
    title: "Rate applied too late",
    claim,
    trigger: "Calling computeTotal once",
    category: "correctness",
    severity: "P1",
    round: 1,
    status: "confirmed",
    memoryMatches: [],
    identity: buildIdentity({ category: "correctness", claim, trigger: "Calling computeTotal once" }),
    ...overrides,
  };
}

test("FindingView exposes the B2 correction flag and it survives the findings store (B2)", async () => {
  const repo = createTempGitRepo("pir-finding-view-");
  const memory = await Memory.open(repo.dir, { dbPath: path.join(repo.dir, ".pir-finding-view.sqlite") });
  try {
    const corrected = memory.findings.insert(finding({
      anchors: [{ path: "src/total.ts", startLine: 10, endLine: 12, excerpt: "return total * rate;", lineCorrected: true, originalStartLine: 34, originalEndLine: 36 }],
      evidence: [{ kind: "code", path: "src/total.ts", startLine: 12, excerpt: "rate" }],
    }), "run-b2");
    const plain = memory.findings.insert(finding({
      claim: "A different defect claim", anchors: [{ path: "src/total.ts", startLine: 3 }], evidence: [],
    }), "run-b2");

    const correctedView = toFindingView({ memory }, memory.findings.get(corrected.id));
    assert.equal(correctedView.lineCorrected, true);
    assert.deepEqual(correctedView.anchors, [{
      path: "src/total.ts", startLine: 10, endLine: 12, excerpt: "return total * rate;",
      lineCorrected: true, originalStartLine: 34, originalEndLine: 36,
    }]);
    // The --json envelope carries the flag verbatim for downstream consumers.
    assert.match(JSON.stringify(correctedView), /"lineCorrected":true/);

    const plainView = toFindingView({ memory }, memory.findings.get(plain.id));
    assert.equal(plainView.lineCorrected, false);
    assert.deepEqual(plainView.anchors, [{ path: "src/total.ts", startLine: 3 }]);
    assert.ok(!JSON.stringify(plainView.anchors).includes("lineCorrected"));
  } finally {
    memory.close();
    repo.cleanup();
  }
});
