import { test, expect } from "@playwright/test";
import { projectA, projects, run } from "./fixtures.js";

test("a 401 preserves the full deep link through login", async ({ page }) => {
  let authorized = false;
  await page.route("**/api/**", (route) => {
    if (route.request().headers()["authorization"] !== "Bearer secret") {
      return route.fulfill({ status: 401, json: { error: "missing or invalid bearer token" } });
    }
    authorized = true;
    const url = new URL(route.request().url());
    if (url.pathname === "/api/overview") return route.fulfill({ json: { projects, active: [] } });
    if (url.pathname.endsWith("/runs")) return route.fulfill({ json: { runs: [run()], total: 1 } });
    if (url.pathname.includes("/coverage")) return route.fulfill({ json: { mode: "change", available: false, reason: "not-recorded" } });
    return route.fulfill({ json: {} });
  });

  await page.goto(`projects/${projectA}?status=completed#run-list`);
  await expect(page).toHaveURL(/\/login/);

  await page.locator('input[type="password"]').fill("secret");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectA}\\?status=completed#run-list`));
  await expect(page.getByRole("heading", { name: "Project A" })).toBeVisible();
  expect(authorized).toBe(true);
});
