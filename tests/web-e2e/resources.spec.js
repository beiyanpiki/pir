import { test, expect } from "@playwright/test";

const projectA = "a".repeat(64);
const projectB = "b".repeat(64);
const runA = "11111111-2222-3333-4444-555555555555";
const runB = "99999999-2222-3333-4444-555555555555";
const projects = [
  { projectId: projectA, name: "Project A", remote: null, runsTotal: 2, lastRunAt: 1, lastRunStatus: "completed", openFindings: 0, namedInRegistry: true },
  { projectId: projectB, name: "Project B", remote: null, runsTotal: 1, lastRunAt: 1, lastRunStatus: "completed", openFindings: 0, namedInRegistry: true },
];
const run = (runId, mode = "change") => ({ runId, mode, base: "c".repeat(40), head: "d".repeat(40), startedAt: 1, finishedAt: 2, status: "completed", rounds: 1, candidates: 0, confirmed: 0, rejected: 0, uncertain: 0, notes: null, model: null, durationMs: 1, totalTokens: null, cost: null, transcriptsAvailable: false });
const detail = (runId, extra = {}) => ({ run: run(runId, runId === runB ? "audit" : "change"), findings: { items: [], total: 0 }, sessions: [], manifest: null, ...extra });
const session = { file: "reviewer-r1.json", sessionKind: "reviewer", round: 1 };
const transcript = (prompt) => ({ role: "reviewer", model: "test-model", startedAt: "2026-10-13T00:00:00Z", endedAt: "2026-10-13T00:00:01Z", prompt, messages: [] });

test.beforeEach(async ({ page }) => {
  await page.route("**/api/overview", (route) => route.fulfill({ json: { projects, active: [] } }));
  await page.route("**/api/projects/*/runs?*", (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/")[3];
    const all = id === projectA ? [run(runA), run(runB, "audit")] : [run(runB)];
    const filtered = all.filter((item) => (url.searchParams.get("mode") ?? item.mode) === item.mode && (url.searchParams.get("status") ?? item.status) === item.status);
    route.fulfill({ json: { runs: filtered, total: filtered.length } });
  });
  await page.route("**/api/runs/*/*", (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    route.fulfill({ json: detail(parts[4]) });
  });
});

