# pir: Agent execution reference

Audience: coding agents using terminal tools, including Codex, Claude Code,
and OpenCode. This is a CLI execution contract for the current implementation.

## Execution rules

- Set the repository explicitly with the tool working directory or
  `--cwd <absolute-path>`.
- Use `--json` for result-producing commands. Capture stdout, stderr, and the
  exit code separately. Read stdout as JSON only after the process completes.
- Set `PIR_NO_WIZARD=1` for unattended use. Avoid interactive config/deployment
  wizards in agent workflows.
- Select one setup path: **local**, **remote client**, or **service deployment**.
  Remote clients require no local Pi model settings or provider credentials.
- Preserve `uncertain` and `candidate` statuses. Do not present either as a
  confirmed defect.
- Check `data.incomplete` before describing a review as complete.
- Feedback records user intent. Use a decision or `remember` content that the
  user supplied or authorized; a review hypothesis does not establish intent.

## 1. Resolve prerequisites and execution mode

Read existing task context, client configuration, and environment before
requesting missing values. A configured remote connection is sufficient for
remote review. Deploy a service only when service deployment is part of the
task.

```bash
pir version
git rev-parse --show-toplevel
pir config show
```

`config show` displays the stored config; it does not resolve every environment
or command override. Text output masks the token. `config show --json` returns
the raw stored token, so do not copy that response into user-facing output.

If the CLI is absent, Node.js >= 22.5 and git are required:

```bash
npm install --global github:beiyanpiki/pir
```

For a single invocation, replace `pir` with
`npx -y github:beiyanpiki/pir`. From a source checkout, build with
`npm install` and `npm run build`; invoke `node dist/cli/cli.js` to use that
checkout's code.

### Path A: Local execution

Required inputs: repository checkout and model access on this machine.

Minimal client config, at `~/.pir/config.json` or
`$PIR_CONFIG_DIR/config.json`:

```json
{ "schemaVersion": 1, "mode": "local" }
```

Noninteractive configuration:

```bash
pir config set mode local
pir --local models --json
pir --local models --all --ids
```

If there is no authenticated provider, configure Pi auth through the existing
credential mechanism. The API-key file form is:

```json
{
  "anthropic": { "type": "api_key", "key": "<provider-key>" }
}
```

The normal location is `~/.pi/agent/auth.json`; keep it owner-readable only
(`chmod 600`). Pi settings in `~/.pi/agent/settings.json` can select
`defaultProvider`, `defaultModel`, and `defaultThinkingLevel`.

To persist a local default:

```bash
pir config set model provider/model
```

Local model precedence: explicit `--model` > `PIR_MODEL` > client config
`model` > Pi settings. Use an ID returned by `models`; do not guess a provider
or model ID. Pi also accepts fuzzy IDs, but exact `provider/model` IDs are
preferable for automation.

A local invocation can override a saved remote connection with `--local`.
Model listing indicates configured auth, not a successful provider request.

### Path B: Remote client only

Required inputs: repository checkout, service URL, bearer token if the service
requires one, and the TLS verification policy for that service.

Do not configure local `auth.json`, `settings.json`, or a local default model
for this path. The service owns model access.

Minimal remote config:

```json
{
  "schemaVersion": 1,
  "mode": "remote",
  "server": {
    "url": "https://pir.example:8790",
    "token": "<service-token>"
  }
}
```

Set the URL before selecting remote mode; the CLI validates this ordering:

```bash
pir config set server.url https://pir.example:8790
pir config set server.token '<service-token>'
pir config set mode remote
pir models --json
```

For a service with a self-signed certificate, explicitly add
`pir config set server.insecure true`. Otherwise omit it. The CLI writes config
with owner-only permissions. For nonpersistent use:

```bash
PIR_NO_WIZARD=1 pir --server https://pir.example:8790 \
  --token "$PIR_SERVER_TOKEN" find --uncommitted --base HEAD --json
```

`pir models` now lists **server-side** models. To choose a model for a remote
review, pass `--model provider/model`; the client's config `model` and
`PIR_MODEL` are not forwarded.

Transport resolution:

| Setting | Resolution |
| --- | --- |
| Mode/URL | `--server` > `--local` > `PIR_SERVER_URL` > `PIR_MODE` > config > local |
| Bearer token | `--token` > `PIR_SERVER_TOKEN` > config `server.token` |
| Unverified TLS | enabled by any of `--insecure`, `PIR_INSECURE=1`, config `server.insecure: true` |

