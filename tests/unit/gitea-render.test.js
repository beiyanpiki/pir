import { test } from "node:test";
import assert from "node:assert/strict";

const { PIR_REVIEW_MARKER, PIR_STATUS_MARKER } = await import("../../dist/gitea/policy.js");
const {
  renderStatusBody,
  renderReviewBody,
  renderInlineFindingBody,
  escapeTableCell,
  stripHtmlComments,
} = await import("../../dist/gitea/render.js");

/**
 * Rendering contract for everything the Gitea client ships: status bodies
 * (four phases, both languages, marker exactly once), the review body
 * (sections, verbatim walkthrough, demoted/unchanged notes, marker last),
 * inline bodies (caps), and the markdown hygiene helpers (table-cell
 * escaping, comment injection cannot forge or erase a pir marker).
 */

const STATUS_MARKER = PIR_STATUS_MARKER("owner", "repo", 42);

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function view(overrides) {
  return {
    id: "row-1",
    displayId: "F-1",
    fingerprint: "fp-1",
    title: "Off-by-one",
    claim: "The loop skips the first element",
    trigger: "Calling reduce over the input",
    category: "correctness",
    severity: "P1",
    status: "confirmed",
    featureKey: null,
    entityKey: null,
    anchors: [{ path: "src/loop.ts", startLine: 42 }],
    evidence: [],
    memoryMatches: [],
    verifierRationale: "Confirmed against the loop guard.",
    rejectionGround: null,
    confidence: 0.9,
    round: 1,
    createdAt: 1,
    lineCorrected: false,
    ...overrides,
  };
}

const STATUS_BASE = {
  lang: "en",
  marker: STATUS_MARKER,
  repoFullName: "owner/repo",
  number: 42,
  headSha: "abcdef0123456789",
  baseRef: "main",
};

// ---------------------------------------------------------------------------
// status bodies
// ---------------------------------------------------------------------------

test("status body (en, started): marker first line and exactly once, base→head with short SHA, run link", () => {
  const body = renderStatusBody({ ...STATUS_BASE, phase: "started", runUrl: "https://ci/run/1" });
  const lines = body.split("\n");
  assert.equal(lines[0], STATUS_MARKER);
  assert.equal(count(body, STATUS_MARKER), 1);
  assert.ok(body.includes("## 🔍 pir review started"));
  assert.ok(body.includes("owner/repo#42: base `main` → head `abcdef0`"));
  assert.ok(body.includes("Results will be posted here."));
  assert.ok(body.includes("[View run](https://ci/run/1)"));
});

test("status body (zh-CN, started)", () => {
  const body = renderStatusBody({ ...STATUS_BASE, lang: "zh-CN", phase: "started" });
  assert.equal(body.split("\n")[0], STATUS_MARKER);
  assert.ok(body.includes("## 🔍 pir 评审已开始"));
  assert.ok(body.includes("评审结果将发布到这里。"));
  assert.ok(!body.includes("[View run]"), "no run link when runUrl is absent");
});

test("status body (en, done with findings): count heading, severity counts sorted P0..P3, table rows", () => {
  const body = renderStatusBody({
    ...STATUS_BASE,
    phase: "done",
    severityCounts: { P2: 1, P1: 2 },
    findingsSummary: [
      { displayId: "F-1", severity: "P1", category: "correctness", anchor: "src/loop.ts:42", claim: "skips first" },
      { displayId: "F-2", severity: "P1", category: "correctness", anchor: "src/loop.ts:7", claim: "skips last" },
      { displayId: "F-3", severity: "P2", category: "performance", anchor: "src/util.ts:3", claim: "O(n^2) scan" },
    ],
    runUrl: "https://ci/run/2",
  });
  assert.equal(count(body, STATUS_MARKER), 1);
  assert.ok(body.includes("## ✅ Review complete — 3 finding(s)"));
  assert.ok(body.includes("**P1**: 2 · **P2**: 1"));
  assert.ok(body.includes("| ID | Severity | Category | Location | Claim |"));
  assert.ok(body.includes("| F-1 | P1 | correctness | src/loop.ts:42 | skips first |"));
  assert.ok(body.includes("| F-3 | P2 | performance | src/util.ts:3 | O(n^2) scan |"));
  assert.ok(body.includes("[View run](https://ci/run/2)"));
});

test("status body (zh-CN, done with findings): localized heading and table headers", () => {
  const body = renderStatusBody({
    ...STATUS_BASE,
    lang: "zh-CN",
    phase: "done",
    severityCounts: { P1: 1 },
    findingsSummary: [
      { displayId: "F-1", severity: "P1", category: "正确性", anchor: "src/loop.ts:42", claim: "漏掉首元素" },
    ],
  });
  assert.ok(body.includes("## ✅ 评审完成 — 1 个发现"));
  assert.ok(body.includes("| ID | 严重级别 | 类别 | 位置 | 问题说明 |"));
  assert.ok(body.includes("| F-1 | P1 | 正确性 | src/loop.ts:42 | 漏掉首元素 |"));
});

