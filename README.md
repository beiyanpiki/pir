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

**Docker (recommended, both for humans and agents):**

```bash
docker pull ghcr.io/beiyanpiki/pir:main
# interactive QA deployment of the HTTPS service:
sh docker/deploy.sh          # asks token / API key / port / TLS, then verifies
```

**Local CLI:**

```bash
npm i -g .                   # provides `pir`
pi install $(pwd)            # Pi extension: /review-* commands
```

**Model access (official Zhipu GLM):** pi's built-in `zai-coding-cn` provider
targets the official coding endpoint. Store your bigmodel key:

```jsonc
// ~/.pi/agent/auth.json (chmod 600)
{ "zai-coding-cn": { "type": "api_key", "key": "<your bigmodel key>" } }
```

and default the model in `~/.pi/agent/settings.json`
(`defaultProvider: "zai-coding-cn"`, `defaultModel: "glm-5.3-flash"`,
`defaultThinkingLevel: "low"` — GLM accepts low/high/max only).

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
npm run build && npm test   # 48 model-free tests (scripted agent sessions)
PIR_EVAL=1 node tests/eval/run-eval.js   # evaluation suite (needs a model)
```

## License

[MIT](LICENSE) © 2026 Xin Gao
