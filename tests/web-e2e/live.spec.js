import { test, expect } from "@playwright/test";
import { createServer } from "node:http";

const projectId = "a".repeat(64);
const runId = "11111111-2222-3333-4444-555555555555";
const otherRun = "99999999-2222-3333-4444-555555555555";
const projects = [{ projectId, name: "Live fixture", remote: null, runsTotal: 2, lastRunAt: 1, lastRunStatus: "running", openFindings: 0, namedInRegistry: true }];
const run = (id = runId) => ({ runId: id, mode: "change", base: "c".repeat(40), head: "d".repeat(40), startedAt: 1, finishedAt: null, status: "running", rounds: 1, candidates: 0, confirmed: 0, rejected: 0, uncertain: 0, notes: null, model: null, durationMs: null, totalTokens: null, cost: null, transcriptsAvailable: true });
const snapshot = (id = runId, sessions = []) => ({ run: run(id), findings: { items: [], total: 0 }, sessions, manifest: null, live: { runId: id, projectId, mode: "change", base: "c".repeat(40), head: "d".repeat(40), model: null, startedAt: 1, lastEventAt: 1, sessions: [], end: null } });
const event = (kind, seq, extra = {}, id = runId) => ({ kind, seq, ts: seq, runId: id, projectId, ...extra });
const start = (id, seq, file, kind = "reviewer", rid = runId) => event("session-start", seq, { sessionId: id, sessionKind: kind, role: kind, model: "fixture", round: 1, transcriptFile: file, prompt: `Goal ${id}`, ...(kind === "verifier" ? { displayId: "F-1" } : {}) }, rid);
let server;
let origin;
let streams = [];
let unauthorized = false;

function send(response, data) { response.write(`data: ${JSON.stringify(data)}\n\n`); }
async function mount(page, detail = snapshot()) {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.route("**/api/projects/*/runs?*", (route) => route.fulfill({ json: { runs: [], total: 0 } }));
  await page.route("**/api/overview", (route) => route.fulfill({ json: { projects, active: [] } }));
  await page.route("**/api/events?*", (route) => route.continue({ url: `${origin}${new URL(route.request().url()).pathname}${new URL(route.request().url()).search}` }));
  await page.route("**/api/runs/*/*", async (route) => route.fulfill({ json: typeof detail === "function" ? await detail(route) : detail }));
  await page.goto(`/runs/${projectId}/${runId}?tab=workflow`);
  if (!unauthorized) await expect(page.locator(".run-title-line")).toContainText("live");
}

async function streamFor(id = runId, index = 0) {
  await expect.poll(() => streams.filter((stream) => stream.runId === id).length).toBeGreaterThan(index);
  return streams.filter((stream) => stream.runId === id && !stream.response.destroyed && !stream.response.writableEnded).at(-1)?.response ?? streams.filter((stream) => stream.runId === id)[index].response;
}

test.beforeEach(async () => {
  streams = [];
  unauthorized = false;
  server = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    if (unauthorized) { response.writeHead(401); response.end(); return; }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.flushHeaders();
    streams.push({ runId: new URL(request.url, "http://fixture").searchParams.get("runId"), response });
    send(response, { kind: "ready", runId: streams.at(-1).runId });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test("switching runs accepts the next run's lower sequence and never leaks old sessions", async ({ page }) => {
  await mount(page, (route) => snapshot(new URL(route.request().url()).pathname.split("/")[4]));
  const first = await streamFor();
  send(first, start("old", 90, "old.json"));
  send(first, event("session-delta", 91, { sessionId: "old", deltaType: "text", text: "OLD SESSION" }));
  await expect(page.locator(".session-timeline")).toContainText("OLD SESSION");
  await page.evaluate((url) => { history.pushState({}, "", url); dispatchEvent(new PopStateEvent("popstate")); }, `/runs/${projectId}/${otherRun}?tab=workflow`);
  const second = await streamFor(otherRun);
  send(second, start("new", 1, "new.json", "reviewer", otherRun));
  send(second, event("session-delta", 2, { sessionId: "new", deltaType: "text", text: "NEW SESSION" }, otherRun));
  await expect(page.locator(".session-timeline")).toContainText("NEW SESSION");
  await expect(page.locator(".session-timeline")).not.toContainText("OLD SESSION");
});

test("round and verifier calibration preserves timeline and deduplicates durable sessions", async ({ page }) => {
  let requests = 0;
  let hold = false;
  let pending;
  let detail = snapshot();
  await mount(page, async () => {
    requests += 1;
    if (hold) await new Promise((resolve) => { pending = resolve; });
    return detail;
  });
  const baseline = requests;
  const connection = await streamFor();
  send(connection, start("s", 1, "/fixture/v.json", "verifier"));
  send(connection, event("session-delta", 2, { sessionId: "s", deltaType: "text", text: "Stable live text" }));
  await expect(page.locator(".session-timeline")).toContainText("Stable live text");
  hold = true;
  detail = snapshot(runId, [{ file: "v.json", sessionKind: "verifier", round: 1, displayId: "F-1", findingIdMap: [{ from: "F-1", to: "F-201" }] }]);
  send(connection, event("session-end", 3, { sessionId: "s" }));
  send(connection, event("progress", 4, { phase: "round-end", round: 1, message: "round ended" }));
  await expect.poll(() => requests).toBe(baseline + 1);
  await expect(page.locator(".session-timeline")).toContainText("Stable live text");
  await expect(page.getByText("Loading review run…")).toHaveCount(0);
  pending();
  hold = false;
  await expect(page.locator(".workflow-session")).toHaveCount(1);
  await expect(page.locator(".session-rail .session-link")).toHaveCount(1);
  await expect(page.locator(".session-flow-section")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "F-1 → F-201", exact: true })).toBeVisible();
});

