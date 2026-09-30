# pir — pi-based code review with Repository Memory

[![ci](https://github.com/beiyanpiki/pir/actions/workflows/ci.yml/badge.svg)](https://github.com/beiyanpiki/pir/actions/workflows/ci.yml)
[![docker](https://github.com/beiyanpiki/pir/actions/workflows/docker.yml/badge.svg)](https://github.com/beiyanpiki/pir/actions/workflows/docker.yml)

`pir` is a code-review engine built on [Pi](https://github.com/earendil-works/pi).
It does exactly one thing: **find problems introduced by the current change,
as accurately as possible, and use project history to stop repeating itself.**
No GitHub integration, no PR comments, no CI gates, no auto-fixes — structured
findings in, structured findings out.

> **中文文档**:[docs/README.zh-CN.md](docs/README.zh-CN.md)

## Highlights

- **Reviewer → Verifier loop, from scratch.** A read-only reviewer session
  explores the diff and must emit candidates through a structured tool
  (`record_candidate`); reported findings pass through an isolated verifier
  and retain an explicit confirmed/uncertain status. Unverified candidates
  remain in a separate pending queue rather than disappearing at budget limits.
- **Repository Memory that actually changes behavior.** Five layers (project /
  feature / code entity / issue decisions / finding resolutions) in SQLite.
  Tell it once that `retry_count` intentionally counts attempts — the same
  issue stops being reported, **and a verifier re-validates that decision
  against current code every time**, reopening it when reality changes.
- **Trust boundaries by design.** Agents can never write decision memories
  (`expected` / `wont-fix` / `false-positive` come only from users or verified
  fixes); the reviewer never sees historical decisions (no bias), only the
  verifier does; memory is injected as *evidence, not instructions*.
- **Reviews what you have, not what you pushed.** CodeRabbit-CLI-style: the
  client ships its local state as a git bundle — unpushed commits and even
  *uncommitted* working trees (`--uncommitted`) review fine; the server needs
  no credentials for your origin.
- **Machine-first CLI.** stdout is pure JSON (`schemaVersion:1` envelope),
  progress goes to stderr, exit codes are contract (`0` ok, `1` findings ≥
  `--fail-on`, `2` usage, `3` runtime). Build agent pipelines on it directly.
- **One package, three faces.** Local CLI (`pir`), Pi extension
  (`/review-find`, `/review-memory`, `/review-feedback`, `/review-remember`),
  HTTPS service (`pir serve`) — all sharing one command path.
- **Lean core.** Runtime dependencies: the Pi SDK + typebox. Storage is
  `node:sqlite`. Optional [codegraph](https://www.npmjs.com/package/@colbymchenry/codegraph)
  for symbol-level structure (graceful degradation without it).

## Architecture

```
Pi extension (/review-*)        pir CLI ── remote (--server) ──┐
        └────────────┬─────────────────────┘                  │
                  src/app  (single command path: executor)    │
                     │                                       │
   ┌─────────────────┼───────────────────────────┐           │
   │ core: supervisor / frontier / budget        │        HTTPS
   │ changes: git / diff / worktree snapshots    │      POST /v1/review
   │ findings: fingerprint / dedup               │◄─────────┘
   │ codemap: codegraph CLI adapter / degraded   │   (client ships a git
   │ memory: SQLite five-layer + feedback        │    bundle of its local
   └─────────────────┬───────────────────────────┘    state)
                     │
        agents: one-shot in-memory sessions
        (read-only builtins + structured collector tools;
         reviewer never sees historical decisions — verifier does)
```

Key invariants:

- `projectId = sha256(normalizedRemote + rootCommit)` — memory follows the
  repository across machines and paths. **Branches never key memory**;
  invariants and decisions are repo-level knowledge.
- Sessions are disposable (`SessionManager.inMemory()` + `dispose()`);
  everything durable lives in SQLite, never in chat history.
- Server-side reviews run in throwaway `git worktree`s; state concentrates
  under `PIR_STATE_ROOT/<projectId>/`.

## Installation

**npx — straight from GitHub, no npm publish, no install:**

```bash
npx -y github:beiyanpiki/pir find --json
# or keep it:                       (Node >= 22.5; the git install builds itself)
npm i -g github:beiyanpiki/pir     # provides `pir`
```

CI builds and smoke-tests this exact package on every push (`package` job in
[ci.yml](.github/workflows/ci.yml)), uploads it as a workflow artifact, and
attaches `pir-<version>.tgz` to the GitHub release on `v*` tags for pinned
installs.

On the first interactive run `pir` starts a short setup wizard and writes
`~/.pir/config.json` (chmod 600): **local mode** (default — review in the
current repo with this machine's pi credentials) or **remote mode** (forward
everything to a `pir serve` instance; repo commands — `find`, `audit` and the
`memory`/`findings`/`feedback`/`remember`/`verify-fix` family — ship your
local state as a git bundle, so unpushed/uncommitted code reviews fine).
Non-interactive runs fall
back to local defaults with a one-line hint. Manage later:

```bash
pir config show                                   # effective config (token masked)
pir config set mode remote                        # + server.url / server.token / server.insecure
pir config wizard                                 # re-run the setup wizard
pir --local find --json                           # one-off override, either direction
pir --server https://pir.svc:8790 --token T --insecure find --uncommitted --json
```

**Long remote tasks:** the server runs commands serially, and a remote find or
audit can legitimately take many minutes — the client waits up to 30 minutes
for an answer, overriding Node/undici's 5-minute default that used to abort
longer tasks with a bare `fetch failed`. Raise, lower or disable the wait with
`PIR_REMOTE_TIMEOUT` (seconds; `0` = no limit), e.g. `PIR_REMOTE_TIMEOUT=7200`
for hour-scale audits.

**Memory sync (local ⇄ server):** memories accumulated on your machine and on
a `pir serve` instance are separate SQLite DBs keyed by the same projectId.
`pir memory sync` merges them bidirectionally — both sides converge, and rows
describing the same logical record (same feature key, symbol key, or finding
fingerprint) collapse onto the winning replica's rows. On a conflicting record
the newer write wins, and user knowledge (`user_explicit` / `verified_fix`)
always beats agent summaries regardless of timestamps. The command always runs
locally (even in remote mode) and takes `--dry-run`:

```bash
pir memory sync --server https://pir.svc:8790 --token T --insecure --json
pir memory sync --dry-run                         # report what would change
```

**Skill for your coding agent:** `pir skill install` drops a ready-made
LLM skill (`skills/pir/SKILL.md` in this repo) into `~/.agents/skills/pir/`,
teaching the agent when and how to drive the CLI — install, modes, JSON
protocol, feedback loop, troubleshooting. `pir skill print` dumps it for any
other agent framework.

**Docker (recommended for the service side):**

```bash
docker pull ghcr.io/beiyanpiki/pir:main
# interactive QA deployment of the HTTPS service:
sh docker/deploy.sh          # asks token / provider+model+key / port / TLS, then verifies
```

**From a checkout (extension + CLI):**

```bash
npm i -g .                   # provides `pir`
pi install $(pwd)            # Pi extension: /review-* commands
```

**Model access (any pi provider):** pir runs on every provider Pi supports —
anthropic, openai, google, deepseek, moonshotai, zai-coding-cn, minimax,
openrouter, xai, groq, and the rest of the catalog. Browse it:

```bash
pir models                   # models you have credentials for
pir models --all glm         # full catalog, fuzzy-filtered
pir models --ids --provider deepseek   # one provider/model per line
```

Store credentials in `~/.pi/agent/auth.json` (chmod 600), one entry per
provider:

```jsonc
{
  "zai-coding-cn": { "type": "api_key", "key": "<your bigmodel key>" },
  "anthropic": { "type": "api_key", "key": "sk-ant-..." }
}
```

and default the model in `~/.pi/agent/settings.json`
(`defaultProvider`/`defaultModel`/`defaultThinkingLevel`). Precedence for the
review/verify sessions: `--model <provider>/<model>` flag (fuzzy ids work) >
`PIR_MODEL` env > `~/.pir/config.json` `model` > pi settings. In Docker, inject credentials per provider
instead: `-e PI_API_KEY__deepseek=sk-...` (or `PI_AUTH_JSON` with the full
map) plus `PI_DEFAULT_PROVIDER`/`PI_DEFAULT_MODEL` for the default.

## Web UI (read-only run explorer)

`pir serve` can host a browser UI that visualizes every review run: projects
in the sidebar, one run per review request, and the full execution timeline —
each reviewer round and per-candidate verifier session with prompts,
thinking, markdown output, and every tool call (arguments + results). It is
strictly read-only: there is no way to start a review from the browser.

```bash
PIR_WEB_UI=1 PIR_WEB_UI_TOKEN=<viewer-token> pir serve --web   # https://<host>:8790/
```

- **Off by default.** `PIR_WEB_UI=1` (or `--web`) mounts the UI at `/`;
  the JSON API (`/v1/*`, `/health`) is untouched and `/api/*` never reaches
  the executor. Mutating verbs on `/api` answer 405.
- **Separate viewer token.** The UI uses `PIR_WEB_UI_TOKEN`, independent of
  `PIR_SERVER_TOKEN`, so view access can be handed out without executor
  access. Without a token the UI only opens on loopback binds.
- **Live + historical.** Runs executing in the serve process stream live
  (thinking/tool calls over SSE); finished runs are replayed from their
  transcripts. Runs from before `PIR_TRANSCRIPTS` still show findings from
  repository memory, with a note that no timeline exists. Local CLI runs
  (other processes) appear after they finish — live view covers serve-executed
  runs only.
- **Transcripts auto-enable.** With the UI on, `PIR_TRANSCRIPTS` defaults to
  `1` (set `0` to opt out); each run also records a `run.json` manifest
  (rounds, plugins, usage, coverage) next to its transcripts.
- In docker-compose: set `PIR_WEB_UI=1` and `PIR_WEB_UI_TOKEN` in `.env`.

The SPA builds from `web/` (React + Vite, no runtime dependencies) into
`dist/web`; see [web/README.md](web/README.md) for the dev workflow
(`npm run dev:web` proxies `/api` to a local `pir serve`).

## For LLMs

Deploying or operating pir on a user's behalf? Read
**[docs/for-llm.md](docs/for-llm.md)** — a deterministic guide with the exact
QA checklist for deployment configuration (token, API key, port, TLS), docker
commands, verification steps, the JSON contract, and a troubleshooting table.
The interactive equivalent ships as `docker/deploy.sh`.

## For humans

| Document | What's inside |
|---|---|
| [docs/README.zh-CN.md](docs/README.zh-CN.md) | 完整中文说明(功能、架构、安装、协议) |
| [docs/for-llm.md](docs/for-llm.md) | Agent-facing deployment & usage guide |
| [docs/design.md](docs/design.md) | Full architecture reference for developers |
| [docs/review-loop.md](docs/review-loop.md) | Evidence snapshots, pending candidates, isolation, usage, and evaluation |

## Quick start

```bash
pir find --json --fail-on P1          # review HEAD^..HEAD
pir find --uncommitted --json         # review the working tree (untracked included)
pir audit --json                      # full-repository audit of the committed HEAD snapshot
pir audit --path src/auth --json      # audit one subtree (repeatable, unions)
pir plugins list                      # language packs + what this repo activates
pir find --plugins golang --json      # force a language pack (or --plugins none)
pir feedback F-12 expected --note "intentional"   # teach repository memory
pir find --json                       # same issue no longer reported
pir verify-fix F-13                   # confirm a fix removed the trigger
pir --server https://pir.svc:8790 --token T --insecure find --uncommitted --json
pir memory sync --server https://pir.svc:8790 --token T --insecure   # merge local & server memory
```

### Full-repository audits (`pir audit`)

`find` answers *"what did this change break?"*; `audit` answers *"what is
broken in the code right now?"* — current-state semantics, no change
attribution, so long-standing defects are reportable precisely because they
exist today. The audit target is one immutable snapshot: the committed tree at
`--head` (default `HEAD`); uncommitted changes are never audited. There is no
`--base`, no merge-base, and no `--uncommitted`.

- Scope: `--path <file-or-dir-prefix>` (repeatable, union) and
  `--skip <glob>` (repeatable; `*`, `**`, `?`, plain values act as dir
  prefixes). Default excludes vendored/build output and lockfiles; selected
  binary/oversized files are reported `blocked`, never silently skipped.
- Scheduling: the snapshot is partitioned into deterministic work units
  (module groups; oversized files split into line-range chunks) that feed the
  **same** reviewer/verifier loop as `find`, with one global token budget,
  findings ceiling and dedup state across units.
- Coverage is first-class: the JSON envelope reports per-file states
  (`reviewed / partial / unreviewed / blocked / failed / excluded /
  not-selected`) and unit completion. A budget stop leaves files honestly
  `unreviewed` and the run `incomplete` — "reviewed" is process accounting,
  not a guarantee that every defect was found.
- Suppression stays conditional: a prior `accepted-risk`/`wont-fix` decision
  only suppresses when the verifier re-validates it against current code;
  drift reopens the finding.

CLI reference, the full memory-trust model, and Docker details are covered in
[docs/README.zh-CN.md](docs/README.zh-CN.md) (中文); the JSON protocol and
exit-code contract in [docs/for-llm.md](docs/for-llm.md).

## Development

```bash
npm test                    # build + model-free regression suite
PIR_EVAL=1 node tests/eval/run-eval.js   # evaluation suite (needs a model)
```

## License

[MIT](LICENSE) © 2026 Xin Gao