test("run filters and pagination survive direct URLs and navigation", async ({ page }) => {
  await page.goto(`/projects/${projectA}?status=completed&mode=audit&q=none&offset=50`);
  await expect(page.getByRole("button", { name: "Audit", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("searchbox", { name: "Search this page" })).toHaveValue("none");
  await expect(page).toHaveURL(new RegExp("mode=audit"));
  await expect(page).not.toHaveURL(/offset=/);
  await page.getByRole("button", { name: "All modes" }).click();
  await expect(page).toHaveURL(/status=completed/);
  await expect(page).not.toHaveURL(/offset=/);
});

test("project links update the active sidebar route", async ({ page }) => {
  await page.goto(`/projects/${projectA}`);
  await expect(page.locator(".sidebar-project.is-active")).toContainText("Project A");
  await page.locator(`.sidebar-project-link[href='/projects/${projectB}']`).click();
  await expect(page.locator(".sidebar-project.is-active")).toContainText("Project B");
});

test("overview polling preserves expanded navigation while the refresh is pending", async ({ page }) => {
  let overviewRequests = 0;
  let refreshing = false;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/overview", async (route) => {
    overviewRequests += 1;
    if (refreshing) await pending;
    await route.fulfill({ json: { projects, active: [] } });
  });
  await page.goto(`/runs/${projectA}/${runA}`);
  await expect(page.getByRole("button", { name: "Collapse Project A" })).toBeVisible();
  await page.getByRole("button", { name: "Collapse Project A" }).click();
  await page.getByRole("button", { name: "Expand Project B" }).click();
  await expect(page.locator(`.sidebar-run[href='/runs/${projectB}/${runB}']`)).toBeVisible();
  const initialRequests = overviewRequests;
  refreshing = true;
  await page.waitForTimeout(15_500);
  await expect.poll(() => overviewRequests).toBeGreaterThan(initialRequests);
  await expect(page.getByRole("button", { name: "Expand Project A" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Collapse Project B" })).toBeVisible();
  await expect(page.locator(".sidebar-loading")).toHaveCount(0);
  release();
  await expect(page.getByRole("button", { name: "Collapse Project B" })).toBeVisible();
});

test("typing run search replaces history so Back returns to the prior page", async ({ page }) => {
  await page.goto("/projects");
  await page.locator(`.sidebar-project-link[href='/projects/${projectA}']`).click();
  await page.getByRole("searchbox", { name: "Search this page" }).fill("scope");
  await expect(page).toHaveURL(/q=scope/);
  await page.goBack();
  await expect(page).toHaveURL("http://127.0.0.1:5174/projects");
});

test("run navigation isolates transcripts with identical file names", async ({ page }) => {
  await page.route("**/api/runs/*/*", (route) => {
    const runId = new URL(route.request().url()).pathname.split("/")[4];
    route.fulfill({ json: detail(runId, { run: { ...run(runId), transcriptsAvailable: true }, sessions: [session] }) });
  });
  await page.route("**/api/runs/*/*/transcript/*", (route) => {
    const runId = new URL(route.request().url()).pathname.split("/")[4];
    route.fulfill({ json: transcript(runId === runA ? "Goal from run A" : "Goal from run B") });
  });
  await page.goto(`/runs/${projectA}/${runA}`);
  await expect(page.getByText("Goal from run A", { exact: true })).toBeVisible();
  await page.locator(`.sidebar-run[href='/runs/${projectA}/${runB}']`).click();
  await expect(page.getByText("Goal from run B", { exact: true })).toBeVisible();
  await expect(page.getByText("Goal from run A", { exact: true })).toHaveCount(0);
  await page.locator(`.sidebar-run[href='/runs/${projectA}/${runA}']`).click();
  await expect(page.getByText("Goal from run A", { exact: true })).toBeVisible();
  await expect(page.getByText("Goal from run B", { exact: true })).toHaveCount(0);
});

test("a delayed run response is cancelled when navigating to the next run", async ({ page }) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/runs/*/*", async (route) => {
    const runId = new URL(route.request().url()).pathname.split("/")[4];
    if (runId === runA) {
      await pending;
      await route.fulfill({ json: detail(runA) }).catch(() => {});
      return;
    }
    await route.fulfill({ json: detail(runId) });
  });
  await page.goto(`/runs/${projectA}/${runA}`);
  const cancelled = page.waitForEvent("requestfailed", (request) => request.url().endsWith(`/api/runs/${projectA}/${runA}`));
  await page.locator(`.sidebar-run[href='/runs/${projectA}/${runB}']`).click();
  await cancelled;
  await expect(page.locator(".run-header h1")).toHaveText("cccccccc…dddddddd");
  release();
  await expect(page.locator(".run-header")).toContainText("audit");
  await expect(page.locator(".run-header")).not.toContainText("change");
});

for (const [status, message] of [
  [403, "You do not have permission to view this resource."],
  [404, "This resource was not found."],
  [500, "The server could not load this resource."],
  [0, "Network error:"],
]) {
  test(`run errors (${status || "network"}) offer a working retry`, async ({ page }) => {
    let failing = true;
    await page.route(`**/api/runs/${projectA}/${runA}`, (route) => {
      if (!failing) return route.fulfill({ json: detail(runA) });
      return status ? route.fulfill({ status, json: { error: "Fixture failure" } }) : route.abort("failed");
    });
    await page.goto(`/runs/${projectA}/${runA}`);
    await expect(page.getByRole("alert")).toContainText(message);
    await expect(page.getByText("Run not found", { exact: true })).toHaveCount(0);
    failing = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator(".run-header h1")).toHaveText("cccccccc…dddddddd");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

test("login restores the full deep link after authentication", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    if (route.request().headers().authorization === "Bearer fixture-token") return route.fallback();
    return route.fulfill({ status: 401, json: { error: "unauthorized" } });
  });
  const target = `/runs/${projectA}/${runA}?mode=change&q=review%20scope#session-reviewer-r1`;
  await page.goto(target);
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Access token").fill("fixture-token");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page).toHaveURL(`http://127.0.0.1:5174${target}`);
  await expect(page.locator(".run-header h1")).toBeVisible();
});

for (const width of [1100, 1240]) {
test(`inspector traps Tab and restores focus at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 700 });
  await page.goto(`/runs/${projectA}/${runA}`);
  const opener = page.getByRole("button", { name: "Open inspector" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Review inspector" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  const firstTab = dialog.getByRole("tab", { name: "Findings" });
  const close = dialog.getByRole("button", { name: "Close inspector" });
  await expect(firstTab).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(firstTab).toBeFocused();
  await expect(page.locator(".workspace-topbar")).toHaveJSProperty("inert", true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(page.locator(".workspace-topbar")).toHaveJSProperty("inert", false);
});
}

test("closing the desktop inspector restores the stream width", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/runs/${projectA}/${runA}`);
  const inspector = page.getByRole("complementary", { name: "Review inspector" });
  const stream = page.getByRole("region", { name: "Review execution stream" });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Close inspector", includeHidden: true })).toBeHidden();
  const initial = await stream.boundingBox();
  await page.locator(".run-header").getByRole("button", { name: "Close inspector" }).click();
  await expect(inspector).toBeHidden();
  await expect.poll(async () => (await stream.boundingBox()).width).toBeGreaterThan(initial.width + 300);
  await page.getByRole("button", { name: "Open inspector" }).click();
  await expect.poll(async () => (await stream.boundingBox()).width).toBe(initial.width);
});

test("mobile project, run list, and detail stay within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, ready] of [
    ["/projects", ".project-table"],
    [`/projects/${projectA}`, ".run-table"],
    [`/runs/${projectA}/${runA}`, ".run-header"],
  ]) {
    await page.goto(path);
    await expect(page.locator(ready)).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.getByRole("button", { name: "Open inspector" }).click();
  const dialog = page.getByRole("dialog", { name: "Review inspector" });
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const bounds = await dialog.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
});

