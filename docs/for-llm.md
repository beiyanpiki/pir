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
| 2 | *"What is your bigmodel coding-plan API key?"* (official GLM endpoint, `open.bigmodel.cn`) | none — **must ask** | non-empty; format `<32 hex>.<16 alnum>` typically; never echo it back in full | `BIGMODEL_API_KEY` |
| 3 | *"Which public port for the HTTPS service?"* | `8790` | 1–65535, must be free | `PIR_PORT` |
| 4 | *"Self-signed TLS or your own certificate?"* | self-signed (clients pass `--insecure`) | `self` \| `custom` | see "Custom TLS" below |

Optional follow-up (only if the user wants docker-exec usage on this host):

| # | Question | Default | Maps to |
|---|---|---|---|
| 5 | *"Mount a project directory for direct docker-exec reviews?"* | no | `docker run -v <path>:/workspace ...` |

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
cat > .env <<'EOF'
PIR_SERVER_TOKEN=<from Q1>
BIGMODEL_API_KEY=<from Q2>
PIR_PORT=<from Q3, or omit for 8790>
EOF
chmod 600 .env
docker compose up -d          # pulls ghcr.io/beiyanpiki/pir:main
```

**Verify (must all pass before reporting success):**

```bash
curl -sk https://localhost:8790/health
# → {"ok":true,"version":"...","tls":true}

docker compose exec pir version          # any pir command works in the container
docker compose logs pir | head -5        # one "listening on ..." line, no errors
```

If health fails: `docker compose logs pir` — common causes are a wrong
`BIGMODEL_API_KEY` (surfaces later as `reviewer session failed`, not at
health time) or a taken port.

**Custom TLS (Q4 = custom):** mount the PEM pair and point pi at it:

```bash
docker run -d -p 8790:8790 \
  -v /path/cert.pem:/certs/cert.pem:ro -v /path/key.pem:/certs/key.pem:ro \
  -e PIR_TLS_CERT=/certs/cert.pem -e PIR_TLS_KEY=/certs/key.pem \
  -e PIR_SERVER_TOKEN=... -e BIGMODEL_API_KEY=... \
  ghcr.io/beiyanpiki/pir:main serve
```

## Part 3 — Use (as the user's client)

The same `pir` CLI is the remote client. `--server` selects the service;
`--insecure` accepts the self-signed certificate; `--token` authenticates.

```bash
# From inside the user's project (works with UNPUSHED commits and even
# UNCOMMITTED changes — the client ships a git bundle to POST /v1/review):
pir --server https://host:8790 --token T --insecure find --uncommitted --json
pir --server https://host:8790 --token T --insecure find --base origin/main --json
pir --server https://host:8790 --token T --insecure feedback F-1 expected --note "intentional"

# Server-side registered repos (server fetches them itself):
docker compose exec pir repos add git@github.com:team/pay.git --name pay
docker compose exec pir find --repo pay --branch origin/pr-42 --json
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
| `401` on API calls | wrong/missing token | pass `--token` / fix `PIR_SERVER_TOKEN` |
| TLS handshake error | self-signed cert | add `--insecure` (client) |
| `reviewer session failed: ...` | model endpoint/auth broken | re-check `BIGMODEL_API_KEY`; `docker compose logs` |
| `codegraph` warnings | no structural index | harmless (file-level review); optional `codegraph init` in the project |
| `.pir/` appears in repos | exec mode state | intended; gitignore it if unwanted |

Full CLI reference and architecture: [README](../README.md) ·
Original design spec: [docs/design.md](design.md).
