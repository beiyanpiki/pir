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
npm i -g github:beiyanpiki/pir               # persistent `pir`
```

### 3.1 Modes & first-run config

The first interactive run starts a setup wizard writing `~/.pir/config.json`
(chmod 600): **local** (default — review in the current repo with the user's
pi credentials) or **remote** (forward to a `pir serve` instance). Non-TTY
runs (yours, usually) fall back to local defaults with a stderr hint — set
`PIR_NO_WIZARD=1` or pass `--no-wizard` to silence it. Inspect and drive it
deterministically:

```bash
pir config show                                   # effective config, token masked
pir config set server.url https://host:8790
pir config set server.token <from Q1>
pir config set server.insecure true               # Q4 = self
pir config set mode remote
```

Precedence: `--server <url>` > `--local` > `PIR_SERVER_URL` >
`PIR_MODE=local|remote` > config file. `serve`/`config`/`skill`/`version`
always execute locally. `PIR_CONFIG_DIR` relocates the config dir.

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

# Server-side registered repos (server fetches them itself):
docker compose exec pir repos add git@github.com:team/pay.git --name pay
docker compose exec pir find --repo pay --branch origin/pr-42 --json
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
`verifierRationale`, `memoryMatches`. Use `--fail-on P1` + exit code `1` for
gating decisions.

## Troubleshooting quick table

| Symptom | Cause | Fix |
|---|---|---|
| `pir: no config at ~/.pir/…` on stderr | first run, non-interactive | informational; `pir config wizard` to set up, or `PIR_NO_WIZARD=1` to silence |
| `401` on API calls | wrong/missing token | pass `--token` / fix `PIR_SERVER_TOKEN` |
| TLS handshake error | self-signed cert | add `--insecure` (client) |
| `reviewer session failed: ...` | model endpoint/auth broken | re-check `PI_AUTH_JSON` / `PI_API_KEY__<provider>`; `docker compose logs` |
| `could not resolve model: <id>` | unknown or ambiguous model id | `pir models --all` to find the exact id; pass `<provider>/<model>` |
| `codegraph` warnings | no structural index | harmless (file-level review); optional `codegraph init` in the project |
| `.pir/` appears in repos | exec mode state | intended; gitignore it if unwanted |

Full CLI reference and architecture: [README](../README.md) ·
Original design spec: [docs/design.md](design.md).