test("an out-of-range offset is corrected in place instead of trapping Back", async ({ page }) => {
  await page.route("**/api/projects/*/runs?*", async (route) => {
    route.fulfill({ json: { runs: [run(runA), run(runB, "audit")], total: 200 } });
  });
  await page.goto("/projects");
  await page.locator(`.sidebar-project-link[href='/projects/${projectA}']`).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectA}$`));
  // The bad offset is replaced, not pushed, so two Backs still leave the page.
  await page.goto(`/projects/${projectA}?offset=4000`);
  await expect(page).toHaveURL(new RegExp(`/projects/${projectA}\\?offset=150$`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectA}$`));
  await page.goBack();
  await expect(page).toHaveURL(/\/projects$/);
});

test("paging refreshes the rows in place so the pager keeps keyboard focus", async ({ page }) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let defer = false;
  await page.route("**/api/projects/*/runs?*", async (route) => {
    if (defer) await pending;
    const offset = Number(new URL(route.request().url()).searchParams.get("offset") ?? 0);
    route.fulfill({ json: { runs: [offset === 0 ? run(runA) : run(runB, "audit")], total: 200 } });
  });
  await page.goto(`/projects/${projectA}`);
  const older = page.getByRole("button", { name: "Older runs" });
  await older.focus();
  await expect(older).toBeFocused();
  defer = true;
  await older.click();
  // Mid-flight: the previous rows and the pager stay mounted, and the control
  // that was activated is still the focused element.
  await expect(page.locator(".run-table")).toBeVisible();
  await expect(page.getByText("Updating…")).toBeVisible();
  await expect(older).toBeFocused();
  release();
  await expect(page).toHaveURL(/offset=50/);
  await expect(page.locator(".run-table")).toContainText("audit");
  await expect(older).toBeFocused();
});

test("drawer focus returns to the toggle when history swaps the run underneath", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto(`/runs/${projectA}/${runA}`);
  await page.locator(`.sidebar-run[href='/runs/${projectA}/${runB}']`).click();
  await expect(page.locator(".run-header h1")).toHaveText("cccccccc…dddddddd");
  await page.getByRole("button", { name: "Open inspector" }).click();
  await expect(page.getByRole("dialog", { name: "Review inspector" })).toBeVisible();
  // Browser history can swap the run while the modal drawer is open, which
  // unmounts the opener the trap saved.
  await page.goBack();
  await expect(page.locator(".run-header h1")).toHaveText("cccccccc…dddddddd");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Review inspector" })).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("BUTTON");
});

test("a failed finding detail offers retry and keeps the error state", async ({ page }) => {
  const summary = { id: "f1", displayId: "F-1", title: "Off-by-one", category: "logic", severity: "P1", status: "confirmed", round: 1, createdAt: 1, evidenceCount: 1, confidence: 0.8 };
  const detail = { ...summary, claim: "The loop overruns by one.", trigger: "diff", featureKey: null, entityKey: null, anchors: [], evidence: [], memoryMatches: [], verifierRationale: "checked", relatedSessions: [] };
  let failing = true;
  await page.route("**/api/runs/*/*", (route) => route.fulfill({ json: { run: run(runA), findings: { items: [summary], total: 1 }, sessions: [], manifest: null, transcriptsAvailable: false } }));
  await page.route("**/api/runs/*/*/findings/f1", (route) => failing
    ? route.fulfill({ status: 500, json: { error: "boom" } })
    : route.fulfill({ json: detail }));
  await page.goto(`/runs/${projectA}/${runA}`);
  const row = page.locator(".finding-row").first();
  await row.getByRole("button").first().click();
  await expect(row.getByRole("button", { name: "Retry" })).toBeVisible();
  failing = false;
  await row.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("The loop overruns by one.")).toBeVisible();
});

test("typing in the run search keeps every keystroke and lands one URL entry", async ({ page }) => {
  await page.goto(`/projects/${projectA}`);
  const search = page.getByRole("searchbox", { name: "Search this page" });
  await search.type("scope", { delay: 40 });
  await expect(search).toHaveValue("scope");
  await expect(page).toHaveURL(/q=scope/);
  await expect(page).not.toHaveURL(/q=sc(?!ope)/);
});
