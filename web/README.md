# pir web — Ant Design X review workspace

The browser workspace served by `pir serve --web` (or `PIR_WEB_UI=1`) at **`/`**. It is a Vite build (`dist/web`) and a full rewrite of the pages, navigation, and run views on [Ant Design X](https://ant-design-x.antgroup.com/) and Ant Design 6.

## What the rewrite changed

- **Read the review, not just the log.** The run page answers scope, phase, conclusion, completeness, coverage, and cost before showing raw sessions. Overview / Findings / Workflow / Coverage / Details are URL-backed tabs.
- **Session identity is `projectId + runId + session`.** A live replay and its persisted transcript reconcile to one session card; changing runs remounts the workflow and cannot reuse the previous transcript.
- **Execution and observation are independent.** A lost SSE stream never marks a running review interrupted; REST is recalibrated at replay start, round end, verifier end, and run end, with the connection state shown separately.
- **Findings are actionable by default.** The list opens on confirmed + uncertain results; rejected candidates and the full candidate pool stay one switch away. The evidence drawer is an accessible Ant Design Drawer (Escape, focus trap, focus return).
- **Coverage uses the engine's real schema.** Change coverage reads hunks/files; audit coverage reads files, batches, units, and blocked/failed states. Unknown is shown as unknown, never 0.
- **The URL is the state.** Project, run, tab, finding, session, filters, search, and pagination survive reload, back/forward, and sharing.
- **Responsive by construction.** Lists become cards on phones, the project navigation becomes a drawer, workflow filters move above the sessions, and wide tables scroll inside their own container.

## Ant Design X usage

- `XProvider` supplies the light/dark theme and Ant Design tokens.
- `Bubble.List` renders persisted and live session messages.
- `ThoughtChain` renders tool calls and results, with diff-aware output for `get_change`.
- `Conversations` is the desktop session index, grouped by round.
- `Welcome` covers empty workspaces; `Prompts` offers the run page's next navigation steps.
- `XMarkdown` renders streamed assistant prose safely.

## Layout

```
src/
  lib/            API client, hooks, pure live fold/projection, transcript and diff parsing
  components/     shell pieces, findings drawer, coverage, workflow, transcript, diff view
  layout/         workspace header + project navigation
  pages/          Projects, Runs, Run detail, project knowledge, Compare, Login
```

## Dev workflow

```bash
# API + state (loopback may run without a viewer token)
PIR_WEB_UI=1 PIR_ALLOW_HTTP=1 PIR_CERT_DIR=$(mktemp -d) \
PIR_STATE_ROOT=/path/to/state node ../dist/cli/cli.js serve --host 127.0.0.1 --port 8790

# Vite dev server on http://127.0.0.1:5173/ (proxies /api → 8790)
npm run dev -w web
```

Production output is `dist/web`; `npm run build` from the repository root builds it, and `pir serve` serves it statically with SPA fallback.

## Browser regressions

```bash
npx playwright install chromium
npm run test:web:e2e
```

The suite mocks the API, so no pir server or model credentials are needed. It covers deep-link auth recovery, URL-backed list state, cross-project reset, mobile card links and overflow, live count recalibration, connection loss vs. execution failure, same-file transcript isolation across runs, the finding drawer's Escape/focus behavior, and the audit coverage schema. Set `PIR_WEB_E2E_PORT` (default 5174) to change the dev-server port.
