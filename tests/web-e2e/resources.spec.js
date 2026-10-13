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
    const item = run(parts[4], parts[4] === runB ? "audit" : "change");
    route.fulfill({ json: { run: item, findings: { items: [], total: 0 }, sessions: [], manifest: null } });
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

test("inspector acts as a modal drawer on tablet and restores focus", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(`/runs/${projectA}/${runA}`);
  const opener = page.getByRole("button", { name: "Open inspector" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Review inspector" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});
