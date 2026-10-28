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

### Long local runs survive their terminal

`pir find --detach` and `pir audit --detach` in local mode re-execute the same CLI as a background process and return as soon as it is accepted (ADR 0016 Part IV). Exit 0 means *accepted*, not *reviewed*: the review keeps running after the terminal closes, and its outcome lives in the log at `~/.pir/logs/<jobId>.log` (0600, following `PIR_CONFIG_DIR`), in the receipt under `~/.pir/receipts/` whose `exitCode` is the child's final exit code once it settles, and in the project database (`pir findings list`, `pir audit coverage --latest`). With `--json` the submission envelope is `<command>.detach` and carries the job id, `mode: "local"`, the log path, the receipt path and follow-up commands; without it the same facts print as text. `--detach` is opt-in — an ordinary local run is unchanged — and it is refused with `find --preview`, `audit --dry-run`, `audit coverage` and any command other than find/audit, because those lanes produce no run to detach. The parent cannot gate on `--fail-on`: check the receipt's `exitCode` or the findings afterwards.

There is no watchdog. A killed detach (`SIGKILL`, OOM, reboot) leaves an unsettled receipt with no `settledAt`/`exitCode` and a log that stopped growing — a running detach also has an unsettled receipt, so compare log growth, and `pir audit coverage --latest` shows the newest run's status. Two concurrent detaches are told apart by their receipts and logs, never by `--latest`. Nothing resumes a killed detach: `--detach` prevents the terminal-loss failure, it is not audit resume.

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
pir find --preview --json               # what a review would select, and what it withholds
pir find --background-file pr-description.md --base origin/main --json  # state the intent of the change

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

