# pir — Deployment & Usage Guide for LLM Agents

> You (an LLM agent) are reading this because you need to **deploy and operate
> pir**, a code-review engine, on behalf of a user. This document tells you
> what to ask, what to run, and how to verify. Everything is deterministic:
> no guessing, no inventing endpoints.

## What pir is (30 seconds)

pir runs a **reviewer → verifier** agent loop over a git change range and
stores long-term "repository memory" (invariants, resolved findings, user
decisions) in SQLite. It speaks a **machine-first CLI protocol**:

- stdout: pure JSON (with `--json`), envelope `{"schemaVersion":1,"command":...,"data":...}`
- stderr: progress/log lines (safe to ignore or relay)
- exit codes: `0` ok · `1` findings at/above `--fail-on` threshold · `2` usage error · `3` runtime error

Two deployment shapes share one image:

| Mode | How | Use case |
|---|---|---|
| `docker exec` | mount the project, run `pir <cmd>` | local, state in `<project>/.pir/` |
| `serve` | HTTPS service (`POST /v1/exec`, `POST /v1/review`) | shared engine; reviews arrive as git bundles — **no push required, no repo credentials needed** |

`/v1/review` executes repo-context commands only (`find`, `audit`, `memory`,
`findings`, `feedback`, `remember`, `verify-fix`) against the bundle the
client shipped; registry management (`repos …`) and everything else go
through `/v1/exec`. Remote `pir` clients route all of those commands to the
bundle path automatically (except `memory sync`, which always runs locally) —
a stock serve workspace has no git repository, so `/v1/exec` can never give
them a repo context; requests that try anyway fail with `code:2` guidance.
Named refs in a review's `--base`/`--head` are resolved to SHAs by the client
(older clients are handled server-side); the shipped JSON body is unchanged.
A `head` that is a well-formed commit id but missing from the shipped bundle
fails the request with 400 — a client/bundle mismatch is never silently
reviewed away. `argv` must be an array of strings when present.

**Async jobs (audits).** Audits run hours to days (~5–10 min per 5-file work
unit; whole-repo sweeps take that times units), so no single client wait can
own their delivery. A `/v1/review` body with `"async": true` is answered
immediately with `202 {"jobId": "...", "status": "queued"}`; poll
`GET /v1/jobs/<jobId>` (bearer-authenticated like the POST endpoints) for
`status` (`queued` → `running` → `completed`/`failed`), recent `log` lines
and, once settled, the full `result` (`{code, output, log}`). The remote
client submits audits this way by default and polls for you — progress
streams to stderr, the envelope lands on stdout as usual, and Ctrl-C
detaches harmlessly (`pir jobs fetch <id>` picks the result up later; the
registry keeps the last 100 settled jobs; it is in-memory, so a serve
restart orphans pending job ids — the durable record stays in the project's
sqlite). Sync requests that disconnect mid-wait get the same retention: the
job finishes and its result stays fetchable instead of dying with the
socket. `PIR_REMOTE_ASYNC=1` extends async submission to every review
command; every sync `/v1/review` response also carries its `jobId`.

**Bundle-free reads.** Remote `findings list|show` never waits behind an
in-flight audit and ships no bundle at all: the client sends a 3 KB request
(`"noBundle": true`) and the server answers from the project's central db
as a WAL reader. First contact (db not created yet) answers
`{"needFull": true}` and the client automatically resends bundled, which
creates the db under the serial queue.

Optional: `PIR_WEB_UI=1` + `PIR_WEB_UI_TOKEN` (or `--web`) hosts a strictly
read-only browser explorer at `/` (projects → runs → full session timelines
with live SSE for in-flight runs). It never reaches the executor; viewer
auth is decoupled from `PIR_SERVER_TOKEN`.

---

## Part 1 — QA before deploying

**Do not invent configuration values.** Ask the user these questions.
(Identical logic is implemented in `docker/deploy.sh`; you may run that
script interactively instead of asking manually.)

