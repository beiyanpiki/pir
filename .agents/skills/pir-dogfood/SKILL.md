---
name: pir-dogfood
description: "Dogfood code review: run pir built from THIS worktree's source to review pir's own changes during development. Use when developing pir (github.com/beiyanpiki/pir, any git worktree of it) and the user wants pir to review itself with its own in-development code — dogfooding, self-review, 自举, 吃自己的狗粮, 用本地源码评审, review a pir worktree with the worktree's own build, or mentions a dogfood model like glm-5.3:max. NOT for reviewing other projects, and NOT for released pir — for those use the plain `pir` skill with the installed CLI."
---

# pir-dogfood — pir reviews itself, from this worktree's source

While developing pir, review your own changes **with the pir you are writing**,
not the released one. The engine under test is the current worktree's compiled
`dist/`; the review target is that same worktree's git range. This is the only
way new CLI behavior, prompt changes, and verifier fixes get exercised before
they ship.

For any other project — or released pir reviewing anything — use the regular
`pir` skill instead.

## Hard rules

1. **Engine = this worktree's build, always.** Invoke `node dist/cli/cli.js …`
   from the worktree root. Never `pir`, `npx github:beiyanpiki/pir`, or a
   globally installed / `npm link`ed binary — those are released code and
   defeat the purpose.
2. **Rebuild before every review.** `npm run build` (plain `tsc`) first,
   otherwise you review with a stale `dist/` and any edit you just made is
   silently absent. Confirm with `node dist/cli/cli.js version`.
3. **Complete isolation from external config.** The user's global
   `~/.pir/config.json` (or `PIR_SERVER_URL` / `PIR_MODE` env) may point at a
   remote `pir serve` running *released* code. A dogfood run must never be
   forwarded there. Belt and suspenders:
   - dedicated `PIR_CONFIG_DIR` (e.g. `/tmp/pir-dogfood-config`) so the run
     reads and writes nothing from `~/.pir/`;
   - `PIR_NO_WIZARD=1` (non-interactive anyway);
   - always pass `--local` — it overrides config/env remote settings
     (precedence: `--server` > `--local` > `PIR_SERVER_URL` > `PIR_MODE` >
     config), and you never pass `--server`;
   - never use `--repo` / `--branch` (server-registered repos, remote-only)
     and never run `memory sync` or `serve` in a dogfood context.

   The isolated config dir stays empty by design: local mode needs no config,
   and the model always comes from the explicit `--model` flag. Model
   credentials are a different layer — pi auth at `~/.pi/agent/auth.json` —
   and are still required.

## Standard invocation

```bash
cd <pir-worktree>                    # the worktree under development
npm run build                        # review with the code you just wrote
mkdir -p /tmp/pir-dogfood-config
PIR_CONFIG_DIR=/tmp/pir-dogfood-config PIR_NO_WIZARD=1 \
  node dist/cli/cli.js find --local --json --model 'zai-coding-cn/glm-5.3:max' \
  <range flags>
```

Check what models are actually authenticated in this environment first
(`--local` matters here too — `models` is forwarded in remote mode, and env
like `PIR_SERVER_URL` would otherwise hijack it):

```bash
PIR_CONFIG_DIR=/tmp/pir-dogfood-config PIR_NO_WIZARD=1 \
  node dist/cli/cli.js models --ids --local
```

## --model: model + thinking intensity

`--model <id>[:<level>]` — the suffix after the **last colon** is the thinking
level; an invalid level is a hard error, not a fallback.

- Level ∈ `off | minimal | low | medium | high | xhigh | max` (default when
  omitted: `medium`).
- Fully qualified: `zai-coding-cn/glm-5.3`.
- With intensity: `zai-coding-cn/glm-5.3:max` (what the user typically means by
  "max thinking"), `zai-coding-cn/glm-5.3:high`, `glm-5.3-flash:low`.
- Bare fuzzy ids (`glm-5.3`) work when unambiguous, but the same model id can
  exist under several providers and resolution may then land on one without
  credentials (e.g. `glm-5.3` → `vercel-ai-gateway`, failing with "No API key
  found"). Prefer the `provider/model` form; take exact ids from
  `models --ids`.

Reviewer and verifier sub-sessions both use this model. Heavier levels cost
real tokens — match the intensity to the change size, and don't loop `find`.

## Range selection

Same semantics as pir itself; run from inside the worktree (cwd is the review
target):

| Situation | Flags |
|---|---|
| Last commit | *(none)* — default `HEAD^..HEAD` |
| Working tree, untracked included | `--uncommitted` (exclusive with `--repo`/`--head`) |
| Whole branch incl. current edits | `--uncommitted --base origin/dev` |
| Committed branch diff | `--base origin/dev` |
| Other local checkout, this build as engine | `--cwd /path/to/other/worktree` + range flags |

## Other flags worth passing

| Flag | Meaning |
|---|---|
| `--fail-on P1` | gate: exit 1 when a P0/P1 finding is reported (`P0..P3\|none`, default `none`) |
| `--max-findings <n>` | cap on reported findings (default 10; ceiling, not target) |
| `--max-rounds <n>` | discovery/verification rounds (default 2) |
| `--max-tokens <n>` | optional session token budget |
| `--plugins auto\|none\|golang,typescript` | language packs (default auto-detect) |
| `--no-sync-index` | skip codegraph index sync |
| `--quiet` | suppress stderr progress |

## Reading results and the feedback loop

Output contract is identical to pir: with `--json`, stdout is pure JSON
(`data.findings[]` with `displayId`, `severity`, `status`, `claim`, `trigger`,
`anchors`, `verifierRationale`, `memoryMatches[]`); exit `0` ok, `1` findings ≥
`--fail-on`, `2` usage, `3` runtime. Relay findings to the user, don't
screen-scrape progress.

Teach and re-check **from the same source build** — same env prefix, same
`--local`:

```bash
PIR_CONFIG_DIR=/tmp/pir-dogfood-config PIR_NO_WIZARD=1 \
  node dist/cli/cli.js feedback F-3 expected --note "intentional" --local
PIR_CONFIG_DIR=/tmp/pir-dogfood-config PIR_NO_WIZARD=1 \
  node dist/cli/cli.js verify-fix F-3 --local
```

Repository memory is a per-project SQLite in the local XDG state dir, keyed by
origin + root commit, so all worktrees of this repo share it and nothing ever
leaves the machine unless someone runs `memory sync` — which dogfooding never
does.

## Troubleshooting

| Symptom | Fix |
|---|---|
| New flag/behavior "not found" | Stale `dist/` — `npm run build` and re-run |
| `Model "…" not found` | `models --ids` for exact ids; pass `provider/model`; check `~/.pi/agent/auth.json` |
| `No API key found for <provider>` | Bare model id resolved to a provider you have no credentials for — re-run with the fully qualified `provider/model:level` from `models --ids` |
| `no config yet — running with local defaults` | Expected with the isolated `PIR_CONFIG_DIR`; not an error |
| Wizard hint on stderr | Already silenced by `PIR_NO_WIZARD=1`; harmless |
| Review feels like released pir | Re-check you invoked `node dist/cli/cli.js`, not `pir` |
