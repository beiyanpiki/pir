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
  (`record_candidate`); every candidate is then independently re-checked by an
  isolated verifier session before it reaches you. No unverified LLM opinions.
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
everything to a `pir serve` instance; `find` ships your local state as a git
bundle, so unpushed/uncommitted code reviews fine). Non-interactive runs fall
back to local defaults with a one-line hint. Manage later:

```bash
pir config show                                   # effective config (token masked)
pir config set mode remote                        # + server.url / server.token / server.insecure
pir config wizard                                 # re-run the setup wizard
pir --local find --json                           # one-off override, either direction
pir --server https://pir.svc:8790 --token T --insecure find --uncommitted --json
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
| [docs/design.md](docs/design.md) | Original architecture spec (the contract this code implements) |

## Quick start

```bash
pir find --json --fail-on P1          # review HEAD^..HEAD
pir find --uncommitted --json         # review the working tree (untracked included)
pir feedback F-12 expected --note "intentional"   # teach repository memory
pir find --json                       # same issue no longer reported
pir verify-fix F-13                   # confirm a fix removed the trigger
pir --server https://pir.svc:8790 --token T --insecure find --uncommitted --json
```

CLI reference, the full memory-trust model, and Docker details are covered in
[docs/README.zh-CN.md](docs/README.zh-CN.md) (中文); the JSON protocol and
exit-code contract in [docs/for-llm.md](docs/for-llm.md).

## Development

```bash
npm run build && npm test   # 50 model-free tests (scripted agent sessions)
PIR_EVAL=1 node tests/eval/run-eval.js   # evaluation suite (needs a model)
```

## License

[MIT](LICENSE) © 2026 Xin Gao
