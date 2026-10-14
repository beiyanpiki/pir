import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const projectId = "a".repeat(64);
const runA = "11111111-2222-3333-4444-555555555555";
const runB = "99999999-2222-3333-4444-555555555555";
const project = { projectId, name: "Archive project", remote: null, runsTotal: 2, lastRunAt: 2, lastRunStatus: "completed", openFindings: 1, namedInRegistry: true };
const run = (runId) => ({ runId, mode: "change", base: "c".repeat(40), head: "d".repeat(40), startedAt: 1, finishedAt: 2, status: "completed", rounds: 1, candidates: 1, confirmed: 1, rejected: 0, uncertain: 0, notes: null, model: "glm-5.3", durationMs: 1, totalTokens: 3000, cost: .01, transcriptsAvailable: false, runVerdict: "incorrect", stoppedBecause: "Completed recorded review", incomplete: false });
const finding = { id: "finding-1", displayId: "F-1", title: "Validate archive path", category: "input-validation", severity: "P1", status: "confirmed", confidence: .97, round: 1, createdAt: 1, updatedAt: 2, evidenceCount: 1, runId: runB, fingerprint: "archive-path-fingerprint" };
const findingDetail = { ...finding, claim: "Archive path escapes its root.", trigger: "Nested archive path", anchors: [{ path: "src/archive.ts", startLine: 42 }], evidence: [{ kind: "code", path: "src/archive.ts", startLine: 42, excerpt: "readArchive(path)", description: "Input is read before normalization." }], memoryMatches: [], verifierRationale: "Verified against the archive reader." };
const coverage = { available: false, mode: "change", summary: {}, files: [] };
const detail = { run: run(runB), findings: { items: [finding], total: 1 }, sessions: [{ file: "reviewer.json", sessionKind: "reviewer", round: 1 }], manifest: null, transcriptsAvailable: false };

async function mockArchive(page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/overview") return route.fulfill({ json: { projects: [project], active: [] } });
    if (path.endsWith("/run-compare")) return route.fulfill({ json: {
      leftRun: run(runA), rightRun: run(runB),
      added: [{ fingerprint: finding.fingerprint, before: null, after: finding }], removed: [], changed: [], unchanged: [],
    } });
    if (path.startsWith(`/api/projects/${projectId}/`)) {
      if (path.endsWith("/runs")) return route.fulfill({ json: { runs: [run(runA), run(runB)], total: 2 } });
      if (path.endsWith("/findings")) {
        const match = (!url.searchParams.get("q") || finding.title.toLowerCase().includes(url.searchParams.get("q").toLowerCase())) &&
          (!url.searchParams.get("severity") || url.searchParams.get("severity") === finding.severity) &&
          (!url.searchParams.get("status") || url.searchParams.get("status") === finding.status);
        return route.fulfill({ json: { findings: match ? [finding] : [], total: match ? 1 : 0 } });
      }
      if (path.endsWith("/memory")) return route.fulfill({ json: { items: [{ id: "memory-1", kind: "resolution", claim: "Accepted archive risk", decision: "expected", stale: true, rationale: "Prior accepted behavior", relatedFinding: { runId: runB, displayId: "F-1" } }], total: 1 } });
      if (path.endsWith("/feedback")) return route.fulfill({ json: { events: [{ id: 1, ts: 2, action: "feedback", decision: "expected", note: "Archive risk tracked", findingId: finding.id, scope: "project" }], total: 1 } });
    }
    if (path.endsWith("/coverage")) return route.fulfill({ json: coverage });
    if (path.endsWith(`/findings/${finding.id}`)) return route.fulfill({ json: findingDetail });
    if (path.endsWith(`/runs/${projectId}/${runB}`)) return route.fulfill({ json: detail });
    return route.fulfill({ status: 404, json: { error: "Unmocked archive resource" } });
  });
}

test.beforeEach(async ({ page }) => { await mockArchive(page); });