| # | Question | Default | Validation | Maps to |
|---|---|---|---|---|
| 1 | *"What bearer token should protect the HTTPS API?"* | generate `openssl rand -hex 16` | non-empty; suggest generation if user hesitates | `PIR_SERVER_TOKEN` |
| 2a | *"Which model provider?"* (any provider pi supports: anthropic, openai, deepseek, zai-coding-cn, moonshotai-cn, ...) | `zai-coding-cn` | enumerate with `docker run --rm ghcr.io/beiyanpiki/pir:main models --ids --all \| cut -d/ -f1 \| sort -u` | `PI_DEFAULT_PROVIDER` |
| 2b | *"Which model from that provider?"* | provider's first listed model | enumerate with `docker run --rm ghcr.io/beiyanpiki/pir:main models --ids --all --provider <p>` | `PI_DEFAULT_MODEL` |
| 2c | *"API key for that provider?"* | none — **must ask** | non-empty; never echo it back in full | `PI_AUTH_JSON` |
| 2d | *"Thinking level?"* (off/minimal/low/medium/high/xhigh/max) | omit (image default) | one of the seven levels, or empty | `PI_DEFAULT_THINKING` |
| 3 | *"Which public port for the HTTPS service?"* | `8790` | 1–65535, must be free | `PIR_PORT` |
| 4 | *"Self-signed TLS or your own certificate?"* | self-signed (clients pass `--insecure`) | `self` \| `custom` | see "Custom TLS" below |

Optional follow-up (only if the user wants docker-exec usage on this host):

| # | Question | Default | Maps to |
|---|---|---|---|
| 5 | *"Mount a project directory for direct docker-exec reviews?"* | no | `docker run -v <path>:/workspace -e PI_API_KEY__<provider>=<key> ...` |

**Security rules while asking:**

- Never store secrets in the git-tracked tree; write them to `.env` (chmod 600, already gitignored) or pass as environment variables.
- After the user pastes a key, confirm only a masked form (`b5a9…oxdo2`).
- If the user refuses a token (wants no auth), warn once — the executor endpoint would be unauthenticated — and proceed only on explicit confirmation.

## Part 2 — Deploy (Docker)

```bash
# Option A: interactive script (implements Part 1 verbatim)
git clone https://github.com/beiyanpiki/pir && cd pir
sh docker/deploy.sh

# Option B: after collecting answers yourself
cat > .env <<EOF
PIR_SERVER_TOKEN=<from Q1>
PI_AUTH_JSON={"<provider from Q2a>":{"type":"api_key","key":"<key from Q2c>"}}
PI_DEFAULT_PROVIDER=<from Q2a>
PI_DEFAULT_MODEL=<from Q2b>
PI_DEFAULT_THINKING=<from Q2d, or omit>
PIR_PORT=<from Q3, or omit for 8790>
EOF
chmod 600 .env
docker compose up -d          # pulls ghcr.io/beiyanpiki/pir:main
```

`PI_AUTH_JSON` may hold several providers at once (merge the entries). For
`docker run` / docker-exec flows a single provider key is simpler:
`-e PI_API_KEY__<provider>=<key>`; the default model can also be forced per
invocation with `-e PIR_MODEL=<provider>/<model>`.

**Verify (must all pass before reporting success):**

```bash
curl -sk https://localhost:8790/health
# → {"ok":true,"version":"...","tls":true}

docker compose exec pir version          # any pir command works in the container
docker compose logs pir | head -5        # one "listening on ..." line, no errors

# The server must list the deployed default model among its authenticated ones:
curl -sk -H "Authorization: Bearer $PIR_SERVER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"argv":["models","--ids"]}' https://localhost:8790/v1/exec
# → {"code":0,"output":"<provider>/<model>\n...",...}
```

If health fails: `docker compose logs pir` — common causes are a wrong API
key in `PI_AUTH_JSON` (surfaces later as `reviewer session failed`, not at
health time) or a taken port. An unknown model id fails at session start;
check spelling against `docker compose exec pir models --all`.

**Full session logs & thinking (optional):** `docker compose logs` shows only
progress events. For the complete conversations — assistant text, thinking
blocks, tool calls and results — set `PIR_TRANSCRIPTS=1` in `.env` (compose
passes it through) and restart. Each run then dumps one JSON file per
reviewer/verifier session under the `pir-state` volume:

```bash
docker compose exec pir sh -c 'ls -t /data/state/*/transcripts/*/ | head'
# reviewer-r1.json  verifier-r1-F-101.json  ...   (messages[] holds the
# conversation; thinking lives in content blocks with type "thinking")
```

