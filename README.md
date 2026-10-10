# pir

`pir` reviews git changes and audits repositories using
[Pi](https://github.com/earendil-works/pi). A reviewer investigates the code
and proposes candidate defects; an isolated verifier checks each candidate's
trigger, impact, and supporting evidence. Results include both confirmed
findings and explicitly marked uncertainties.

pir also keeps repository memory in SQLite. Project rules, feature notes,
symbol contracts, finding decisions, and verified fixes can be reused on later
runs. This gives later reviews context about the project and lets them
reconsider earlier decisions when the code changes.

The package provides a local CLI, a Pi extension, and an HTTPS service. All
three call the same application and review code.

[中文文档](docs/README.zh-CN.md) · [Agent guide](docs/for-llm.md)

## What pir reviews

`pir find` reviews a change range and asks which problems were introduced or
unmasked by that change. `pir audit` reviews one committed snapshot and asks
which problems exist in the repository now. An audit does not attribute a
finding to a commit and never includes uncommitted files.

The review loop is deliberately conservative:

- Agents are read-only. They use review tools and cannot edit files, run shell
  commands, or write memory decisions.
- Candidates that do not fit the remaining verification budget are preserved
  as `candidate` rows, separate from reported findings.
- Reported statuses are `confirmed` and `uncertain`. Rejected and
  user-suppressed findings remain in the database with their rationale.
- A user decision is checked against the current code by a verifier on every
  later match. Code drift can reopen a previously suppressed issue.

## Requirements

- Node.js 22.5 or newer
- git
- Credentials for at least one provider supported by Pi, unless the CLI sends
  work to a configured `pir serve` instance

## Install

```bash
npx -y github:beiyanpiki/pir version
npm install --global github:beiyanpiki/pir
```

From a checkout, `npm install --global .` installs the CLI. `pi install .`
installs the Pi extension and exposes `/review-find`, `/review-audit`,
`/review-memory`, `/review-feedback`, and `/review-remember`.

## Choose an execution mode

Local and remote execution have different prerequisites. Pick one; a remote
client does not need local model credentials.

### Local mode

The command runs in the current checkout and uses this machine's Pi
credentials. Credentials normally live in `~/.pi/agent/auth.json`:

```json
{ "anthropic": { "type": "api_key", "key": "<key>" } }
```

```bash
pir models
pir find --json
pir find --uncommitted --base HEAD --json
```

The first interactive invocation can create `~/.pir/config.json`. A minimal
local configuration is:

```json
{ "schemaVersion": 1, "mode": "local" }
```

Add `"model": "provider/model"` to choose a default. `--model` has highest
priority, followed by `PIR_MODEL`, this config value, and Pi settings.

### Remote mode

With an existing `pir serve` instance, the client needs just a connection:

```bash
pir config set server.url https://pir.example.com:8790
pir config set server.token '<service-token>'
pir config set server.insecure true   # self-signed certificate only
pir config set mode remote
pir config show                        # effective settings; token masked in text and JSON alike
pir find --uncommitted --base HEAD --json
```

```json
{
  "schemaVersion": 1,
  "mode": "remote",
  "server": { "url": "https://pir.example:8790", "token": "<token>" }
}
```

For repo-context commands, the client sends a git bundle containing the local
state. Unpushed commits and an uncommitted working tree therefore work without
push access or origin credentials. `memory sync` is the exception: it always
runs locally and explicitly merges the local database with the server.

```bash
pir --local find --json
pir --server https://pir.example:8790 --token "$PIR_SERVER_TOKEN" --insecure \
  find --uncommitted --base HEAD --json
```

Transport precedence is `--server`, `--local`, `PIR_SERVER_URL`, `PIR_MODE`,
then `~/.pir/config.json`. `serve`, `config`, `skill`, `plugins`, `version`,
and `memory sync` always run on the client. `--server` and `--local` cannot
be combined. A client-side model default is not forwarded; use `--model` to
override the server's choice for a particular review. `--help` anywhere on
the command line is answered locally and exits 0 — before config, transport,
git or network — so it works offline, outside a repository, and with a
read-only `.git`.

To host the service yourself, run it on the machine with model access:

```bash
PIR_SERVER_TOKEN='<service-token>' pir serve --host 0.0.0.0 --port 8790
```

A host installation uses that machine's Pi settings and credentials. TLS
uses `--cert`/`--key`, `PIR_TLS_CERT`/`PIR_TLS_KEY`, or a generated self-signed
certificate when `openssl` is available.

### Docker service

The [Compose configuration](docker-compose.yml) provides persistent volumes
for repositories and memory. Its `.env` settings are:

```dotenv
PIR_SERVER_TOKEN=<service-token>
PI_AUTH_JSON={"anthropic":{"type":"api_key","key":"<provider-key>"}}
PI_DEFAULT_PROVIDER=anthropic
PI_DEFAULT_MODEL=<model-id>
# Optional: make serve reviews use the codegraph structural index
PIR_CODEGRAPH=1
```

```bash
docker compose up -d
```

The container entrypoint translates `PI_AUTH_JSON`, `PI_API_KEY__<provider>`,
and `PI_DEFAULT_*` into Pi configuration. `sh docker/deploy.sh` offers an
interactive setup for this deployment.

Server-side reviews run in throwaway worktrees, so a codegraph index cannot be
shared with them the way it is in local mode. With `PIR_CODEGRAPH=1` each
review copies the project's seed index into its worktree and syncs it to the
reviewed head (the first review per project pays a full index build); without
it, serve reviews run degraded — the structural `find_*` tools stay
unavailable even though the image installs the codegraph CLI.

## Common commands

```bash
pir find --json                         # HEAD^..HEAD
pir find --base origin/main --head HEAD --fail-on P1 --json
pir find --uncommitted --base HEAD --json # staged, unstaged, and untracked work

pir audit --json                        # committed HEAD snapshot
pir audit --path src/auth --path src/payments --json
pir audit --skip '**/generated/**' --json

pir findings list --status candidate
pir findings list --all --json        # every stored finding (--limit/--offset page otherwise)
pir findings show F-12
pir feedback F-12 expected --note "retry_count counts attempts by design"
pir feedback F-12 priority P1
pir feedback F-13 fixed --note "Fixed in committed HEAD"
pir verify-fix F-13

pir memory status
pir memory bootstrap
pir memory refresh
pir remember symbol PaymentService.retry invariant --text "..."
pir memory sync --server https://pir.example:8790 --token "$PIR_SERVER_TOKEN"
```

`--max-findings` is a ceiling, not a target; `--max-findings unlimited`
removes the cap entirely (#57, needs a same-version server remotely). JSON
results carry `run.maxFindings` (`null` when unlimited) plus an explicit
`run.maxFindingsMode` of `capped` or `unlimited`. `--max-rounds` applies to
change reviews; audits are bounded by work units and the optional
`--max-tokens` budget. Reviews have no token ceiling unless one is set.
`--plugins auto` is the default; use `--plugins none` or a comma separated
list of built-in packs to override detection. The shipped Go and TypeScript
packs support both modes.

Verification is serial by default. `--verify-concurrency <n>` (1–8, default
1; `PIR_VERIFY_CONCURRENCY` env when the flag is absent) runs that many
verifier sessions in parallel during each verification drain, for both find
and audit. Reported findings never exceed `--max-findings` even when
verifications race, and finding order stays deterministic.

Change reviews compare the merge base of the selected refs to head. An
explicit `--base HEAD` limits a working-tree review to uncommitted work.
`verify-fix` checks a finding marked fixed against committed HEAD.

## Output contract

Successful `--json` commands write one result envelope to stdout. A shortened
review result looks like this:

```json
{ "schemaVersion": 1, "command": "find", "data": { "findings": [], "incomplete": false } }
```

Progress and diagnostics go to stderr. Exit codes are stable: `0` means no
gate failure, `1` means a reported finding met `--fail-on`, `2` is a usage
error, and `3` is a runtime error. With `--fail-on none` (the default), an
incomplete result can still return `0`; check `data.incomplete`. With a gate
configured, an incomplete run returns `3` unless a qualifying finding already
caused `1`.

Audits also return a coverage ledger. Each selected file is accounted for as
`reviewed`, `partial`, `unreviewed`, `blocked`, or `failed`; excluded and
not-selected files are reported separately. `reviewed` records process
completion and is not a claim that every defect was found.

Preview the scope before committing to a long audit (#56):

```bash
pir audit --dry-run --list-files   # head/tree ids, selection counts, planned units
pir audit coverage --latest        # per-file ledger of the most recent audit run
pir audit coverage --run <run-id>  # ... or of a specific run
```

`--dry-run` runs the exact snapshot and unit planner a real audit would use,
without creating a run or invoking any model; `coverage` reads the ledger the
run persisted as it went, from the local project database.

## Service API and jobs

`pir serve` exposes:

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | version, TLS state, and queue status |
| `POST /v1/exec` | execute a non-bundled CLI invocation |
| `POST /v1/review` | execute a repo-context command from a git bundle |
| `POST /v1/memory/sync` | merge a local memory snapshot into the server |
| `GET /v1/jobs` and `/v1/jobs/<id>` | inspect or retrieve asynchronous work |

Remote audits sent from a checkout are asynchronous jobs by default.
`pir jobs list`, `status`, `wait`, and `fetch` inspect them. The registry is in
memory and retains the latest 100 settled jobs; runs and findings remain in
SQLite. `PIR_REMOTE_ASYNC=1` applies
job submission to other review commands. `find`/`audit --detach` submits the
job and returns immediately (#53): stdout carries the submission envelope
with the full job id and follow-up commands, and the local receipt is the
durable record — exit 0 means *accepted*, not *reviewed*. While waiting
(`jobs wait` or the submit-time poll), a status line prints on state changes
and about once a minute (#55): connection liveness, never review progress.

Bundles are packed in a throwaway temporary bare repository that reads the
checkout's objects (#46): the source repo's refs, index, config and objects
are never written, so a read-only `.git` works. The exception is
`find --uncommitted`, which records working-tree objects in the source repo
before packing.

The remote response wait is `--remote-timeout <seconds>` (0 disables), then
`PIR_REMOTE_TIMEOUT`, then config `server.timeoutSeconds`, then the 1800s
default (#54). Async job polling (5s interval) has no overall deadline.

The optional read-only explorer is enabled with `--web` or `PIR_WEB_UI=1`.
`PIR_WEB_UI_TOKEN` protects it independently of `PIR_SERVER_TOKEN`. With the
UI enabled, an unset `PIR_TRANSCRIPTS` defaults to `1`; set it to `0` to disable
recording. Compose supplies this variable, so set `PIR_TRANSCRIPTS=1` in `.env`
to record timelines there. Live timelines cover runs in the serve process; historical
transcripts also show prompts, tool traffic, and available thinking. See the
[web guide](web/README.md) for development of the explorer.

### Recovering runs by URL

When a server accepts an async review, the client writes a receipt to
`~/.pir/receipts/` naming the server, job, project and — once the job settles —
the run id. `pir receipts list` / `pir receipts show <job-prefix>` print them
with the follow-up commands; they survive disconnects and server restarts,
unlike the in-memory job registry.

With the web tier enabled, a run URL (`<origin>/runs/<projectId>/<runId>`) is
enough to inspect and export from any machine, no repository or git access
required:

```bash
pir runs status https://pir.example:8790/runs/<projectId>/<runId> --json
pir findings list --run https://pir.example:8790/runs/<projectId>/<runId> --all
pir findings show F-12 --run https://pir.example:8790/runs/<projectId>/<runId>
pir findings export --run https://pir.example:8790/runs/<projectId>/<runId> \
  --status confirmed --output findings.json
```

`findings export` walks every page and every finding's detail, retries
transient failures, writes atomically (`.tmp` + rename), and keeps a
`<output>.checkpoint.json` so an interrupted export resumes instead of
restarting. A still-running run exports the current snapshot with
`complete: false` and a `snapshotAt` timestamp; a finished run validates that
the export count matches the server's total.

Web-tier credentials are separate from the execution token (#50):
`--viewer-token` > `PIR_VIEWER_TOKEN` > `server.viewerToken` in the config,
and neither kind ever substitutes for the other. Env/config viewer tokens are
only sent to the server they were configured for; a run URL pointing
elsewhere needs the explicit flag.

## State and memory

Project identity comes from the normalized remote URL and root commit, so it
follows a repository across checkout paths and machines. Local state lives in
the platform state directory under `pir/<projectId>/memory.sqlite`; a server
can centralize it with `PIR_STATE_ROOT`. `PIR_MEMORY_DB` and
`PIR_STATE_IN_PROJECT=1` provide explicit overrides.

| Layer | Examples |
| --- | --- |
| Project | architecture, ownership, invariants |
| Feature | behavior of a vertical feature |
| Code entity | symbol contracts and relationships |
| Issue decision | expected, false-positive, accepted-risk, wont-fix |
| Finding resolution | a verified fix and its after-state |

`memory sync` is bidirectional. The newer version wins for a conflicting row;
`user_explicit` and `verified_fix` knowledge outranks agent summaries.

## Documentation

- [Chinese README](docs/README.zh-CN.md)
- [Agent execution reference](docs/for-llm.md)
- [Architecture](docs/design.md)
- [Review loop](docs/review-loop.md)
- [Pi skill](skills/pir/SKILL.md)

`pir skill install` installs the shipped agent skill; `pir skill print` outputs
it for other integrations.

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
```

Model evaluation is under `tests/eval/` and requires provider access.

## License

[MIT](LICENSE) © 2026 Xin Gao
