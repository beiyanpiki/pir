---
name: pir
description: "Code review with the pir CLI: a reviewer→verifier agent loop with repository memory (SQLite) that reports only verified findings. Trigger when the user asks to review code / a diff / recent changes, find bugs introduced by a change (评审代码, 代码审查, 检查改动), gate a branch on findings, or mentions pir. Covers install (npx from GitHub), local vs remote mode, first-run config, the JSON protocol, feedback/memory commands, and troubleshooting."
metadata:
  version: "0.2.0"
---

# pir — verified code review from the CLI

`pir` reviews a git change range and reports **verified, structured findings**
(not raw LLM opinions): a read-only reviewer session proposes candidates, then
an isolated verifier session re-checks each one before it is reported. A
five-layer **repository memory** (SQLite) remembers user decisions
("intentional", "wont-fix") and stops re-reporting suppressed issues — while a
verifier re-validates those decisions against current code and reopens them
when reality changes.

## When to use

- "Review my code / this diff / my changes", "what's wrong with this commit"
- "跑一下代码评审 / 审查一下这次改动 / 检查 bug"
- Pre-merge gating: exit code `1` when findings ≥ `--fail-on P1`
- Teaching the reviewer: "this warning is intentional" → `pir feedback`
- Checking past findings: `pir findings list`

Do **not** use for style-only linting, auto-fixing, or posting PR comments —
pir does none of those by design.

## Prerequisites

```bash
pir version
```

- Works → continue.
- Not installed → install from GitHub (no npm publish needed):

```bash
# one-off (no install):
npx -y github:beiyanpiki/pir version
# persistent:
npm i -g github:beiyanpiki/pir
```

Requires Node ≥ 22.5 and git. Reviews need model credentials: pi auth at
`~/.pi/agent/auth.json` (`{"<provider>": {"type":"api_key","key":"…"}}`) or a
remote server that already has them. Check what is available:

```bash
pir models            # authenticated models
pir models --all      # full catalog
```

## Modes & configuration

First interactive run starts a setup wizard (local vs remote, server
URL/token, default model). Config lives in `~/.pir/config.json` (chmod 600).
Inspect and change it:

```bash
pir config show                       # effective config (token masked)
pir config set mode remote            # or: local
pir config set server.url https://pir.svc:8790
pir config set server.token <t>
pir config set server.insecure true   # self-signed cert
pir config wizard                     # re-run the setup wizard
```

- **local** (default): runs in the current repo, uses this machine's pi credentials.
- **remote**: every command forwards to a `pir serve` instance; `find` ships the
  local state as a git bundle, so **unpushed commits and uncommitted changes
  review fine without pushing or sharing credentials**.

One-off overrides: `--server <url> [--token T] [--insecure]` forces remote,
`--local` forces local. `serve`/`config`/`skill`/`version` always run locally.

## Output contract (build on this, don't screen-scrape)

- stdout: pure JSON with `--json` — `{"schemaVersion":1,"command":"find","data":…}`
- stderr: progress lines (relay or ignore)
- exit codes: `0` ok · `1` findings ≥ `--fail-on` · `2` usage error · `3` runtime error

## Core workflow

```bash
# 1. Review a change range
pir find --json                          # HEAD^..HEAD
pir find --uncommitted --json            # working tree, untracked included
pir find --base origin/main --json       # branch diff
pir find --json --fail-on P1             # gate: exit 1 on P0/P1 findings

# 2. Present findings from data.findings[]:
#    displayId (F-12), severity P0–P3, status confirmed|uncertain,
#    claim, trigger, anchors[], verifierRationale, memoryMatches[]
#    status expected|accepted_risk|wont_fix = suppressed by a user decision

# 3. Let the user decide on false positives — then teach, don't argue:
pir feedback F-12 expected --note "retry_count intentionally counts attempts"
pir feedback F-13 wont_fix
pir feedback F-14 priority P1
pir verify-fix F-13                      # confirm a fix removed the trigger

# 4. Re-run: suppressed issues stay gone; memory is evidence, re-validated.
```

Optional memory bootstrap for long-lived projects (summarizes modules into
repository memory; costs model tokens):

```bash
pir memory status
pir memory bootstrap          # one-time; --max-batches to cap
pir memory refresh            # after large refactors
```

## Command reference

| Command | Purpose |
|---|---|
| `pir find [--base B --head H --uncommitted --model M --fail-on SEV]` | review a range; `--model provider/model` overrides the default |
| `pir findings [list [--status s]]` / `pir findings show F-12` | stored findings |
| `pir feedback <id> <decision> [--note …]` | decisions: `expected` `accepted_risk` `wont_fix` `false_positive` (+ `priority P0-P3`) |
| `pir verify-fix <id>` | verifier checks a reported fix |
| `pir memory status\|bootstrap\|refresh` | repository memory |
| `pir remember project\|feature\|symbol <target> invariant\|note\|risk --text "…"` | store code knowledge |
| `pir models [search] [--all] [--ids] [--provider p]` | model catalog |
| `pir config show\|wizard\|set\|reset` | client config (`~/.pir/config.json`) |
| `pir skill install [--dir D]` | install this skill (default `~/.agents/skills`) |
| `pir serve` | run the HTTPS service side (see docs/for-llm.md) |

Reviews run LLM sessions and consume tokens of the configured model. Prefer
`--max-rounds`/`--max-tokens` defaults; don't loop `find` unattended.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `no config at ~/.pir/config.json` hint on stderr | informational only; `pir config wizard` to set up |
| `401` / "server rejected" | `pir config set server.token <t>` |
| TLS handshake error | `pir config set server.insecure true` (self-signed) |
| `could not resolve model: …` | `pir models --all` for exact ids; pass `<provider>/<model>` |
| `reviewer session failed` | provider credentials broken — check `~/.pi/agent/auth.json` |
| `codegraph` warnings | harmless; file-level review without the structural index |

Deep references: `docs/for-llm.md` (deployment + JSON contract),
repo `README.md` (architecture).