`--server` and `--local` are mutually exclusive. `PIR_MODE=remote` still needs
a URL from config or a higher-precedence URL setting.

`--help` anywhere on the command line is answered locally and exits 0 —
before config, transport, git or network, with the section for that
subcommand — so `pir <cmd> --help` works offline, outside a repository and
with a read-only `.git`. A `--help` directly after a value flag is that
flag's value (`--status --help`), not a help request.

These commands always execute on the client: `serve`, `config`, `skill`,
`plugins`, `help`, `version`, and `memory sync`. `jobs` contacts the remote job
registry directly. Other commands are routed as follows:

| Request | Route |
| --- | --- |
| `find`, `audit`, `memory status/bootstrap/refresh`, `feedback`, `remember`, `verify-fix` from a checkout | git bundle to `/v1/review` |
| `findings list/show` | identity-only `/v1/review`; full bundle fallback on first contact |
| `models`, `repos`, or commands using `--repo` | `/v1/exec` |
| `memory sync` | local database plus `/v1/memory/sync` |

The client pins refs to SHAs and ships unpushed code. `--uncommitted` ships a
synthetic working-tree commit without changing the user's index or branches.
The server creates a temporary worktree and stores memory under the same
project identity. Origin credentials are unnecessary for bundle-based work.

## 2. Select the target

| User intent | Command |
| --- | --- |
| Review the latest commit | `pir find --json` |
| Review a branch against a comparison ref | `pir find --base origin/main --head HEAD --json` |
| Review only staged/unstaged/untracked work against HEAD | `pir find --uncommitted --base HEAD --json` |
| Review a specific committed range | `pir find --base <base> --head <head> --json` |
| Find existing defects at committed HEAD | `pir audit --json` |
| Audit selected committed subtrees | `pir audit --path src/auth --path src/payments --json` |
| Gate on P0/P1 reports | add `--fail-on P1` |

`find` compares the merge base of the selected refs to head. Local default base
is the selected head's parent. The remote bundle client currently defaults a
find base to the checkout's `HEAD^`; pass an explicit base when selecting a
different head or limiting a working-tree review.

`--uncommitted` applies only to `find` and cannot be combined with `--head`
or `--repo`. Audit reads the committed tree at `--head` (default `HEAD`) and
rejects `--base`, `--uncommitted`, `--branch`, and `--max-rounds`.

Audit `--path` is a literal file/directory prefix, repeatable as a union.
`--skip` is repeatable and accepts `*`, `**`, `?`, or a literal prefix. Quote
globs to prevent shell expansion. Default exclusions still apply.

Limits:

| Option | Default / meaning |
| --- | --- |
| `--max-findings N` | `10`; confirmed plus uncertain reports; ceiling, not target |
| `--max-rounds N` | `2` for `find`; includes verification-only rounds |
| `--max-tokens N` | unlimited unless set; checked between sessions |
| `--fail-on P0\|P1\|P2\|P3\|none` | `none` |
| `--plugins auto\|none\|golang,typescript` | `auto`, detected at selected head |
| `--no-sync-index` | skip optional codegraph index synchronization |

Numeric limits require positive integers. Budgets do not hard-cancel an
in-flight model turn. `--quiet` suppresses progress; stdout still contains the
result. Audits can be long; use scope and budget appropriate to the task.

## 3. Execute and parse the result

Capture completion even for exit `1` or `3`; either can carry a valid review
envelope. Do not let a shell's stop-on-error behavior discard that output.

Result envelope:

```text
schemaVersion: 1
command: "find" | "audit" | another command-specific name
project?: { id, cwd, head }
data: command-specific object
```

For review results, inspect these fields in order:

1. `data.run.id`, head/base or `data.target`: confirm the reviewed target.
2. `data.incomplete`, `stoppedBecause`, `verificationErrors`,
   `uncertaintyReasons`, and audit `incompleteReasons`: assess completion.
3. `data.findings`: select reported statuses and retain verifier rationale.
4. `data.pendingCandidates` and `pendingFindings`: list unresolved work.
5. Audit `data.coverage` and `suspectedDuplicates`: account for scope.
6. `usage`, `usageComplete`, `estimatedTokens`, and `durationMs`: report
   measured cost/usage only when available.

Finding shape:

```text
id, displayId, title, claim, trigger, category, severity, status
featureKey, entityKey
anchors: [{ path, startLine, endLine? }]
evidence: [{ kind, path?, startLine?, excerpt?, description? }]
verifierRationale, memoryMatches, round, createdAt
```

Status handling:

| Status | Agent action |
| --- | --- |
| `confirmed` | present as a verified finding with trigger and location |
| `uncertain` | present separately with the uncertainty/rationale |
| `candidate` | pending verification; inspect, do not promote |
| `rejected` | retain as a rejected hypothesis, outside the report |
| `expected`, `false_positive`, `accepted_risk`, `wont_fix` | prior user decision revalidated for this occurrence |
| `fixed` | a claimed or verified fix; inspect resolution details |

The JSON `findings` array includes rejected and suppressed rows. Reported
findings are exactly `status in {confirmed, uncertain}`. Severity order is
`P0` (highest), `P1`, `P2`, `P3`.

Audit JSON returns coverage counters and `coverage.units`. Per-file coverage is
persisted in SQLite. JSON file state, where exposed, uses `notSelected`; it is
not spelled `not-selected`. `reviewed` means allotted sessions completed,
not guaranteed absence of defects.

Exit interpretation:

| Code | Meaning |
| --- | --- |
| `0` | result produced without gate failure; with `--fail-on none`, can be incomplete |
| `1` | a confirmed or uncertain finding meets the severity threshold |
| `2` | usage/configuration error |
| `3` | runtime failure, or incomplete gated review without a threshold finding |

If stdout is empty, invalid, or truncated, use stderr and the process code to
diagnose it. Failures do not promise a JSON error envelope. A valid empty
finding list with `incomplete: true` is not a clean review.

## 4. Follow remote jobs

Bundled remote audits are asynchronous by default. The CLI submits the job and
polls until completion. `PIR_REMOTE_ASYNC=1` requests the same behavior for
other bundled review commands. There is no overall polling deadline; each
request has a transport timeout.

```bash
pir jobs list --json
pir jobs status <job-id-or-unique-prefix> --json
pir jobs wait <job-id>
pir jobs fetch <job-id>
pir findings list --json
pir findings list --all --json
```

`jobs list/status --json` return `jobs.list`/`jobs.status` envelopes.
`jobs wait/fetch` relay the **original command output and exit code**; adding
`--json` at pickup does not convert originally non-JSON output. Submit with
`--json` when the result will be parsed later.

Stored-findings queries are paginated: the default page is 100 rows, the JSON
envelope reports `total`/`returned`/`hasMore`/`nextOffset` so a partial page
is never mistaken for the complete set, and `--all` fetches every page up
front. `--limit`/`--offset` select pages explicitly. This paging is unrelated
to a review's `--max-findings` cap.

Job statuses are `queued`, `running`, `completed`, and `failed`. `completed`
means execution returned a result, whose `result.code` can still be `1`, `2`,
or `3`. A polling disconnect or Ctrl-C detaches the client; it does not cancel
the server's accepted job. Find the existing job before submitting a duplicate.

Retention: process-local registry, latest 100 settled jobs, recent 2,000 log
lines, output capped at 32 MiB. `result.truncated` invalidates assumptions about
complete JSON output. A service restart loses job IDs and interrupts active
work; persisted findings and audit checkpoints remain. No automatic audit
resumption is implemented.

`findings list/show` can read the existing server database while an audit is
running, without a bundle or queue wait. This first requires the project's
database to exist and have the current schema.

## 5. Record feedback and knowledge

```bash
pir findings show F-12 --json
pir feedback F-12 expected --note "<user rationale>" --json
pir feedback F-12 priority P1 --json
pir feedback F-12 fixed --note "<fix description>" --json
pir verify-fix F-12 --json
```

Feedback decisions:
`confirmed | expected | false-positive | accepted-risk | wont-fix | fixed | obsolete`.
CLI decision names use hyphens; stored statuses use underscores.

`fixed` first records an unverified resolution. `verify-fix` requires a finding
marked fixed or an existing resolution, checks committed HEAD, and returns
`verifiedFixed`, `triggerStillReproduces`, `rationale`, and `resolutionId`.
Exit `0` alone does not mean the fix was verified. Commit the intended fix
before this operation if the task permits it.

```bash
pir remember project invariant --text "<user-provided rule>" --json
pir remember feature payment-retry note --text "<user-provided context>" --json
pir remember symbol PaymentService.retry invariant --text "<contract>" --json
pir memory status --json
pir memory bootstrap --max-batches 2 --json
pir memory refresh --json
```

