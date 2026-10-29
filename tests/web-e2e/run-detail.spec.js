import { test, expect } from "@playwright/test";
import { detail, finding, findingDetail, projectA, runA, runB, transcript } from "./fixtures.js";

const auditCoverage = {
  mode: "audit",
  available: true,
  summary: {
    filesTotal: 4, filesNotSelected: 1, filesExcluded: 0, filesInScope: 3,
    filesReviewed: 2, filesPartial: 1, filesUnreviewed: 0, filesBlocked: 0, filesFailed: 0,
    batchesTotal: 4, batchesCompleted: 3, batchesBlocked: 1, batchesFailed: 0,
  },
  units: [{ id: "unit-1", module: "web", state: "reviewed", files: 2, attempts: 1 }],
  files: [{ path: "web/src/x.ts", blobId: "b", state: "reviewed", rangesTotal: 4, rangesReviewed: 4 }],
  target: {},
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/overview", (route) => route.fulfill({ json: { projects: [{ projectId: projectA, name: "Fixture", remote: null, runsTotal: 2, lastRunAt: 1, lastRunStatus: "completed", openFindings: 1, namedInRegistry: true }], active: [] } }));
  await page.route("**/api/runs/*/*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.split("/").length > 5) return route.fallback();
    route.fulfill({ json: detail(url.pathname.split("/")[4]) });
  });
  await page.route("**/api/runs/*/*/coverage", (route) => route.fulfill({ json: auditCoverage }));
  await page.route("**/api/runs/*/*/transcript/*", (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const id = parts[4];
    route.fulfill({ json: transcript(id === runA ? "RUN A" : "RUN B") });
  });
  await page.route("**/api/runs/*/*/findings/*", (route) => route.fulfill({ json: findingDetail() }));
});

test("the same session file under a different run never reuses the previous transcript", async ({ page }) => {
  await page.goto(`runs/${projectA}/${runA}?tab=workflow`);
  await expect(page.locator(".wf-thread")).toContainText("SESSION BODY RUN A");
  await expect(page.locator(".wf-tool")).toHaveCount(1);
  await expect(page.locator(".wf-tool-name")).toContainText("read_file");
  await expect(page.locator(".wf-tools-title")).toHaveCount(0);

  await page.evaluate((url) => { history.pushState({}, "", url); dispatchEvent(new PopStateEvent("popstate")); }, `/runs/${projectA}/${runB}?tab=workflow`);
  await expect(page.locator(".wf-thread")).toContainText("SESSION BODY RUN B");
  await expect(page.locator(".wf-thread")).not.toContainText("SESSION BODY RUN A");
});

test("the workflow timeline lists tool rows directly and expands reasoning", async ({ page }) => {
  await page.goto(`runs/${projectA}/${runA}?tab=workflow`);
  await expect(page.locator(".wf-thread")).toContainText("SESSION BODY RUN A");
  await expect(page.locator(".wf-reasoning")).toContainText("Reasoning");
  // Reasoning is expanded on arrival, not hidden behind a click.
  await expect(page.locator(".wf-reasoning").first()).toHaveAttribute("open", "");
  // Tool rows are listed directly: the call is visible without opening a group,
  // and its body is mounted only once the row is opened.
  const tool = page.locator(".wf-tool").first();
  await expect(tool.locator(".wf-tool-body")).toHaveCount(0);
  await tool.locator(".wf-tool-summary").click();
  await expect(tool.locator(".wf-tool-body")).toHaveCount(1);
  await expect(tool.locator(".wf-tool-name")).toHaveText("read_file");
  await expect(tool.locator(".wf-tool-hint")).toContainText("session.ts");

  const before = await page.evaluate(() => history.length);
  await page.getByLabel("Search sessions").fill("nav");
  await expect.poll(() => page.evaluate(() => new URL(window.location.href).searchParams.get("q"))).toBe("nav");
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => history.length)).toBe(before);
});

test("the finding drawer closes with Escape and returns focus to its trigger", async ({ page }) => {
  await page.goto(`runs/${projectA}/${runA}?tab=findings`);
  await expect(page.getByText("Reported (1)")).toBeVisible();
  const row = page.locator(".pir-finding-row").first();
  await expect(row).toContainText("Switch reuses the previous transcript");
  await row.click();
  await expect(page.getByText("Verifier rationale")).toBeVisible();
  await expect(page.locator(".ant-drawer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".ant-drawer-open")).toHaveCount(0);
  await expect(row).toBeFocused();
});

test("audit coverage reads the batch fields the engine actually persists", async ({ page }) => {
  await page.goto(`runs/${projectA}/${runA}?tab=coverage`);
  await expect(page.getByText("3 / 4")).toBeVisible();
  await expect(page.getByText("Blocked / failed")).toBeVisible();
  await expect(page.getByText("Reviewed", { exact: true })).toBeVisible();
});
test("the session rail switches the timeline to the verifier", async ({ page }) => {
  await page.goto(`runs/${projectA}/${runA}?tab=workflow`);
  await expect(page.locator(".wf-session")).toHaveCount(2);
  await page.locator(".wf-session").filter({ hasText: "F-101" }).click();
  await expect(page.locator(".wf-title")).toHaveText("F-101");
  await expect(page.locator(".wf-meta")).toContainText("verifier-r1-F-101.json");
  await expect(page).toHaveURL(/session=/);
});
test("a long transcript mounts in slices and defers offscreen markdown", async ({ page }) => {
  const bulk = "The reviewer read the workspace and compared the change against the recorded baseline. ".repeat(60);
  const messages = [{ role: "user", content: "Review this change.", timestamp: 1 }];
  for (let i = 0; i < 40; i++) {
    messages.push({ role: "assistant", content: [{ type: "text", text: `Paragraph ${i}. ${bulk}` }], model: "fixture/model", timestamp: i + 2 });
  }
  // Sample the mounted thread from the first frame so the growth is observable
  // even though the slices finish within a second.
  await page.addInitScript(() => {
    window.__counts = [];
    const sample = () => {
      window.__counts.push(document.querySelectorAll(".wf-response").length);
      if (window.__counts.length < 600) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.route("**/api/runs/**/transcript/**", (route) =>
    route.fulfill({ json: { prompt: "Review this change.", messages, model: "fixture/model", startedAt: "2026-10-28T00:00:00Z", endedAt: "2026-10-28T00:05:00Z" } }),
  );
  await page.goto(`runs/${projectA}/${runA}?tab=workflow`);
  await expect(page.locator(".wf-response").first()).toBeVisible();
  // Prose outside the viewport is not parsed, and the thread mounts in slices:
  // only a handful of the 40 blocks are real markdown at any moment.
  const mounted = await page.locator(".pir-markdown:not(.is-deferred)").count();
  const deferred = await page.locator(".pir-markdown.is-deferred").count();
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(12);
  expect(deferred).toBeGreaterThan(3);
  // The deferred prose is still real text: find-in-page and assistive tech can
  // read it before the markdown is parsed.
  await expect(page.locator(".wf-plain-text").first()).toContainText("Paragraph");
  // Slicing is observable: the thread grows from a first screenful to the whole.
  await expect.poll(() => page.locator(".wf-response").count()).toBe(40);
  const counts = await page.evaluate(() => window.__counts);
  const smallest = Math.min(...counts.filter((value) => value > 0));
  expect(smallest).toBeLessThan(40);
  expect(Math.max(...counts)).toBe(40);
});