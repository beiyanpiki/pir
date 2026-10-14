# pir web — read-only run explorer

The browser UI served by `pir serve --web` (or `PIR_WEB_UI=1`). It visualizes
review runs grouped by project: one run per review request, each expandable
into the full execution timeline — reviewer rounds, per-candidate verifier
sessions, prompts, thinking, markdown answers and every tool call with its
result. It is read-only by construction: the `/api` surface is GET-only and
never touches the command executor.

## Layout

```
src/
  api.ts          fetch client (PIR_WEB_UI_TOKEN in localStorage → header)
  hooks.ts        useApi (fetch + 401→login), useRunEvents (fetch-based SSE)
  types.ts        API DTOs + SDK transcript message shapes
  pages/          LoginPage, ProjectsPage, RunsPage, RunDetailPage
  components/     Markdown (marked + DOMPurify), CodeBlock (highlight.js),
                  badges, findings, coverage
  components/session/   timeline, transcript rendering, live derivation
  layout/Sidebar.tsx    project list, active-run pills, 15s polling
```

## Dev workflow

Two terminals:

```bash
# 1. the API + state (loopback may run without a token):
PIR_WEB_UI=1 PIR_ALLOW_HTTP=1 PIR_CERT_DIR=$(mktemp -d) \
PIR_STATE_ROOT=/path/to/state node ../dist/cli/cli.js serve --host 127.0.0.1 --port 8790
#    (PIR_CERT_DIR trick: a fresh empty dir makes serve generate a new
#     self-signed pair; with PIR_ALLOW_HTTP=1 it falls back to plain HTTP
#     when you prefer http://127.0.0.1:8790)

# 2. vite dev server (proxies /api → 8790):
npm run dev
```

Then open http://localhost:5173/. Sign in with the token (`PIR_WEB_UI_TOKEN`,
or anything if the server runs tokenless on loopback).

Production output is built into `../dist/web` (`npm run build` from the repo
root chains it); `pir serve` serves it statically with SPA fallback.

## Navigation and recovery

The run list stores status, mode, search, and pagination in the URL. Route changes cancel pending loads, and Retry reloads failed pages. Authentication returns to the original path, query, and fragment. Below 1280px, the run inspector opens as a modal drawer: Tab stays inside, Escape closes it, and focus returns to the opener. On desktop, closing the inspector gives its space back to the timeline.

Live runs display execution and connection separately: a disconnected stream does not mark a review interrupted. The timeline reconnects and recalibrates persisted findings after verifier sessions and rounds finish. Workflow filters, selected sessions, and findings are shareable URL state. Sessions use transcript identity across live and archived views; finding links show runtime-to-project ID mappings. Selecting a historical session pauses following until Jump to latest is used.

## Browser regressions

Run these commands from the repository root. Playwright uses its managed Chromium, installed for the version in the lockfile. The suite mocks the API, so no running pir server or model credentials are needed.

```bash
npx playwright install --with-deps chromium
npm run test:web:e2e
```

Coverage includes route cancellation, transcript identity, error retries, deep-link login recovery, drawer focus, desktop width, and mobile overflow. Failure screenshots and traces default to `/tmp/pir-web-live-artifacts`; the HTML report defaults to `/tmp/pir-web-live-report`. Override these with `PIR_WEB_ARTIFACT_DIR` and `PIR_WEB_REPORT_DIR`. `PIR_WEB_BROWSER_PATH` selects an installed Chromium and `PIR_WEB_TEST_PORT` selects the Vite port. CI installs Chromium before running the same command.

## Data sources

- `GET /api/overview` — projects + active runs
- `GET /api/projects/:id/runs` — paginated run list
- `GET /api/runs/:projectId/:runId` — run row + findings + run.json manifest
  (+ live snapshot when the run is active in this serve process)
- `GET /api/runs/:projectId/:runId/transcript/:file` — one session transcript
- `GET /api/events?runId=` — SSE: buffered replay then live events

See `src/server/web-store.ts` and `src/server/web.ts` in the root package for
the server side, and `src/observability/run-events.ts` for the event shapes.