test("status body (done without findings): clean heading, no table, no counts", () => {
  const en = renderStatusBody({ ...STATUS_BASE, phase: "done" });
  assert.ok(en.includes("## ✅ Review complete — no verified findings."));
  assert.ok(!en.includes("| ID |"));
  assert.ok(!en.includes("finding(s)"));

  const zh = renderStatusBody({ ...STATUS_BASE, lang: "zh-CN", phase: "done", findingsSummary: [] });
  assert.ok(zh.includes("## ✅ 评审完成 — 没有已验证的发现。"));
});

test("status body (failed): sanitized single-line capped error plus logs hint", () => {
  const long = "x".repeat(500);
  const body = renderStatusBody({
    ...STATUS_BASE,
    phase: "failed",
    error: `boom\nat line 3\n\n${long}`,
  });
  assert.ok(body.includes("## ❌ Review failed"));
  const errorLine = body.split("\n").find((l) => l.startsWith("Error:"));
  assert.ok(errorLine, "error line present");
  assert.equal(count(errorLine, "\n"), 0);
  assert.ok(errorLine.length <= "Error: ".length + 301, "capped with a single ellipsis");
  assert.ok(errorLine.includes("boom at line 3"), "newlines collapsed to spaces");
  assert.ok(errorLine.endsWith("…"));
  assert.ok(body.includes("Check the pir server logs for details."));

  const zh = renderStatusBody({
    ...STATUS_BASE,
    lang: "zh-CN",
    phase: "failed",
    error: "连接超时",
  });
  assert.ok(zh.includes("## ❌ 评审失败"));
  assert.ok(zh.includes("错误：连接超时"));
  assert.ok(zh.includes("详情请查看 pir 服务器日志。"));
});

// ---------------------------------------------------------------------------
// review body
// ---------------------------------------------------------------------------

const REVIEW_BASE = {
  lang: "en",
  marker: PIR_REVIEW_MARKER,
  repoFullName: "owner/repo",
  number: 42,
  title: "Add flux capacitor",
  baseRef: "main",
  baseSha: "aaaaaaa1111111",
  headRef: "feat/flux",
  headSha: "abcdef0123456789",
  stats: { files: 3, insertions: 120, deletions: 8 },
  plugins: ["typescript", "golang"],
  walkthrough: { summary: "The change **rewrites** the throttle loop.\n\n- keeps behavior\n- drops the mutex", riskAreas: ["throttle hot path", "config parsing"] },
  findings: {
    inline: [{ finding: view(), path: "src/loop.ts", new_position: 42 }],
    demoted: [view({ id: "row-2", displayId: "F-2", severity: "P2", anchors: [{ path: "src/other.ts", startLine: 7 }] })],
    unchangedCount: 2,
  },
  version: "0.6.2",
};

test("review body (en): sections, context, walkthrough verbatim, plugins, footer with marker last", () => {
  const body = renderReviewBody({ ...REVIEW_BASE, runUrl: "https://ci/run/9" });
  const lines = body.split("\n");
  assert.ok(body.includes("# pir review: #42 Add flux capacitor"));
  assert.ok(body.includes("owner/repo#42: `main@aaaaaaa` → `feat/flux@abcdef0`"));
  assert.ok(body.includes("3 file(s) changed, +120/-8"));
  assert.ok(body.includes("Plugins: typescript, golang"));
  // Walkthrough summary markdown lands verbatim (paragraph breaks kept).
  assert.ok(body.includes("## Summary"));
  assert.ok(body.includes("The change **rewrites** the throttle loop.\n\n- keeps behavior\n- drops the mutex"));
  assert.ok(body.includes("Risk areas:"));
  assert.ok(body.includes("- throttle hot path"));
  // Findings table: inline at path:line, demoted flagged.
  assert.ok(body.includes("| F-1 | P1 | correctness | src/loop.ts:42 | The loop skips the first element |"));
  assert.ok(body.includes("(not on a changed line)"));
  assert.ok(body.includes("src/other.ts:7 (not on a changed line)"));
  assert.ok(body.includes("2 previously-reported finding(s) unchanged — not reposted"));
  // Footer: version + run link, marker as the last line, exactly once.
  assert.ok(body.includes("pir v0.6.2 · [View run](https://ci/run/9)"));
  assert.equal(body.trimEnd().split("\n").at(-1), PIR_REVIEW_MARKER);
  assert.equal(count(body, PIR_REVIEW_MARKER), 1);
  assert.equal(lines[0], "# pir review: #42 Add flux capacitor");
});

test("review body (zh-CN): localized headings, notes, and footer", () => {
  const body = renderReviewBody({ ...REVIEW_BASE, lang: "zh-CN" });
  assert.ok(body.includes("# pir 评审：#42 Add flux capacitor"));
  assert.ok(body.includes("3 个文件变更，+120/-8"));
  assert.ok(body.includes("插件：typescript, golang"));
  assert.ok(body.includes("## 总结"));
  assert.ok(body.includes("风险点："));
  assert.ok(body.includes("## 发现"));
  assert.ok(body.includes("src/other.ts:7 (不在变更行上)"));
  assert.ok(body.includes("2 个先前已报告的发现未变化，不再重复发布"));
  assert.ok(body.includes("pir v0.6.2"));
  assert.equal(body.trimEnd().split("\n").at(-1), PIR_REVIEW_MARKER);
});