The run's JSON envelope (`run.transcriptDir`) and the log line
`transcripts: /data/state/...` both name the directory for a given run.

**Custom TLS (Q4 = custom):** mount the PEM pair and point pi at it:

```bash
docker run -d -p 8790:8790 \
  -v /path/cert.pem:/certs/cert.pem:ro -v /path/key.pem:/certs/key.pem:ro \
  -e PIR_TLS_CERT=/certs/cert.pem -e PIR_TLS_KEY=/certs/key.pem \
  -e PIR_SERVER_TOKEN=... \
  -e PI_AUTH_JSON='{"deepseek":{"type":"api_key","key":"..."}}' \
  -e PI_DEFAULT_PROVIDER=deepseek -e PI_DEFAULT_MODEL=deepseek-v4-pro \
  ghcr.io/beiyanpiki/pir:main serve
```

## Part 3 — Use (as the user's client)

### 3.0 Install the client

No npm publish — the CLI installs straight from GitHub (Node >= 22.5; the
git install builds itself via `prepare`):

```bash
npx -y github:beiyanpiki/pir find --json     # one-off
npx -y github:beiyanpiki/pir audit --json    # full-repo audit of committed HEAD
npm i -g github:beiyanpiki/pir               # persistent `pir`
```

`audit` reviews a pinned committed snapshot (no `--base`, no
`--uncommitted`): `--path <file|dir-prefix>` (repeatable) selects scope,
`--skip <glob>` excludes; the envelope carries per-file `coverage`
(`reviewed/partial/unreviewed/blocked/failed/excluded/notSelected`) and
`incomplete` is true whenever any in-scope file did not finish — treat that
as "not fully audited", never as a clean sweep. Exit codes match `find`.

### 3.1 Client configuration (modes, config file, precedence, env)

One binary, two modes. **local** (default) reviews in the current repo with
the user's own pi credentials; **remote** forwards commands to a
`pir serve` instance. This section is the complete client-side
configuration surface — file, wizard, `pir config`, flags, environment —
with the exact precedence the CLI applies.

#### 3.1.1 The config file

`~/.pir/config.json` (directory chmod 700, file chmod 600 — it may hold a
bearer token). `PIR_CONFIG_DIR` relocates the directory. Shape:

```json
{
  "schemaVersion": 1,
  "mode": "local",
  "server": { "url": "https://host:8790", "token": "…", "insecure": true },
  "model": "provider/model"
}
```

| Key | Rules |
|---|---|
| `mode` | `local` or `remote`; `remote` requires `server.url`, else load fails (exit 2) |
| `server.url` | must be `http(s)://…`; trailing slashes stripped on load |
| `server.token` | optional — omit when the server runs without auth |
| `server.insecure` | `true` accepts a self-signed certificate (default: TLS verified) |
| `model` | optional default model, **local sessions only** (see 3.1.5) |

A missing file is normal (local defaults apply). A malformed file is an
error, never a silent fallback: commands exit 2 naming the file — except
`config`/`help`/`version` and a bare `pir`, which continue on local defaults
so that `pir config reset` (delete the file) always works. The minimum
viable manual file is `{"schemaVersion":1,"mode":"local"}`.

#### 3.1.2 First-run wizard

The first run with no config file yet, on an interactive terminal (stdin
AND stdout are TTYs; no `--json`; command not local-only; not suppressed by
`PIR_NO_WIZARD=1` / `--no-wizard`) starts a short wizard. It asks: mode →
server URL (validated http(s); remote only) → bearer token (may be empty;
input is echoed) → accept self-signed certificate (opt-in, default N) →
default model (may be empty). Non-interactive runs — yours, usually — never
prompt: they fall back to local defaults and print one stderr hint,
silenced by `PIR_NO_WIZARD=1`, `--no-wizard` or `--quiet`. Re-run later
with `pir config wizard` (interactive only; non-TTY exits 2 and prints the
minimum-JSON hint above).

#### 3.1.3 `pir config` — inspect and edit deterministically

| Subcommand | Effect |
|---|---|
| `show` (default) | effective config, token masked in human output; `--json` returns the full config including the token (reuse it for `--token`) |
| `wizard` (alias `setup`) | re-run the interactive wizard |
| `set <key> <value>` | update one key; works from scratch — no prior file needed |
| `reset` | delete the config file; back to local defaults |

