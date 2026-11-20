# Gitea integration — configuration guide

This is the deep configuration reference for the Gitea PR-review integration: the `pir serve` side, the Gitea instance side, and how to verify the wiring end to end. For the feature overview and a five-step quick start, see the "Gitea integration" section in the [README](../README.md); for the design rationale, see [ADR 0023](adr/0023-gitea-pr-webhook-integration.md).

```
Gitea ──webhook (HMAC-SHA256)──▶ pir serve POST /v1/webhook/gitea
                                   │ trigger policy (events, WIP, base branches, labels)
                                   │ status comment + `pir/review` commit status
                                   │ fetch refs/pull/<n>/head from the registered clone
                                   │ pir find + pir summarize in a throwaway worktree
                                   └─ one review per run: body + inline line comments
```

The integration is opt-in and entirely server-side: the CLI never posts anything anywhere, and a serve started without a Gitea config answers `503` on the webhook route. It was verified end to end against Gitea 1.24.7; the event handling follows Gitea's actual delivery shapes (see "Version notes" below).

## 1. Prerequisites

- A `pir serve` host with **working model credentials** (`~/.pi/agent/auth.json`, or `PI_AUTH_JSON` / `PI_API_KEY__<provider>` under docker). Without them every review run starts, fails at model authentication, and reports the failure on the PR — the pipeline works, but no findings will ever be produced.
- The serve port must be **reachable from the Gitea server** (not just from your workstation). Gitea validates webhook targets against its own allowlist before it even opens the connection — see [webhook.ALLOWED_HOST_LIST](#33-appini-settings-that-gate-delivery).
- A registered clone of every repository to review: `pir repos add <clone-url>` on the serve host (see [2.2](#22-register-repositories)).
- A bot account on the Gitea instance with a personal access token (see [3.1](#31-bot-account-and-token)).

## 2. pir serve side

### 2.1 TLS and network binding

`pir serve` speaks **HTTPS by default**: `--cert/--key` (or `PIR_TLS_CERT`/`PIR_TLS_KEY`) when you have a real certificate pair; otherwise a self-signed pair is generated with openssl and cached in `PIR_CERT_DIR` (default `/tmp/pir-certs`). Plain HTTP exists only as an escape hatch for hosts where openssl cannot generate a certificate: set `PIR_ALLOW_HTTP=1` and serve falls back to HTTP when — and only when — certificate generation fails. There is no way to force HTTP on a host that can generate a self-signed pair; put the serve behind a reverse proxy if you need plain HTTP semantics.

With a self-signed certificate, Gitea must be told to skip TLS verification for webhook delivery (`[webhook] SKIP_TLS_VERIFY`, see below), or the deliveries fail with certificate errors. With a CA-signed certificate, no Gitea-side setting is needed.

Bind with `--host`/`--port` to an address the Gitea server can route to. `--host 0.0.0.0` is the simple choice; binding to a specific interface is tighter. When Gitea and pir run on the same docker host, bind to the docker bridge gateway (for example `--host 172.17.0.1`) and point the webhook at `https://host.docker.internal:<port>/v1/webhook/gitea` with `extra_hosts: ["host.docker.internal:host-gateway"]` on the Gitea container.

### 2.2 Register repositories

```bash
pir repos add https://git.example.com/team/myrepo.git
```

The registration clones the repository under `PIR_REPOS_ROOT` (default `~/.local/share/pir/repos`). At review time the orchestrator fetches `refs/pull/<n>/head` **plus all branches** into that clone and materializes a throwaway worktree at the PR head — no working checkout of yours is ever touched. The registered URL must be the same repository the webhook payload carries (matched after URL normalization, so `https://` vs `ssh://`, trailing `.git` and host case do not matter).

A repository that is not registered still gets its webhook accepted; the run fails and posts a failure status comment containing the `repos add` guidance.

Private repositories need the fetch to authenticate. Either embed a token in the registered URL — `pir repos add https://<user>:<token>@git.example.com/owner/repo.git` — or configure a git credential helper on the serve host. The embedded-token form stores the token inside the clone's remote URL under `PIR_REPOS_ROOT`; protect that directory accordingly, and keep the token out of shell history.

### 2.3 The integration config

One JSON object configures the integration, from a file or the environment:

- **File**: `<pir config dir>/gitea.json` — default `~/.pir/gitea.json`, i.e. `$PIR_CONFIG_DIR/gitea.json` when set. It holds the bot token and the webhook secret: keep it `chmod 600`, owned by the serve user, and never commit it.
- **Environment**: a non-empty `PIR_GITEA_JSON` carries the same JSON inline and **wins over the file** — the docker- and secret-manager-friendly path, no volume mount needed.

```json
{
  "url": "https://git.example.com",
  "token": "<bot PAT>",
  "webhookSecret": "<webhook secret>",
  "commentLanguage": "en",
  "statusOnFindings": "success",
  "defaults": {
    "baseBranches": ["main"],
    "wipPrefixes": ["WIP:", "[WIP]", "Draft:"],
    "skipLabels": ["skip-review"],
    "maxFindings": 10,
    "model": null
  },
  "repos": { "team/myrepo": { "baseBranches": ["main", "dev"] } }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `url` | required | Gitea instance base URL, `http(s)://…`; trailing slashes stripped, an `/api/v1` suffix is optional (API paths are derived from the instance root) |
| `token` | required | bot PAT, sent as `Authorization: token …` |
| `webhookSecret` | required | shared secret the webhook bodies are HMAC-SHA256-signed with; must match the secret configured on the Gitea webhook |
| `commentLanguage` | `en` | language of the posted comments: `en` or `zh-CN` |
| `statusOnFindings` | `success` | commit-status state when verified findings exist: `success` (advisory) or `failure` (marks the SHA failed — blocks merges when the status is required) |
| `defaults.baseBranches` | `["main"]` | PR base branches that get reviewed; `[]` watches every base branch |
| `defaults.wipPrefixes` | `["WIP:", "[WIP]", "Draft:"]` | case-insensitive title prefixes marking a PR as work-in-progress |
| `defaults.skipLabels` | `["skip-review"]` | PR labels that opt a PR out of review |
| `defaults.maxFindings` | `10` | cap passed to the review run's `--max-findings` |
| `defaults.model` | `null` | model override (same `provider/id[:level]` syntax as `--model`) for the review and summarize sessions; `null` = pir's configured default |
| `repos` | `{}` | per-repo overrides keyed by `owner/name`; keys you set replace the default wholesale (arrays replace, never merge), unset keys inherit, and `"model": null` explicitly inherits |

Startup semantics: the config is loaded exactly once when `serve` starts. A missing file with an unset env keeps the integration off; an invalid file (unknown keys, bad types, empty `token`/`webhookSecret`, non-http(s) `url`) **refuses to start** with a `GiteaConfigError` naming the offending key. A successful start logs `gitea integration enabled for <url>`.

### 2.4 Environment variable reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `PIR_CONFIG_DIR` | `~/.pir` | where `gitea.json`, `gitea-state.json` and pir's own config live |
| `PIR_GITEA_JSON` | unset | inline integration config; a non-empty value wins over `gitea.json` |
| `PIR_REPOS_ROOT` | `~/.local/share/pir/repos` | registered clones and throwaway review worktrees |
| `PIR_STATE_ROOT` | XDG state dir | per-project memory databases, runs and transcripts |
| `PIR_SERVER_TOKEN` | unset | bearer token for the serve API routes (`/v1/exec`, `/v1/jobs`, …) — the webhook route is HMAC-authenticated and needs no bearer |
| `PIR_TLS_CERT` / `PIR_TLS_KEY` | unset | PEM pair for serve's HTTPS listener |
| `PIR_CERT_DIR` | `/tmp/pir-certs` | cache dir for the generated self-signed pair |
| `PIR_ALLOW_HTTP` | unset | `1` permits a plain-HTTP listener **only when** certificate generation fails |

### 2.5 Docker pattern

The pir container's config dir is not on any volume, so the integration is configured with `PIR_GITEA_JSON`. The compose file shipped in the repository already passes the variable through (`docker-compose.yml` → environment), so a deployment is one `.env` line on top of the usual serve setup:

```bash
# alongside PIR_SERVER_TOKEN and PI_AUTH_JSON in .env
PIR_GITEA_JSON={"url": "https://git.example.com", "token": "…", "webhookSecret": "…", "defaults": {"baseBranches": ["main"]}}
```

The JSON must stay on one shell line (or use dotenv quoting as your tooling requires). Repositories still need `pir repos add` inside the container's `PIR_REPOS_ROOT` volume (`docker compose exec pir pir repos add <clone-url>`); memory and runs concentrate under the `PIR_STATE_ROOT` volume as for any serve deployment.

## 3. Gitea instance side

### 3.1 Bot account and token

Create a dedicated user (for example `pirbot`) — a bot account keeps pir's reviews and statuses attributed to one identity and lets the bot-sender skip rule recognize pir's own actions. Generate a personal access token with exactly these scopes:

| Scope | Used for |
| --- | --- |
| `read:user` | one `GET /user` per serve process to learn the bot's own login (the bot-sender feedback-loop guard); without it the guard is disabled with a startup log line |
| `read:repository` | listing PR reviews (finding the previous pir review to replace) |
| `write:repository` | posting the review and the `pir/review` commit statuses |
| `write:issue` | creating and editing the status comment on the PR conversation |

### 3.2 Creating the webhook

In the repository (or organization) settings: **Webhooks → Add webhook → Gitea**, with:

- **Target URL**: `https://<serve-host>:<port>/v1/webhook/gitea`
- **Method**: POST, **Content type**: `application/json`
- **Secret**: the `webhookSecret` from the integration config (Gitea signs the raw body with HMAC-SHA256; pir accepts the digest in `X-Gitea-Signature` or `X-Hub-Signature-256`)
- **Trigger on**: *Custom events* → **Pull Request** (and *Pull Request Sync*, which is how Gitea delivers pushes to an open PR branch)
- **Branch filter**: leave `*` — base-branch filtering is pir's job (`baseBranches`), and the head branches would not match a main-only filter anyway

Equivalent API call:

```bash
curl -X POST "https://git.example.com/api/v1/repos/<owner>/<repo>/hooks" \
  -H "Authorization: token <admin-or-owner-PAT>" \
  -H "content-type: application/json" \
  -d '{"type":"gitea","active":true,"branch_filter":"*",
       "events":["pull_request","pull_request_sync"],
       "config":{"url":"https://<serve-host>:<port>/v1/webhook/gitea",
                 "content_type":"json","secret":"<webhookSecret>"}}'
```

Note when editing a hook through the API: a `PATCH` that omits `events` resets the subscription to the default (`push`) — always re-send `events` in the same request.

### 3.3 app.ini settings that gate delivery

Two `[webhook]` settings decide whether Gitea even attempts delivery — both were required in the reference E2E setup and neither is enabled by default:

| Setting | When you need it |
| --- | --- |
| `[webhook] ALLOWED_HOST_LIST` | Gitea refuses webhooks to loopback/private addresses by default (`deny '127.0.0.1'` / `deny '172.17.0.1'` in the server log). If serve runs on the same host or docker network, add its address: `ALLOWED_HOST_LIST = external,loopback,<serve-host-ip>` (or `host.docker.internal` resolved to the gateway) |
| `[webhook] SKIP_TLS_VERIFY` | serve uses a self-signed certificate. `SKIP_TLS_VERIFY = true` disables certificate validation for webhook delivery — for an internal instance this is the pragmatic choice; with a CA-signed serve certificate leave it off |

One more alignment knob:

| Setting | Alignment |
| --- | --- |
| `[repository.pull_request] WORK_IN_PROGRESS_PREFIXES` | Gitea derives its own "work in progress" merge-block marker from this list while pir derives its review-skip marker from `wipPrefixes`. Keep the two lists aligned (or make pir's a superset) so a PR that Gitea considers WIP is also the PR pir skips, and removing the prefix from the title triggers a review via the `edited` event |

### 3.4 Version notes

Verified against Gitea **1.24.7**. Two delivery shapes matter there and both are handled: pushes to an open PR can arrive as the dedicated `pull_request_sync` event *or* under the umbrella `pull_request` event with action `synchronized` (the finer name only appears in the `X-Gitea-Event-Type` header) — pir accepts both. Gitea has no GraphQL API and submitted reviews are immutable, which is why pir publishes each run as a fresh review after deleting its previous one.

## 4. Verifying the setup

A top-to-bottom check that needs no PR activity:

1. **serve is up and integration enabled**: `curl -k https://<serve>:<port>/health` returns `{"ok":true,…}`, and the startup log line `gitea integration enabled for <url>` appeared once.
2. **The webhook route is mounted**: an unsigned POST must answer `401`. A `503` means the integration is not configured; an unreachable/timeout means networking, not pir.
3. **Signed probe** (no Gitea involvement — this exercises HMAC, parsing and the policy engine directly):

```bash
printf '%s' '{"action":"opened","number":1,"pull_request":{"user":{"login":"u"},"title":"WIP: probe","base":{"ref":"main","sha":"0000000000000000000000000000000000000000","repo":{}},"head":{"ref":"x","sha":"0000000000000000000000000000000000000000","repo":{}},"html_url":"https://x/1","labels":[]},"repository":{"full_name":"owner/repo","name":"repo","owner":{"login":"owner"},"clone_url":"https://git.example.com/owner/repo.git"},"sender":{"login":"u"}}' > /tmp/probe.json
SIG=$(openssl dgst -sha256 -hmac "<webhookSecret>" -hex < /tmp/probe.json | sed 's/^.* //')
curl -sk -X POST "https://<serve>:<port>/v1/webhook/gitea" \
  -H "content-type: application/json" -H "x-gitea-event: pull_request" \
  -H "x-gitea-signature: $SIG" --data-binary @/tmp/probe.json
```

Expected: `200 {"accepted":false,"reason":"wip: …"}` — the signature verified, the payload parsed, the policy engine ran. Change `"title":"WIP: probe"` to a plain title to see `202 {"accepted":true,"jobId":…}` (this starts a real run; on an unregistered clone it fails with the register-guidance comment attempt in the log).

4. **End to end**: open a PR (or push to an open PR branch) from a watched base. Within seconds: `202` in Gitea's *Recent deliveries*, `gitea webhook <owner>/<repo>#N accepted` in the serve log, the 🔍 status comment on the PR, `pir/review` pending on the head SHA. Poll `GET /v1/jobs/<jobId>` (bearer token) — the output is `{outcome:"reviewed"|"superseded"|"failed", detail}`.

## 5. Trigger semantics

| Webhook | pir decision |
| --- | --- |
| `pull_request` action `opened` / `reopened` | accepted (subject to skip rules) |
| `pull_request` action `synchronized` (push to the PR branch) | accepted — same path as `pull_request_sync` |
| `pull_request` action `edited` | accepted **only once the WIP prefix is off the title** (that edit is the "ready for review" signal); still-WIP edits are rejected |
| `pull_request` action `closed` / `deleted`, any non-PR event | rejected: `unwatched-event` / `unwatched-action`, no side effects |
| Any accepted trigger with: WIP prefix or draft, base outside `baseBranches`, a `skipLabels` label, or the bot as sender | rejected with reason `wip` / `base-branch` / `skip-label` / `bot-sender` |

Every rejection answers `200 {accepted:false, reason:"<code>: <phrase>"}` so Gitea does not retry. Accepted runs serialize on serve's single queue; a newer push to the same PR supersedes an older queued run (`outcome:"superseded"`, nothing posted).

## 6. Operations notes

- **One review at a time per serve process** — webhook reviews queue behind bundle reviews. `GET /health`'s `executor` block (pending count, oldest pending age) is the queue gauge.
- **Per-PR state** lives in `gitea-state.json` in the config dir: last reviewed head SHA, review and status-comment IDs, and the fingerprints already posted (the cross-run dedupe set).
- **Cost**: each accepted run is one review loop (`find`) plus one summarize session on the same change range; `defaults.model` and `defaults.maxFindings` are the levers.
- **Observability**: serve logs every step as `gitea <owner>/<repo>#N :: …`; runs appear in the read-only web UI (`pir serve --web`) with transcripts, exactly like any other run.
- **Security posture**: the webhook route authenticates with HMAC over the raw body (constant-time compare) and needs no bearer token; the bot PAT and webhook secret never appear in logs or PR comments; error text surfaced to PR comments is sanitized and capped.

## 7. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Nothing reaches serve; Gitea log shows `webhook can only call allowed HTTP servers … deny` | `[webhook] ALLOWED_HOST_LIST` does not include the serve address — add it and restart Gitea |
| Gitea log shows a TLS/certificate error on delivery | serve runs a self-signed certificate — set `[webhook] SKIP_TLS_VERIFY = true`, or give serve a CA-signed pair |
| Webhook answers `401 invalid or missing webhook signature` | the secret differs between the Gitea webhook and the config — retype it in one place |
| Webhook answers `503 gitea integration not configured` | no `gitea.json` and no `PIR_GITEA_JSON`, or serve started before the config existed — write it and restart serve |
| serve refuses to start with `GiteaConfigError` | invalid config — the message names the key; unknown keys are rejected, not ignored |
| Status comment says the repository is not registered | `pir repos add <clone-url>` on the serve host; the URL must name the same repository the payload carries |
| Run fails with `No API key found for the selected model` | model credentials missing on the serve host (`~/.pi/agent/auth.json` / `PI_AUTH_JSON`) — see [Prerequisites](#1-prerequisites) |
| Every run fails with a 404-flavored `Not found.` | fixed since #166 — update pir; historically caused by an instance-root `url` requesting non-API paths |
| serve log: `could not fetch the bot account … bot-sender skip rule disabled` | the PAT lacks `read:user` — regenerate with all four scopes and restart serve |
| Review sits queued for a long time | another review holds the serial queue; check `GET /health` executor stats |
| An `edited` PR is never reviewed | `edited` triggers only when the WIP prefix is removed; also align `wipPrefixes` with `WORK_IN_PROGRESS_PREFIXES` |
| A finding appears in the review table instead of inline | its anchor is not inside a diff hunk's new-side span — demoted to the overview by design |