test("review body: walkthrough null omits the Summary section entirely", () => {
  const body = renderReviewBody({ ...REVIEW_BASE, walkthrough: null });
  assert.ok(!body.includes("## Summary"));
  assert.ok(!body.includes("Risk areas:"));
});

test("review body: no findings renders the empty line, unchanged note absent at 0", () => {
  const body = renderReviewBody({
    ...REVIEW_BASE,
    findings: { inline: [], demoted: [], unchangedCount: 0 },
  });
  assert.ok(body.includes("## Findings"));
  assert.ok(body.includes("No findings."));
  assert.ok(!body.includes("unchanged"));
  assert.ok(!body.includes("| F-1 |"));
});

// ---------------------------------------------------------------------------
// inline finding body
// ---------------------------------------------------------------------------

test("inline body (en): header with severity/category/location, full claim, labels, run link", () => {
  const body = renderInlineFindingBody({ finding: view(), lang: "en", runUrl: "https://ci/run/9" });
  assert.ok(body.startsWith("**P1 · correctness** — `src/loop.ts:42`\n"));
  assert.ok(body.includes("The loop skips the first element"));
  assert.ok(body.includes("Trigger: Calling reduce over the input"));
  assert.ok(body.includes("Verifier: Confirmed against the loop guard."));
  assert.ok(body.includes("[View run](https://ci/run/9)"));
  assert.ok(!body.includes("<!--"), "inline bodies carry no HTML-comment marker");
});

test("inline body (zh-CN): localized labels", () => {
  const body = renderInlineFindingBody({ finding: view(), lang: "zh-CN" });
  assert.ok(body.includes("触发：Calling reduce over the input"));
  assert.ok(body.includes("验证说明：Confirmed against the loop guard."));
});

test("inline body caps trigger at ~400 and rationale at ~1200 with an ellipsis", () => {
  const longTrigger = "t".repeat(500);
  const longRationale = "r".repeat(2000);
  const body = renderInlineFindingBody({
    finding: view({ trigger: longTrigger, verifierRationale: longRationale }),
    lang: "en",
  });
  const triggerLine = body.split("\n").find((l) => l.startsWith("Trigger:"));
  const verifierLine = body.split("\n").find((l) => l.startsWith("Verifier:"));
  assert.equal(triggerLine.length, "Trigger: ".length + 400);
  assert.ok(triggerLine.endsWith("…"));
  assert.equal(verifierLine.length, "Verifier: ".length + 1200);
  assert.ok(verifierLine.endsWith("…"));
  // At or under the cap, text is untouched.
  const short = renderInlineFindingBody({
    finding: view({ trigger: "t".repeat(400), verifierRationale: "r".repeat(1200) }),
    lang: "en",
  });
  assert.ok(short.includes(`Trigger: ${"t".repeat(400)}`));
  assert.ok(short.includes(`Verifier: ${"r".repeat(1200)}`));
});

// ---------------------------------------------------------------------------
// hygiene helpers
// ---------------------------------------------------------------------------

test("escapeTableCell escapes pipes, collapses newlines, and caps at ~200", () => {
  assert.equal(escapeTableCell("a | b"), "a \\| b");
  assert.equal(escapeTableCell("line1\nline2\ttabbed"), "line1 line2 tabbed");
  const long = "y".repeat(300);
  const capped = escapeTableCell(long);
  assert.ok(capped.length <= 200);
  assert.ok(capped.endsWith("…"));
  assert.equal(escapeTableCell("short"), "short");
});

test("stripHtmlComments removes comments so claims cannot forge or erase pir markers", () => {
  assert.equal(stripHtmlComments("x <!-- hidden --> y"), "x  y");
  assert.equal(stripHtmlComments("<!-- pir:review v1 -->"), "");
  // A claim carrying the review marker cannot inject it into a rendered body.
  const sneaky = view({ claim: "evil <!-- pir:review v1 --> claim" });
  const review = renderReviewBody({
    ...REVIEW_BASE,
    findings: { inline: [{ finding: sneaky, path: "src/loop.ts", new_position: 42 }], demoted: [], unchangedCount: 0 },
  });
  assert.equal(count(review, PIR_REVIEW_MARKER), 1, "the only marker is pir's own footer one");
  assert.ok(review.includes("evil  claim") || review.includes("evil claim"));
  // Nor can it blank the status comment's marker by opening an unclosed comment.
  const status = renderStatusBody({
    ...STATUS_BASE,
    phase: "done",
    findingsSummary: [
      { displayId: "F-1", severity: "P1", category: "correctness", anchor: "a:1", claim: "<!-- pir:status owner/repo#42 v1 --> gone" },
    ],
  });
  assert.equal(count(status, STATUS_MARKER), 1);
  assert.ok(status.includes("gone"));
  // Inline body stays comment-free even when the claim tries to forge one.
  const inline = renderInlineFindingBody({ finding: sneaky, lang: "en" });
  assert.ok(!inline.includes("<!--"));
});