pir rules check src/core/supervisor.ts  # which project rule wins for a path
```

`--max-findings` is a ceiling, not a target; `--max-findings unlimited`
removes the cap entirely (#57, needs a same-version server remotely). JSON
results carry `run.maxFindings` (`null` when unlimited) plus an explicit
`run.maxFindingsMode` of `capped` or `unlimited`. `--max-rounds` applies to
change reviews; audits are bounded by work units and the optional
`--max-tokens` budget, with no default token ceiling. `find` defaults to
1.2M reviewer + 0.8M verifier input tokens (ADR 0006): hitting a ceiling
starts no new reviewer round but still verifies everything already found,
then reports the stop in `stoppedBecause` and leaves the usual
`incomplete` (exit 3 under `--fail-on`). `--max-tokens N` replaces the
defaults with one explicit whole-run ceiling and `--max-tokens unlimited`
removes every token ceiling.
`--plugins auto` is the default; use `--plugins none` or a comma separated
list of built-in packs to override detection. The shipped Frontend, Go and
TypeScript packs support both modes; the frontend pack auto-activates on
framework markers (`next.config.*`, `nuxt.config.*`, `svelte.config.*`,
`astro.config.*`, `angular.json`, `vite.config.*`, `index.html`) matched at
any repository depth, and covers web UIs built with React/Next, Vue/Nuxt,
Svelte and alike — plain SPA repos without any of those markers can pass
`--plugins frontend` explicitly.

Verification is serial by default. `--verify-concurrency <n>` (1–8, default
1; `PIR_VERIFY_CONCURRENCY` env when the flag is absent) runs that many
verifier sessions in parallel during each verification drain, for both find
and audit. Reported findings never exceed `--max-findings` even when
verifications race, and finding order stays deterministic.

Each verifier self-assesses a 0–1 confidence, persisted with the finding and
included in JSON results as `confidence`. `--min-confidence <x>` (0–1,
default 0 = off; `PIR_MIN_CONFIDENCE` env when the flag is absent) buckets
confirmed findings below the threshold into a separate `lowConfidenceFindings`
list and a low-confidence section of the text report. Bucketing only: the
findings stay reported, still count toward `--max-findings`, and the exit-code
contract is unchanged. Every review also computes a deterministic
`runVerdict` — `incorrect` (any confirmed non-style P0/P1),
`correct-with-findings`, `needs-review` (uncertain, nothing confirmed), or
`correct` — on the JSON result and the run manifest.

Verifier sessions can use a different model than the reviewer:
`--verify-model <id>` (`PIR_VERIFIER_MODEL` env when the flag is absent)
gives verifier sessions their own `<provider>/<model>` or fuzzy id while
reviewer sessions keep `--model`; when unset, verifiers use the reviewer
model. Cross-family verification (a different model family checking the
reviewer's work) is the point — models share blind spots with their own
output class. The id resolves through the standard model path: an
unresolvable id fails the verifier sessions as `provider-error` uncertainty
(the run reports incomplete), never a silent fallback. The run manifest
records both models as `model` and `verifierModel`.

`--angles <list|all>` (experimental, find-only, default off) fans out round 1
into one specialized reviewer session per angle — `correctness`,
`concurrency`, `security`, `contracts`, `performance` — instead of one
general session. At most 4 run in parallel, shrunk by the remaining
token/wall-clock budget; later rounds stay general with the merged focus.
Cross-angle near-duplicates (same entity, near-identical claim — even with
different category labels) collapse at the merge, finding ids are reassigned
uniquely, and each angle transcript records its id map. v1 keeps the same memory pack across angles.

Change reviews compare the merge base of the selected refs to head. An
explicit `--base HEAD` limits a working-tree review to uncommitted work.
`verify-fix` checks a finding marked fixed against committed HEAD.

### Project rules

Repository review conventions can be declared instead of remembered: a rule
file pairs a path glob with guidance, and `find` injects only the rules that
match the reviewed paths. Three layers are loaded, highest priority first —
`--rule <path>`, `<repo>/.pir/rule.json`, and `<config-dir>/rule.json`
(default `~/.pir/rule.json`) — and the first matching rule for a path wins
(layers in priority order, declaration order within a layer), so matching is a
deterministic code decision. A layer may also carry `include`/`exclude`
globs, and `mergeBuiltin: false` makes the project rule authoritative for its
paths by withholding the built-in language-pack guidance from reviewer sessions for that run (verifier sessions keep their own trusted pack guidance).

```json
{
  "schemaVersion": 1,
  "include": ["src/**"],
  "exclude": ["**/*.test.ts"],
  "rules": [
    { "path": "src/web/**", "guidance": "Never mutate props after mount.", "mergeBuiltin": true },
    { "path": "src/db/**", "guidanceFile": "docs/db-review.md", "mergeBuiltin": false }
  ]
}
```

Guidance file references are untrusted repository content: repo-relative only,
`.md`/`.markdown`/`.txt`, at most 64 KiB, resolved through `realpath` and
required to stay inside the repository. A malformed rule file, an escaping or
oversized reference, or a rendered section over 48,000 characters fails the
run before any model session starts. The applied rules and a canonical
`sha256` hash are recorded in the run manifest (`projectRules`), and `pir
config show` prints the loaded layers, rules and hash. Rules apply to `find`
only; `--rule` is a local path and is rejected in remote mode.

`pir rules check <path>` answers the debugging question directly, without a
run: the winning layer and its label, the matched glob, `mergeBuiltin`, the
canonical guidance text and the rules hash — or, when nothing matches, one line
per loaded layer naming the gate that failed (not included, excluded, no rule).
The path is reported repository-relative and never as a host path; an absolute
path inside the repository is accepted and reported relative, one outside it is
a usage error, and a file that does not exist is flagged rather than silently
matched. `--json` (`command: "rules.check"`) carries the same data plus the
exact PROJECT RULES prompt block for that path. It reads rule files only: no
review run, no project database, no model session.

### User background

A review knows the diff but not what the change was meant to do. `--background <text>` and `--background-file <path>` hand the reviewer one explicit, delimited context block — the stated goal, an intentional behaviour change, a migration note — and change nothing else. The input is opt-in, `find`-only, and capped: 1 MiB raw from a file, 8,000 characters of sanitised text in the prompt (longer input is truncated with an explicit marker in the prompt and a warning on stderr), and a 2,000-character soft cap that only warns. Control characters and invisible formatting characters are stripped, blank-line runs collapse, and any occurrence of the reserved `<user_background>` delimiter is rejected outright. `--background-file` wins when both flags are given, and a relative path resolves against the invocation directory like `--rule`.

The reviewer prompt carries the text inside a reserved `<user_background>` section, placed after every process rule and immediately before the evidence block, labelled as user-supplied context that is neither instructions nor evidence: it cannot override provenance rules, severity, the do-not-report list or the reporting cap, and claims in it must be verified against the pinned code. Verifier sessions never see it, `audit` rejects both flags, and the only persisted trace is `background` in `run.json` — source, canonical `sha256`, character counts and the truncation flag, never the text. The surfaces that echo argv (the server's error log, the job registry behind `GET /v1/jobs` / `pir jobs`, and local submission receipts) keep the flag and redact its value as `<background redacted>`. Session transcripts are the session record, not a provenance surface: when enabled they contain the prompt as they do for every other input. `--background` may be forwarded to a remote server (a same-version server is required); `--background-file` is a local path and is rejected in remote mode on both sides — by the CLI and by the server's execution lanes, so a direct API caller cannot read a server file into a prompt.

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

`find` and `audit` can also write SARIF 2.1.0 instead of the envelope or the
text report: `--format sarif` (`--format text|json` selects the other two, and
`--json` is the same choice as `--format json`; asking for both with different
values is a usage error). One result is emitted per reported finding: `category`
becomes the `ruleId`, P0/P1 map to `error`, P2 to `warning` and P3 to `note`,
anchors become physical locations (the first is the primary entry, the rest
`relatedLocations`), and the finding's canonical identity is
`partialFingerprints["pirFinding/v1"]`. Each invocation records whether the run
completed (`executionSuccessful`) and, when it stopped early, a `warning`
notification carrying `stoppedBecause`; audit invocations also carry the coverage
summary. No findings yields valid empty `results`. Exit codes are unchanged, and
the lanes that cannot express findings — `find --preview`, `audit --dry-run`,
`audit coverage` — refuse `sarif`. Remote mode needs a same-version server.

```bash
pir find --base origin/main --head HEAD --format sarif > pir.sarif
```

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

Change mode filters before an agent ever sees the diff. After the change set is
built, each file passes four gates in order — binary, secret paths (never
overridable), skip patterns (vendored dependencies, build output, lockfiles,
minified files), and an oversized single-file diff — and an excluded file keeps
its path, status and churn metadata but loses its diff body, so no reviewer
session can page it. Excluded files are reported, not hidden: `files[]` in the
`find --json` envelope and in the run manifest carries `excluded` (always
present) and `excludedReason` (only when filtered), additively — every
pre-existing field keeps its name and value. Secrets are the one absolute gate:
`.env`, `.ssh` material, SSH key families, `.netrc`/`.npmrc`/`.pypirc`/
`.dockercfg` are never sent to a model — their diff is withheld and change-mode
`read_code`/`search_text` refuse the path on every revision, so the gate is not
bypassed by reading the whole file (checked-in `.env.example`/`.sample`/
`.template` stay reviewable). The SDK's builtin filesystem tools read the
working tree rather than the pinned commit and are outside this gate; the
reviewer prompt already treats them as non-evidence.

`pir find --preview` prints that selection before you pay for a run —
per-file status/churn plus selected/excluded with the gate's reason, as text or
`--json`. It calls the same change-set builder and the same pure filter the
real run uses, creates no run row, opens no model session and writes nothing;
run-shaping flags are rejected with a usage error instead of being ignored.

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
job submission to other review commands. In remote mode, `find`/`audit
--detach` submits the job and returns immediately (#53): stdout carries the
submission envelope
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
transcripts also show prompts, tool traffic, and available thinking.

The Ant Design X rewrite is being evaluated at **`/next`** while the legacy explorer stays at **`/`**. Both are read-only, share the same `/api` surface and viewer credential, and are built from the root with `npm run build` (`dist/web` and `dist/web-next`). See the [web-next guide](web-next/README.md) for development; the [legacy web guide](web/README.md) still describes the original app.

Run list filters, search, and pagination stay in the URL so reloads and browser navigation restore the view. Signing in restores the full deep link, including its query and fragment. Failed page loads offer Retry; the run inspector becomes a keyboard-accessible drawer below 1280px and can be closed on desktop to expand the timeline.

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

The run Workflow view filters live and archived sessions, keeps session and finding links in the URL, and shows runtime-to-project finding IDs. Connection health is separate from execution status; selecting history pauses live scrolling until Jump to latest.

Run pages organize review work into Overview, Findings, Workflow, Coverage and Details. Overview distinguishes execution from the observation connection and explains completeness and the recorded verdict. Finding evidence opens in a desktop inspector or a modal drawer on narrower screens; source-session links connect the evidence to Workflow. Change coverage counts diff hunks, while Audit coverage reads work units and file states from the read-only ledger. Older runs display unavailable coverage explicitly.