`set` keys and validation:

| Key | Value | Notes |
|---|---|---|
| `mode` | `local` \| `remote` | `remote` requires `server.url` already set (else exit 2) |
| `model` | `<provider>/<model>` or `""` | empty string clears it |
| `server.url` | http(s) URL | must be set before token/insecure/`mode remote` |
| `server.token` | token or `""` | empty string clears it |
| `server.insecure` | `true`/`false`/`1`/`0`/`yes`/`no` | |

No wizard needed — the canonical agent setup against the server you
deployed in Part 2:

```bash
pir config set server.url https://host:8790
pir config set server.token <from Q1>
pir config set server.insecure true               # Q4 = self-signed
pir config set mode remote
pir config show                                   # verify: mode remote, token masked
```

#### 3.1.4 Transport precedence (exact, per invocation)

| Decision | Order — first match wins |
|---|---|
| where this run executes | `--server <url>` flag > `--local` flag > `PIR_SERVER_URL` env > `PIR_MODE` env > config `mode` > local |
| bearer token | `--token` flag > `PIR_SERVER_TOKEN` env > config `server.token` |
| accept self-signed TLS | any **one** of `--insecure` / `PIR_INSECURE=1` / config `server.insecure` enables it |

`--server` and `--local` together are a usage error (exit 2). A remote
resolution with no URL anywhere fails exit 2 with fix hints. Client-only
flags (`--server`, `--token`, `--insecure`, `--local`, `--no-wizard`, in
both `--flag value` and `--flag=value` forms) are stripped before anything
is forwarded — the server never sees them.