test("reconnect recalibrates once, ignores replayed events and preserves execution on unavailable", async ({ page }) => {
  let detailRequests = 0;
  await mount(page, () => { detailRequests += 1; return snapshot(); });
  const connection = await streamFor();
  send(connection, start("s", 1, "s.json"));
  send(connection, event("session-delta", 2, { sessionId: "s", deltaType: "text", text: "Only once" }));
  await expect(page.locator(".session-timeline")).toContainText("Only once");
  const baseline = detailRequests;
  connection.end();
  const reconnected = await streamFor(runId, 1);
  send(reconnected, start("s", 1, "s.json"));
  send(reconnected, event("session-delta", 2, { sessionId: "s", deltaType: "text", text: "Only once" }));
  await expect.poll(() => detailRequests).toBe(baseline + 1);
  await expect(page.locator(".session-flow-section")).toHaveCount(1);
  send(reconnected, { kind: "unavailable", runId });
  await expect(page.getByText("Live connection unavailable. Run state is awaiting confirmation.")).toBeVisible();
  await expect(page.locator(".run-title-line")).toContainText("running");
  await expect(page.locator(".run-title-line")).not.toContainText("interrupted");
});

test("every rail item has a durable anchor and history selection pauses following", async ({ page }) => {
  await mount(page);
  const connection = await streamFor();
  for (let i = 0; i < 3; i += 1) {
    send(connection, start(`s${i}`, i * 2 + 1, `s${i}.json`));
    send(connection, event("session-delta", i * 2 + 2, { sessionId: `s${i}`, deltaType: "text", text: Array.from({ length: 30 }, (_, n) => `Paragraph ${i}-${n}.\n\n`).join("") }));
  }
  await expect(page.locator(".session-rail .session-link")).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) {
    await page.locator(".session-rail .session-link").nth(i).click();
    await expect(page).toHaveURL(new RegExp(`session=persisted%3As${i}\\.json`));
    await expect(page.locator(".session-flow-section").nth(i)).toHaveAttribute("id", `session-persisted%3As${i}.json`);
  }
  await page.locator(".session-rail .session-link").first().click();
  const position = await page.locator(".run-scroll").evaluate((node) => node.scrollTop);
  send(connection, event("session-delta", 7, { sessionId: "s2", deltaType: "text", text: "\n\nNew output while reading history." }));
  await expect(page.locator(".session-timeline")).toContainText("New output while reading history.");
  await expect.poll(() => page.locator(".run-scroll").evaluate((node, previous) => Math.abs(node.scrollTop - previous), position)).toBeLessThan(5);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect.poll(() => page.locator(".run-scroll").evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(5);
});

test("SSE 401 returns to login with the session URL preserved", async ({ page }) => {
  unauthorized = true;
  await mount(page);
  await expect(page).toHaveURL(/\/login$/);
  await expect.poll(() => page.evaluate(() => history.state.usr?.from)).toBe(`/runs/${projectId}/${runId}?tab=workflow`);
});
