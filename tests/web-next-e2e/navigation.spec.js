import { test, expect } from "@playwright/test";
import { detail, projectA, projectB, projects, run, runA, runB } from "./fixtures.js";

function history(page) {
  const requests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/runs")) requests.push(url);
  });
  return requests;
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/overview", (route) => route.fulfill({ json: { projects, active: [] } }));
  await page.route("**/api/projects/*/runs?*", (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/")[3];
    const rows = id === projectA
      ? [run({ runId: runA }), run({ runId: runB, mode: "audit", base: null })]
      : [run({ runId: runB })];
    const status = url.searchParams.get("status");
    const mode = url.searchParams.get("mode");
    const q = url.searchParams.get("q");
    const filtered = rows.filter((row) =>
      (!status || row.status === status) &&
      (!mode || row.mode === mode) &&
      (!q || [row.runId, row.head, row.model ?? ""].some((value) => value.toLowerCase().includes(q.toLowerCase())))
    );
    route.fulfill({ json: { runs: filtered, total: filtered.length } });
  });
  await page.route("**/api/runs/*/*/coverage", (route) => route.fulfill({ json: { mode: "change", available: false, reason: "not-recorded" } }));
  await page.route("**/api/runs/*/*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.split("/").length > 5) return route.fallback();
    route.fulfill({ json: detail(url.pathname.split("/")[4]) });
  });
});

test("run filters and search live in the URL and cross-project navigation resets paging", async ({ page }) => {
  const requests = history(page);
  await page.goto("projects");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

  await page.getByRole("link", { name: "Project A" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/next/projects/${projectA}$`));

  await page.locator(".ant-segmented-item").filter({ hasText: "Completed" }).click();
  await expect(page).toHaveURL(/status=completed/);
  await expect.poll(() => [...requests].reverse().find((url) => url.pathname.includes(projectA))?.searchParams.get("status")).toBe("completed");

  const search = page.getByPlaceholder(/Search this project/);
  await search.fill("zzz");
  await expect(page).toHaveURL(/q=zzz/);
  await expect.poll(() => [...requests].reverse().find((url) => url.pathname.includes(projectA))?.searchParams.get("q")).toBe("zzz");
  await expect(page.getByText("No runs match this search")).toBeVisible();

  // A direct URL is the complete state: filters, query, and paging.
  await page.goto(`projects/${projectA}?status=completed&mode=audit&q=none`);
  await expect(page.locator(".ant-segmented-item-selected")).toContainText("Completed");
  await expect(page.getByPlaceholder(/Search this project/)).toHaveValue("none");

  // Cross-project navigation must not carry Project A's offset into Project B.
  await page.goto(`projects/${projectA}?offset=50`);
  await expect(page).toHaveURL(new RegExp(`/next/projects/${projectA}`));
  await page.locator(".pir-sider-project").filter({ hasText: "Project B" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/next/projects/${projectB}$`));
  await expect.poll(() => [...requests].reverse().find((url) => url.pathname.includes(projectB))?.searchParams.get("offset")).toBe("0");
});