These commands always execute locally, whatever the configured mode:
`serve`, `config`, `skill`, `plugins` (inspects the caller's own checkout),
`version`, `help`, a bare `pir` — plus `memory sync`, which merges the
caller's own memory db and resolves its server through the same precedence
above.

#### 3.1.5 Client environment variables

| Variable | Effect |
|---|---|
| `PIR_CONFIG_DIR` | relocate the config directory (default `~/.pir`) |
| `PIR_NO_WIZARD=1` | suppress the wizard and the no-config stderr hint (same as `--no-wizard`) |
| `PIR_SERVER_URL` | remote target for this run (implies remote mode) |
| `PIR_MODE=local\|remote` | mode override below the flags |
| `PIR_SERVER_TOKEN` | bearer token when flag/config lack one |
| `PIR_INSECURE=1` | accept the server's self-signed certificate |
| `PIR_REMOTE_TIMEOUT` | seconds the client waits for a server answer (default 1800; `0` = unlimited). Governs `/v1/review`, `/v1/exec` and `jobs` polling. A non-integer value is a usage error (exit 2), never a silent default |
| `PIR_REMOTE_ASYNC=1` | submit every review command as an async job (audits already are by default) |
| `PIR_MODEL` | default model for **local** sessions; remote runs execute on the server with the server's model (`PI_DEFAULT_*` from Part 2) unless you pass `--model <provider>/<model>` explicitly |

Model precedence, applied where the session actually runs: `--model` flag >
`PIR_MODEL` env > config `model` > pi settings. On the client that chain
steers local runs only — in remote mode `--model` is the one knob that
reaches the server, and `pir --server … models` lists the server's catalog
(what the server can actually run).

### 3.2 Remote usage

The same `pir` CLI is the remote client. Config-driven mode needs no flags;
one-off overrides: `--server` selects the service, `--insecure` accepts the
self-signed certificate, `--token` authenticates.

```bash
# From inside the user's project (works with UNPUSHED commits and even
# UNCOMMITTED changes — the client ships a git bundle to POST /v1/review):
pir find --uncommitted --json                      # mode from ~/.pir/config.json
pir --server https://host:8790 --token T --insecure find --base origin/main --json
pir --server https://host:8790 --token T --insecure feedback F-1 expected --note "intentional"
pir --server https://host:8790 --token T --insecure audit --json   # async job: polls until done

# Detached auditing: submit from one shell, pick up from another (or after
# the audit has long outlived any patience):
pir jobs list                                     # what the server is/was running
pir jobs status <id>                              # state + recent progress lines
pir jobs fetch <id>                               # relay a finished job's output
pir jobs wait <id>                                # follow a running job to its end

# Server-side registered repos (server fetches them itself):
docker compose exec pir repos add git@github.com:team/pay.git --name pay
docker compose exec pir find --repo pay --branch origin/pr-42 --json
```

Remote `findings list|show` answers even while an audit holds the server
(bundle-free read lane), so it is the mid-run status check: findings commit
incrementally, and the audit's per-unit progress + `review_runs.updated_at`
heartbeat are queryable in the project's sqlite at any moment.

**Memory sync** merges the user's local memory DB with the server's
(bidirectional; both sides converge, same-logical-record rows — same feature
key, symbol key, or finding fingerprint — collapse onto the winner's rows;
conflicting records: newest write wins, user knowledge always beats agent
summaries). It runs locally even in remote mode:

```bash
pir memory sync --json                  # server from config/env; use --dry-run to preview
```

### 3.3 Give yourself the pir skill

The package ships an agent skill (`skills/pir/SKILL.md`) teaching when and how
to drive this CLI — triggers, install, modes, JSON contract, feedback loop,
troubleshooting:

```bash
pir skill install              # -> ~/.agents/skills/pir/SKILL.md
pir skill print                # raw SKILL.md for other agent frameworks
```

**Interpreting `find` output** (JSON): `data.findings[]` with
`displayId`, `severity` (P0–P3), `status` (`confirmed`/`uncertain` are
reported; `expected`/`accepted_risk`/`wont_fix` mean suppressed by a prior
user decision that a verifier re-validated), `claim`, `trigger`, `anchors`,
`verifierRationale`, `memoryMatches`. `data.run.maxFindings` echoes the
reported-findings cap (default 10, `--max-findings N`; a ceiling, not a
target — fewer findings when evidence runs out is normal, never padded).
`data.plugins[]` lists language packs whose review directions were injected
(e.g. `golang@1.0.0 (auto)`); activation is marker-file detection pinned to
the reviewed head (`--plugins golang,...` to force, `--plugins none` to
disable, `pir plugins list` to inspect).
Use `--fail-on P1` + exit code `1` for gating decisions.

## Troubleshooting quick table

| Symptom | Cause | Fix |
|---|---|---|
| `pir: no config at ~/.pir/…` on stderr | first run, non-interactive | informational; `pir config wizard` to set up, or `PIR_NO_WIZARD=1` to silence |
| `…/config.json is not valid JSON` (exit 2) | hand-edited config broke | `pir config reset` (works despite the corrupt file), then reconfigure via `pir config set` |
| `--server and --local are mutually exclusive` (exit 2) | both transport flags passed | keep one; precedence is `--server` > `--local` (see 3.1.4) |
| `401` on API calls | wrong/missing token | pass `--token` / fix `PIR_SERVER_TOKEN` |
| TLS handshake error | self-signed cert | add `--insecure` (client) |
| `pir: cannot reach …: fetch failed (UND_ERR_HEADERS_TIMEOUT…)` | a **sync** command took longer than the client wait | audits no longer hit this (async jobs); for long sync commands raise `PIR_REMOTE_TIMEOUT` (seconds, default 1800; `0` = unlimited) or set `PIR_REMOTE_ASYNC=1` |
| "where is my audit output?" | the client detached (Ctrl-C) or a new shell | `pir jobs list` → `pir jobs fetch <id>`; the job kept running and its result is retained. After a serve restart the job id is gone — the findings live on in the project's sqlite |
| "is the audit still alive?" | long gaps between findings are normal (5–10 min per unit) | `pir jobs status <id>` shows live progress; remotely `pir findings list` answers mid-audit; in the db, `review_runs.updated_at` is the heartbeat (stale ⇒ orphaned run) |
| `reviewer session failed: ...` | model endpoint/auth broken | re-check `PI_AUTH_JSON` / `PI_API_KEY__<provider>`; `docker compose logs` |
| `could not resolve model: <id>` | unknown or ambiguous model id | `pir models --all` to find the exact id; pass `<provider>/<model>` |
| `codegraph` warnings | no structural index | harmless (file-level review); optional `codegraph init` in the project |
| `.pir/` appears in repos | exec mode state | intended; gitignore it if unwanted |

Full CLI reference and architecture: [README](../README.md) ·
Architecture reference: [docs/design.md](design.md).