`bootstrap` and `refresh` consume model tokens and are explicit operations.
`remember` scopes are `project`, `feature <key>`, or `symbol <key>`; kinds are
`invariant`, `note`, and `risk`.

Local and server memory stores are separate. To merge repository knowledge:

```bash
pir memory sync --server https://pir.example:8790 \
  --token "$PIR_SERVER_TOKEN" --dry-run --json
pir memory sync --server https://pir.example:8790 \
  --token "$PIR_SERVER_TOKEN" --json
```

Sync always runs locally, including in remote mode. It merges knowledge and
version metadata, not findings, runs, coverage, transcripts, or feedback-event
logs. Trusted user/verified knowledge outranks agent summaries; newer versions
resolve conflicts at the same authority level. Dry-run does not apply merged
knowledge; opening databases can still create local state or apply migrations.

## 6. Deploy a service when requested

Required values: service token, provider credentials, provider/model ID, bind
address/port, and persistent state location. Reuse existing authorized values.
Ask only for missing inputs that the task context cannot resolve.

### Docker Compose

Use the repository's [`docker-compose.yml`](../docker-compose.yml). Create a
local `.env` with owner-only permissions and these entries:

```dotenv
PIR_SERVER_TOKEN=<service-token>
PI_AUTH_JSON={"<provider>":{"type":"api_key","key":"<provider-key>"}}
PI_DEFAULT_PROVIDER=<provider>
PI_DEFAULT_MODEL=<model-id>
PIR_PORT=8790
```

Optional: `PI_DEFAULT_THINKING`, `PIR_TRANSCRIPTS=1`, `PIR_WEB_UI=1`, and a
separate `PIR_WEB_UI_TOKEN`. Set `PIR_TRANSCRIPTS=1` explicitly when historical
timelines are needed: Compose passes this variable even when empty, which
prevents the web-enabled service from assigning its unset-variable default.
Discover catalog IDs without making model calls:

```bash
docker run --rm ghcr.io/beiyanpiki/pir:main models --all --ids
docker compose up -d
docker compose logs --tail 100 pir
```

Compose persists repositories and memory in named volumes at `/data/repos` and
`/data/state`. Its `/pi-config` mount seeds Pi settings. The entrypoint merges
`PI_AUTH_JSON` and per-provider `PI_API_KEY__<provider>` keys, then applies
`PI_DEFAULT_*` preferences. These variables are entrypoint features, not
generic host CLI settings.

### Host service

Configure Pi credentials/settings on the service machine as in local setup,
then use persistent paths:

```bash
PIR_REPOS_ROOT=/srv/pir/repos PIR_STATE_ROOT=/srv/pir/state \
  pir serve --host 0.0.0.0 --port 8790 \
  --token "$PIR_SERVER_TOKEN" --cert /srv/pir/cert.pem --key /srv/pir/key.pem
```

TLS resolution: explicit pair > `PIR_TLS_CERT`/`PIR_TLS_KEY` > generated
self-signed pair under `PIR_CERT_DIR` (default `/tmp/pir-certs`). Both members
of a configured pair are required. Plain HTTP fallback is allowed only with
`PIR_ALLOW_HTTP=1` when certificate generation is unavailable.

Service endpoints use bearer auth when a token is configured; `/health` is
public. The optional web explorer has its own viewer token and cannot execute
reviews. Without that viewer token, it is enabled only on loopback binds.

For direct container review instead of a service:

```bash
docker run --rm -v "$PWD:/workspace" \
  -e PI_AUTH_JSON -e PI_DEFAULT_PROVIDER -e PI_DEFAULT_MODEL \
  ghcr.io/beiyanpiki/pir:main find --uncommitted --base HEAD --json
```

This container path stores state in `<repo>/.pir/` by default.

### Deployment checks

Perform the checks requested for the deployment:

```bash
curl --fail --silent --show-error https://pir.example:8790/health
pir --server https://pir.example:8790 --token "$PIR_SERVER_TOKEN" models --json
```

For self-signed TLS, use `curl --insecure` and the CLI's `--insecure` only for
that target. Health confirms service reachability; the authenticated catalog
confirms the connection and configured auth. A successful live review is the
check that exercises provider access, and consumes model tokens.

## Protocol reference

Prefer the CLI for bundles and job handling. Direct callers use:

| Endpoint | Request / result |
| --- | --- |
| `GET /health` | `{ok, version, tls, executor:{pending, oldestPendingMs}}` |
| `POST /v1/exec` | `{argv:["models","--json"]}` -> `{code,output,log}` |
| `POST /v1/review` | bundle request below -> result or async acceptance |
| `GET /v1/jobs` | `{jobs:[...]}` summaries |
| `GET /v1/jobs/<full-id>` | `{job:{status,log,result,...}}` |
| `POST /v1/memory/sync` | versioned memory snapshot; use `pir memory sync` |

Bundle request fields:

```text
remoteUrl: string | null
rootCommit: commit SHA
base: commit SHA | null
head: commit SHA
bundleBase64: base64 git bundle
argv: string[]
async?: boolean
noBundle?: boolean
```

`async: true` returns HTTP 202 `{jobId,status:"queued"}`. Synchronous bundle
results include `{code,output,log,jobId}`. `output` is a string: parse it again
for the CLI envelope when `argv` included `--json`. `needFull: true` requests
full history; async failures beginning `needFull:` signal the same retry.
`noBundle` is allowed only for `findings list/show`; identity fields and an
empty `bundleBase64` are still sent. Server API job IDs are full IDs; prefix
resolution is performed by the CLI.

`/v1/exec` requires an existing server git context for repo commands. A stock
serve workspace is not a checkout; use bundles or a registered `--repo`.

## Operational settings

| Setting | Effect |
| --- | --- |
| `PIR_CONFIG_DIR` | client config directory; default `~/.pir` |
| `PIR_NO_WIZARD=1` / `--no-wizard` | disable first-run wizard and config hint |
| `PIR_REMOTE_TIMEOUT` | per-request wait, seconds; default `1800`, `0` unlimited; nonnegative integer |
| `PIR_REMOTE_ASYNC=1` | asynchronous submission for bundled review commands |
| `PIR_MEMORY_DB` | explicit local database path |
| `PIR_STATE_IN_PROJECT=1` | local state in `<repo>/.pir/` |
| `PIR_STATE_ROOT` | central state root with project-ID subdirectories |
| `PIR_REPOS_ROOT` | server repository registry/materialization root |
| `PIR_TRANSCRIPTS=1` | retained session snapshots and run manifest beside memory DB |
| `PIR_KEEP_WORKTREE=1` | retain materialized review worktrees for debugging |
| `PIR_WEB_UI=1`, `PIR_WEB_UI_TOKEN` | read-only explorer and separate viewer auth |

`PIR_REMOTE_TIMEOUT` covers execution/bundle requests and job status requests;
it is not an overall asynchronous job deadline. Memory sync instead uses its
own 120-second request timeout.

## Recovery table

| Observation | Next action |
| --- | --- |
| Missing CLI | install or use GitHub npx invocation |
| Non-git cwd | select the checkout with tool cwd or `--cwd` |
| Invalid config / exit `2` | inspect and fix `config.json`; `config reset` removes it if requested |
| Remote mode without URL | set `server.url` before `mode remote` |
| HTTP `401`/`403` | correct service token; do not substitute provider credentials |
| TLS failure | check endpoint/cert trust; explicit insecure mode only for the intended self-signed service |
| No authenticated models | configure credentials on the execution machine; remote means server |
| Unknown model | use exact IDs from the execution machine's model catalog |
| Provider error / missing verdict | retain uncertainty and incomplete diagnostics; inspect execution-machine credentials and logs |
| Codegraph degraded | file/diff review remains available; optional index initialization is separate |
| Sync request timeout | inspect jobs before retrying; increase `PIR_REMOTE_TIMEOUT` or use asynchronous submission |
| `failed to prepare the review bundle locally … Read-only file system` | a LOCAL git error, not server connectivity; run from a checkout with a writable `.git` (bundle-free `findings list/show` needs no bundle unless the server demands full history) |
| Job ID missing after restart | inspect persisted findings; the process-local registry cannot recover the job |
| `verify-fix` rejects finding | mark it fixed first; the verification target is committed HEAD |

## Agent integration

`pir skill install` writes the shipped skill to `~/.agents/skills/pir/` by
default. `pir skill install --dir <skills-root>` selects another skill root;
`pir skill print` outputs its content for other integrations. Use the skill
location supported by the agent environment; the CLI/JSON contract above is
the same for every host agent.

For implementation details, use [design.md](design.md) and
[review-loop.md](review-loop.md).
