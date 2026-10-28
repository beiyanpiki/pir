import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { projectA, run } from "./fixtures.js";

const liveRun = "22222222-3333-4444-5555-666666666666";

const liveDetail = {
  run: run({ runId: liveRun, status: "running", finishedAt: null, runVerdict: null, incomplete: false, confirmed: 0, rejected: 0, uncertain: 0, stoppedBecause: null, durationMs: null, lastUpdatedAt: 1 }),
  findings: { items: [], total: 0 },
  manifest: null,
  sessions: [],
  transcriptsAvailable: true,
  live: { runId: liveRun, projectId: projectA, mode: "change", base: "c".repeat(40), head: "d".repeat(40), model: null, startedAt: 1, lastEventAt: 1, sessions: [], events: [], end: null },
};

let streams;
let sseServer;
let sseOrigin;

function frame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function send(index, payload) {
  const response = streams?.filter((stream) => !stream.destroyed && !stream.writableEnded)[index ?? 0];
  if (response) response.write(frame(payload));
}

test.beforeEach(async ({ page }) => {
  streams = [];
  sseServer = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.flushHeaders();
    streams.push(response);
    response.write(frame({ kind: "ready", runId: liveRun }));
  });
  await new Promise((resolve) => sseServer.listen(0, "127.0.0.1", resolve));
  sseOrigin = `http://127.0.0.1:${sseServer.address().port}`;

  await page.route("**/api/overview", (route) => route.fulfill({ json: { projects: [{ projectId: projectA, name: "Fixture", remote: null, runsTotal: 1, lastRunAt: 1, lastRunStatus: "running", openFindings: 0, namedInRegistry: true }], active: [{ runId: liveRun, projectId: projectA, mode: "change", head: "d".repeat(40), model: null, startedAt: 1, sessions: 1 }] } }));
  await page.route("**/api/runs/*/*/coverage", (route) => route.fulfill({ json: { mode: "change", available: false, reason: "not-recorded" } }));
  await page.route("**/api/runs/*/*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.split("/").length > 5) return route.fallback();
    route.fulfill({ json: liveDetail });
  });
  await page.route("**/api/events?*", (route) => {
    const url = new URL(route.request().url());
    route.continue({ url: sseOrigin + url.pathname + url.search });
  });
});

test.afterEach(async () => {
  for (const stream of streams ?? []) stream.destroy();
  sseServer?.closeAllConnections();
  await new Promise((resolve) => sseServer?.close(resolve) ?? resolve());
});

test("live progress recalibrates counts and keeps connection separate from execution", async ({ page }) => {
  await page.goto(`runs/${projectA}/${liveRun}?tab=overview`);
  await expect(page.getByRole("heading", { name: "Review in progress" })).toBeVisible();
  await expect(page.getByText("Live", { exact: true }).first()).toBeVisible();

  send(0, { kind: "progress", seq: 1, ts: Date.now(), runId: liveRun, projectId: projectA, phase: "verify", round: 1, message: "Verifying F-101", roundInfo: { round: 1, candidates: 1, fresh: 1, confirmed: 1, rejected: 0, uncertain: 1, pending: 1, summary: "Verifying" } });
  await expect(page.getByText("In progress · verify")).toBeVisible();
  await expect(page.locator(".ant-statistic").filter({ hasText: "Confirmed" }).first()).toContainText("1");
  await expect(page.getByText("Verifying F-101", { exact: true })).toBeVisible();

  send(0, { kind: "run-end", seq: 2, ts: Date.now(), runId: liveRun, projectId: projectA, status: "completed", stoppedBecause: "reviewer signaled completion", durationMs: 1000, counts: { rounds: 1, candidates: 1, confirmed: 2, rejected: 0, uncertain: 0, pending: 0 }, findings: [] });
  await expect(page.getByRole("heading", { name: "Review finished" })).toBeVisible();
  await expect(page.locator(".ant-statistic").filter({ hasText: "Confirmed" }).first()).toContainText("2");
});

test("a failed observation stream does not mark a running review interrupted", async ({ page }) => {
  await page.unroute("**/api/events?*");
  await page.route("**/api/events?*", (route) => route.abort());
  await page.goto(`runs/${projectA}/${liveRun}?tab=overview`);
  await expect(page.getByText("Live observation is not connected")).toBeVisible();
  await expect(page.getByText("Interrupted")).toHaveCount(0);
  await expect(page.getByText("Running", { exact: true })).toBeVisible();
  await expect(page.getByText("In progress", { exact: false }).first()).toBeVisible();
});