test("project navigation exposes findings memory feedback and comparison", async ({ page }) => {
  await page.goto(`/projects/${projectId}`);
  const views = page.getByRole("navigation", { name: "Project views" });
  await views.getByRole("link", { name: "Findings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Project Findings" })).toBeVisible();
  await page.getByRole("navigation", { name: "Project views" }).getByRole("link", { name: "memory", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Project Memory" })).toBeVisible();
  await expect(page.getByText(/expected · Stale/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Related finding F-1" })).toHaveAttribute("href", new RegExp(`runs/${projectId}/${runB}.*finding=F-1`));
  await page.getByRole("navigation", { name: "Project views" }).getByRole("link", { name: "feedback", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Project Feedback" })).toBeVisible();
  await expect(page.getByText("Archive risk tracked")).toBeVisible();
  await page.getByRole("navigation", { name: "Project views" }).getByRole("link", { name: "compare", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Compare review runs" })).toBeVisible();
});

test("project finding search uses direct URL filters and stable source links", async ({ page }) => {
  await page.goto(`/projects/${projectId}/findings?q=Validate&severity=P1&status=confirmed`);
  await expect(page.getByRole("searchbox", { name: "Search project findings" })).toHaveValue("Validate");
  await expect(page.getByRole("combobox", { name: "Severity", exact: true })).toHaveValue("P1");
  const source = page.getByRole("link", { name: "F-1 · Validate archive path" });
  await expect(source).toHaveAttribute("href", `/runs/${projectId}/${runB}?tab=findings&finding=F-1`);
  await page.getByRole("searchbox", { name: "Search project findings" }).fill("missing");
  await expect(page).toHaveURL(/q=missing/);
  await expect(page.getByText("No matching findings in this project")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("searchbox", { name: "Search project findings" })).toHaveValue("Validate");
  await expect(source).toBeVisible();
});

test("comparison IDs survive reload and added findings retain run links", async ({ page }) => {
  await page.goto(`/projects/${projectId}/compare?leftRunId=${runA}&rightRunId=${runB}`);
  await expect(page.getByRole("textbox", { name: "Earlier run ID" })).toHaveValue(runA);
  await expect(page.getByRole("textbox", { name: "Later run ID" })).toHaveValue(runB);
  await expect(page.getByRole("heading", { name: "added (1)", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "F-1", exact: true })).toHaveAttribute("href", `/runs/${projectId}/${runB}?tab=findings&finding=F-1`);
  await page.reload();
  await expect(page.getByRole("heading", { name: "added (1)", exact: true })).toBeVisible();
});

test("Markdown and JSON exports include finding evidence and stable session links", async ({ page }) => {
  await page.goto(`/runs/${projectId}/${runB}`);
  for (const [format, extension] of [["JSON", "json"], ["Markdown", "md"]]) {
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: `Export ${format}` }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(`pir-${runB}.${extension}`);
    const content = await readFile(await download.path(), "utf8");
    expect(content).toContain("Archive path escapes its root.");
    expect(content).toContain("src/archive.ts");
    expect(content).toContain("readArchive(path)");
    expect(content).toContain("tab=workflow&session=persisted%3Areviewer.json");
    if (format === "JSON") expect(JSON.parse(content).coverage.available).toBe(false);
  }
});

test("page alerts require opt-in and remember the browser preference", async ({ page }) => {
  await page.goto(`/runs/${projectId}/${runB}`);
  const optIn = page.getByRole("checkbox", { name: "Page alerts" });
  await expect(optIn).not.toBeChecked();
  await expect(page.locator(".page-alert-toast")).toHaveCount(0);
  await optIn.check();
  expect(await page.evaluate(() => localStorage.getItem("pir-web-page-alerts"))).toBe("true");
  await page.reload();
  await expect(optIn).toBeChecked();
  await optIn.uncheck();
  expect(await page.evaluate(() => localStorage.getItem("pir-web-page-alerts"))).toBe("false");
  await expect(page.locator(".page-alert-toast")).toHaveCount(0);
});

test("page alerts ignore historical replay and report newly observed completion after opt-in", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    window.fetch = (input, options) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.includes("/api/events?")) return nativeFetch(input, options);
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          window.emitReviewEvent = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          window.emitReviewEvent({ kind: "ready", runId: null });
        },
      }), { headers: { "content-type": "text/event-stream" } }));
    };
  });
  await page.route(`**/api/runs/${projectId}/${runB}`, (route) => route.fulfill({ json: { ...detail, run: { ...detail.run, status: "running", finishedAt: null } } }));
  await page.goto(`/runs/${projectId}/${runB}`);
  await expect.poll(() => page.evaluate(() => typeof window.emitReviewEvent)).toBe("function");
  const end = { kind: "run-end", runId: runB, projectId, status: "completed", stoppedBecause: "Finished live browser fixture", durationMs: 1, counts: { rounds: 1, candidates: 1, confirmed: 1, rejected: 0, uncertain: 0, pending: 0 }, findings: [] };
  await expect(page.getByRole("checkbox", { name: "Page alerts" })).not.toBeChecked();
  await expect(page.locator(".page-alert-toast")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Page alerts" }).check();
  await page.evaluate((event) => window.emitReviewEvent(event), { ...end, seq: 1, ts: 1 });
  // A settled replay ends this observation. Reopen the still-running REST
  // fixture before testing a newly observed outcome on a fresh connection.
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof window.emitReviewEvent)).toBe("function");
  await expect(page.getByRole("checkbox", { name: "Page alerts" })).toBeChecked();
  await expect(page.locator(".page-alert-toast")).toHaveCount(0);
  await page.evaluate((event) => window.emitReviewEvent(event), { ...end, seq: 2, ts: Date.now() + 100 });
  await expect(page.locator(".page-alert-toast")).toContainText("Review ended: completed.");
  await expect(page).toHaveTitle(/^\(1\) pir/);
  await page.getByRole("button", { name: "Mark read" }).click();
  await expect(page.locator(".page-alert-toast")).toHaveCount(0);
  await expect(page).not.toHaveTitle(/^\(/);
});
