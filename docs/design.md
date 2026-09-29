# pir Architecture

This document describes the **implemented** architecture of `pir` — the
developer-facing reference for anyone changing the codebase. It reflects the
code as of v0.2.x; when the code and this document disagree, the code wins and
this document should be fixed in the same change.

Related documents:

- [README.md](../README.md) — user-facing overview and install
- [docs/for-llm.md](for-llm.md) — agent-facing deployment guide, JSON protocol
- [docs/review-loop.md](review-loop.md) — review-loop semantics in depth
  (evidence, scheduling, uncertainty, evaluation methodology)
- [tests/eval/README.md](../tests/eval/README.md) — evaluation scenarios

---

## 1. What pir is — and is not

`pir` is a code-review engine built on the
[Pi](https://github.com/earendil-works/pi) agent SDK. It does exactly one
thing:

> Find problems **introduced by the current change**, as accurately as
> possible, and use project history to stop repeating itself.

Explicit non-goals — pir never handles:

- GitHub/GitLab integration, PR comments, HTTP webhooks
- CI gating beyond a process exit code
- Auto-fixes or writing to reviewed repositories

Structured findings in, structured findings out. How findings are displayed is
the caller's problem.

The core idea: instead of a stateless LLM reviewer that treats every project as
unfamiliar, pir maintains a **Repository Memory** — durable knowledge of
project intent, historical decisions, and past fixes — while keeping every
model session short-lived, isolated, and disposable.

---

## 2. Design principles

These invariants cut across every layer. Changes that violate them need a very
good reason.

1. **Codegraph knows structure, git knows history, memory knows intent.**
   The structural index, the commit graph, and the semantic knowledge base are
   three separate systems with separate lifecycles. Never copy one into
   another.
2. **Sessions are disposable; SQLite is durable.** Reviewer/verifier state
   lives only inside a single in-memory Pi session. Everything that survives a
   run lives in `memory.sqlite`. Long conversations are never used as storage —
   they pollute reasoning.
3. **User defines truth about product intent.** Only user feedback (or a
   verifier-confirmed fix) can write *decision* memories. Agents may generate
   navigation-grade summaries, but those can never suppress a finding.
4. **Memory is evidence, not instructions.** Retrieved memory is framed as
   untrusted evidence in every prompt, with structured fields — never spliced
   into the system prompt as directions. This is the prompt-poisoning defense.
5. **The reviewer hypothesizes; the verifier establishes evidence.** The
   reviewer never sees historical issue decisions (no anchoring bias); only the
   verifier does, and it must re-assess whether each decision still applies
   against current code. Suppression is *recorded and reopenable*, never a
   silent drop.
6. **Reviews are read-only and pinned.** Agents get no edit/write/bash tools.
   Evidence tools read immutable git revisions (`head`/`base`/`merge-base`);
   anchors are validated against the pinned head snapshot at submission time.
7. **One command path.** CLI, Pi extension commands, remote relays, and the
   HTTPS server all funnel through a single `executePirCommand` dispatcher.
   Feature work lands once; every face gets it.
8. **Machine-first output.** stdout is pure JSON (one `schemaVersion:1`
   envelope per command); progress goes to stderr; exit codes are contract:
   `0` ok · `1` findings at/above `--fail-on` · `2` usage · `3` runtime.
9. **Lean core.** Runtime dependencies: the Pi SDK + `typebox`. Storage is
   `node:sqlite`. The only external tool is `git` (required) and `codegraph`
   (optional, degrades gracefully).
10. **Branches never key memory.** `projectId` is derived from the normalized
    git remote + root commit. Invariants and decisions are repository-level
    knowledge, not branch-local.

---

## 3. System overview

One package, three faces, one command path:

```
Pi extension (/review-find …)      pir CLI ──── remote mode ────┐
        └────────────┬──────────────────────┘                    │
                     ▼                                         HTTPS
        src/cli/executor.ts  —  executePirCommand()       POST /v1/review
        (single command path, shared dispatch)            POST /v1/exec
                     │                                     POST /v1/memory/sync
        src/app  —  context · services · find · output           │
                     │                                            ▼
   ┌─────────────────┼─────────────────────────────┐    src/server/server.ts
   │ core      supervisor · frontier · budget      │    (bundle → worktree →
   │ changes   git · diff · change-set             │     same executor)
   │ findings  fingerprint · dedup                 │
   │ codemap   codegraph CLI adapter / degraded    │
   │ memory    SQLite five-layer + feedback + sync │
   └─────────────────┬─────────────────────────────┘
                     ▼
        src/agents — one-shot in-memory Pi sessions
        (read-only builtins + structured tools; reviewer never
         sees historical decisions — the verifier does)
```

A `find` run flows: resolve base/head → `ChangeSet` → memory pack → supervisor
loop (reviewer rounds ⇄ verifier drains) → verified findings persisted to
SQLite → JSON envelope + exit code.

---

## 4. Entry points

### 4.1 CLI — `src/cli/cli.ts`

`bin: pir → dist/cli/cli.js`. Bootstrap order:

1. Commands that never touch a server: `serve`, `config`, `skill`, `help`,
   `version` (and `memory sync` always runs locally).
2. First interactive run with no config: setup wizard (writes
   `~/.pir/config.json`, chmod 600). Non-interactive runs fall back to local
   defaults with a one-line stderr notice.
3. `resolveTransport` picks local vs remote: `--server` flag > `--local` flag
   > `PIR_SERVER_URL` env > `PIR_MODE` env > config file > local.
4. Default model precedence: `--model` flag > `PIR_MODEL` env > `config.model`
   > pi settings (`~/.pi/agent/settings.json`).
5. Progress (`onLog`) → stderr unless `--json`/`--quiet`; stdout gets only the
   result envelope. `UsageError` → exit 2; anything else → exit 3 (stack).

Command tree:

```
pir find        [--base --head --max-rounds --max-tokens --max-findings
                 --fail-on P0..P3|none --model --uncommitted
                 --repo <spec> --branch --no-fetch --no-sync-index]
pir audit       [--path <file|dir-prefix>]... [--skip <glob>]... [--head <ref>
                 --max-tokens --max-findings --fail-on P0..P3|none --model
                 --repo <spec> --no-fetch --no-sync-index]
                 current-state snapshot review; no --base/--uncommitted/--branch
pir memory      status | bootstrap [--model --max-batches] | refresh [--model]
                | sync [--dry-run --server --token --insecure --local]
pir feedback    <id> <decision> [--note]        decisions: confirmed expected
                pir feedback <id> priority P0..P3 [--note]  false-positive
                accepted-risk wont-fix fixed obsolete
pir remember    <project|feature|symbol> [target] <invariant|note|risk> --text
pir findings    list [--status] | show <id>
pir verify-fix  <id> [--model]
pir models      [search] [--all --ids --provider]
pir repos       list | add <url-or-path> [--name] | remove <name> [--purge]
pir serve       [--host --port --cert --key --token --workspace]
pir config      show | wizard | set | reset
pir skill       path | install | print
```

Global flags: `--json`, `--cwd <path>`, `--quiet`; transport flags
`--server --token --insecure --local`.

### 4.2 Pi extension — `src/extension/`

Declared via `"pi": { "extensions": ["./dist/extension/index.js"] }`. Registers
four slash-commands that tokenize args and call the **same** `src/app` services
the CLI uses:

- `/review-find` — flags `--base --head --max-rounds --max-findings --model`
- `/review-memory status|bootstrap|refresh`
- `/review-feedback <id> <decision|priority P0-P3> [note]`
- `/review-remember <scope> <target> <kind> <text>`

Each handler opens an `AppContext` at `ctx.cwd` and closes the memory DB in
`finally`. Lifecycle registers only a `session_shutdown` no-op (SQLite handles
are per-command).

### 4.3 Remote mode — `src/cli/remote.ts`

When transport resolves to remote:

- **`find` without `--repo` takes the bundle path**: the client packs its local
  state (unpushed commits, even an uncommitted working tree via
  `createWorkingTreeSnapshot`) into a git bundle using transient refs
  `refs/pir/bundle-head` / `refs/pir/bundle-base` — the user's index, working
  tree, and refs are untouched. `--base/--head` are pinned to SHAs
  (bundle-materialized repos have no remote-tracking refs), then
  `POST /v1/review {remoteUrl, rootCommit, base, head, bundleBase64, argv}`.
  A `{needFull: true}` response triggers one resend with `base: null` (full
  history bundle). The server needs **no credentials for the client's origin**.
- **Everything else takes the exec path**: `POST /v1/exec {"argv": [...]}`.
- The relay writes `result.log` to stderr, `result.output` to stdout, returns
  `result.code`.

### 4.4 HTTPS service — `src/server/server.ts`

`pir serve` (defaults `0.0.0.0:8790`). Routes:

| Route | Body | Behavior |
|---|---|---|
| `GET /health` | — | `{ok, version, tls}` |
| `POST /v1/exec` | `{argv}` | Runs `executePirCommand` under `cwdGuard: workspace`; refuses recursive `serve`; `UsageError` → HTTP 200 with `code:2` |
| `POST /v1/review` | `{rootCommit, base?, head, bundleBase64, argv?}` | Whitelisted commands (`find memory findings feedback remember verify-fix`); materializes the bundle and reviews it in a throwaway worktree; thin-bundle miss → `{needFull:true}` |
| `POST /v1/memory/sync` | `{projectId, snapshot, dryRun?}` | Re-derives `projectId` from `normalizedRemote+rootCommit` (a token holder cannot clobber another project); merges snapshots server-side |

- **Auth**: bearer token, `timingSafeEqual`. No token configured = open
  endpoint (warned at startup).
- **Serialization**: every POST runs through one promise queue — review
  sessions and the SQLite store assume single-writer access. A `/v1/review`
  holds its queue slot across materialize + execute + cleanup.
- **Limits**: body 1 MB, bundle 256 MB, sync payload 64 MB.
- **TLS**: `--cert/--key` > `PIR_TLS_CERT`/`PIR_TLS_KEY` > self-signed pair
  generated with openssl (persisted, 3650 days) > plain HTTP only when
  `PIR_ALLOW_HTTP=1`.

Server-side state layout:

```
$PIR_REPOS_ROOT/<projectId>/          bare repo + repos.json registry
$PIR_REPOS_ROOT/work/<uuid>/          throwaway review worktrees
$PIR_STATE_ROOT/<projectId>/memory.sqlite   centralized per-project memory
                                       (never inside the worktree)
```

`PIR_KEEP_WORKTREE=1` skips worktree cleanup for debugging.

---

## 5. App layer — `src/app/`

- **`executor.ts`** — `executePirCommand(argv, opts) → {code, output}`: the
  single command path shared by CLI, server, and remote relays. It never
  touches `process.stdout` directly. `ExecOptions`: `onLog` (progress sink),
  `cwdGuard` (server-mode restriction of `--cwd`), `dbPath` (SQLite override
  for bundle/worktree flows). Notable dispatch rules: `config`/`skill`/
  `memory sync` are client-side only (a server invoking them throws);
  `--uncommitted` is find-only and mutually exclusive with `--repo`;
  `--repo` materializes a registered repo into a detached worktree and points
  the run at `reviewDbPath(projectId)`.
- **`context.ts`** — `createAppContext(repoRoot)` → `{repoRoot, memory,
  codeMap, codeMapDegraded, factory}`. Opens the memory DB, creates the code
  map (best-effort index sync unless degraded or `--no-sync-index`), and wires
  a `PiSessionFactory`.
- **`services.ts`** — command implementations behind the executor: memory
  status/bootstrap/refresh/sync, feedback, remember, findings list/show,
  verify-fix. `verifyFix` runs a read-only verifier session: `rejected` ⇒
  trigger gone ⇒ `verifiedFixed`; `confirmed` ⇒ reopened.
- **`find.ts`** — `runFind(ctx, options)` wraps `findIssues` and adds
  `projectId`/`degraded`; `toFindingView` hydrates stored
  anchors/evidence/memoryMatches.
- **`output.ts`** — the JSON envelope: `{schemaVersion: 1, command, ...extra,
  data}`. For `find`, `extra.project = {id, cwd, head}` and `data` carries the
  run record (`run`, `degraded`, `stoppedBecause`, `estimatedTokens`, `usage`,
  `usageComplete`, `durationMs`, `incomplete`, `pendingCandidates`,
  `pendingFindings`, `verificationErrors`, `uncertaintyReasons`, `findings`).
  `findExitCode` implements the exit contract.
- **`repos.ts`** — server-side repo registry (atomic fsync+rename writes,
  cross-process lock), bundle materialization, throwaway worktrees,
  `projectIdFor`.

---

## 6. Core review loop — `src/core/`

### 6.0 Two review modes, one executor

`ReviewTarget` (`core/review-target.ts`) is the discriminated union every
review runs against:

- **change** — attribution semantics: findings must be introduced or unmasked
  by `base..head`; the verifier checks realness *and* attribution.
- **audit** — current-state semantics: findings must exist at the pinned
  `RepoSnapshot` (`changes/snapshot.ts`); there is no base, no merge-base, and
  no attribution. A root commit is a valid audit target.

Both modes share the same reviewer/verifier runners, the same
`drainVerifications` orchestration, `ReviewState`, `Budget`, dedup and
`applyVerdict`. `findIssues` is the change adapter; `auditIssues` schedules
audit **work units** (`core/audit-planner.ts`: deterministic module groups,
line-range chunks for oversized files) through the same machinery with one
global budget, findings ceiling and dedup baseline — never a second loop and
never `findIssues` per chunk. `core/coverage.ts` keeps the per-file coverage
ledger (identity equation exact: `filesTotal = notSelected + excluded +
reviewed + partial + unreviewed + blocked + failed`); a unit only counts as
reviewed when its session finished **and** pinned-read every owned file,
otherwise it is retried (2 attempts) and then blocked with the reason. The
audit output reports coverage as first-class data; budget stops leave files
honestly `unreviewed` and the run `incomplete`. Audit persistence checkpoints
candidates as durable rows at collection time; verdicts update the same row.

### 6.1 Supervisor (`supervisor.ts`)

`findIssues(deps) → FindOutcome`. Defaults: `maxRounds = 2`, `maxTokens`
unlimited (no cap unless `--max-tokens`; rounds/findings/wall-clock still
stop the run), `maxVerifications = 8` per round, `maxFindings = 10` ("a ceiling,
not a target"). Setup: resolve head (`--head` or `HEAD`), base (`--base` or
`head^`), build the `ChangeSet`, create a run row, build the **memory pack
once per run** (keyed on changed paths + head commit), assemble the shared
`ToolContext`.

Round lifecycle, in order:

1. **Exit gates** (before spending anything): reported findings ≥
   `maxFindings`; reviewer signaled completion and the pending queue is empty;
   `shouldStop` (rounds / budget / convergence).
2. **Reviewer session — only when the pending queue is empty.** "Drain
   existing work before paying for another discovery session." The reviewer
   receives `focus`, `priorSummary`, code-only `investigationFeedback`,
   `findingsRemaining`, and `verificationCapacity`. No `finish_round` ⇒
   execution error (candidates retained). Fresh candidates (post-dedup) enter
   `known` and `pending`; **pending is severity-ordered, P0 first**.
3. **Verification drain**: `while (pending && verifiedThisRound <
   maxVerifications && reported < maxFindings && !budget.exhausted())`. Per
   candidate: `matchIssueHistory` → `MemoryMatch[]` → a **fresh verifier
   session** → `applyVerdict`. Provider errors and missing verdicts become
   classified uncertainties (`provider-error`, `missing-verdict`) and bump
   `verificationErrors`. Code-only feedback from the verifier feeds the next
   reviewer round — **only when the verifier neither received nor queried
   historical decisions** (rationales stay verifier-only).
4. **Round record** (`RoundInfo`) + **frontier expansion** from the reviewer's
   `nextFocus`/`unresolvedQuestions` and uncertain-verdict feedback.
5. **Information gain**: a round with zero fresh candidates and zero executed
   verifications is *dry*; two consecutive dry rounds ⇒ converged.

**Failure and limits**: a reviewer error is partially recovered (recorded
candidates are deduped and kept, usage charged, run marked `failed`, error
rethrown). At any stop, remaining pending candidates are **persisted with
status `candidate`** — they never vanish; they surface as
`pendingFindings`/`pendingCandidates` and `pir findings list --status
candidate`. `incomplete` = pending work left, unfinished discovery, or
verification errors.

### 6.2 State (`review-state.ts`)

`ReviewState` tracks `known` (dedup baseline across rounds), `pending`
(verification queue), `verified`, `investigationFeedback`, `rounds`, `focus`,
`priorSummary`, `dryRounds`, budget estimate. `reportedCount` = confirmed +
uncertain — **rejections and decision-suppressed findings do not consume the
report limit.**

**Suppression contract** (`applyVerdict`): a memory match overrides the
verdict's status only when the verifier assessed `stillApplies: true` **and**
the memory's source is trusted (`user_explicit`/`verified_fix`) **and** its
decision is suppressive (`expected`, `false_positive`, `accepted_risk`,
`wont_fix`). This holds even when the verifier technically *confirms* the
problem is real — the finding is recorded under the decision's status, not
silently dropped, and reopens when code changes invalidate the decision.

### 6.3 Frontier (`frontier.ts`)

The frontier is a bounded **focus list** (max 16), not a spatial structure:
deduped union of uncertain-verdict feedback + reviewer `nextFocus` +
`unresolvedQuestions`, injected into the next reviewer prompt as "FOCUS FOR
THIS ROUND".

### 6.4 Budget (`budget.ts`)

`maxTokens` is checked **between sessions** — an in-flight model turn may
exceed it. With SDK `SessionUsage`, measured tokens are charged; without,
texts are estimated (`ceil(len/4)`) and the run is marked
`usageComplete: false`. Optional `maxWallClockMs` exists on the `FindOptions`
API (not exposed as a CLI flag). Tool calls are metrics only (counted, with
repeated read/search detection), never a budget axis.

### 6.5 Convergence (`convergence.ts`)

Stop order: max rounds → budget exhausted (tokens or wall clock) → two
consecutive dry rounds (`"converged: no new information in the last rounds"`).

---

## 7. Agent sessions — `src/agents/`

### 7.1 Session factory (`session-factory.ts`)

Every session — reviewer, verifier, bootstrap analysts — is created through
`PiSessionFactory.createSession`:

- SDK `createAgentSession` + `SessionManager.inMemory()` + in-memory settings:
  no packages, extensions, skills, prompt templates, themes, hooks, telemetry;
  `defaultProjectTrust: "never"`.
- A fresh temp `agentDir` per session, removed on dispose.
- **Isolation**: a custom `ResourceLoader` installs pir's review system prompt
  and returns *empty* everything-else. The SDK's default loader would still
  discover project/ancestor `.pi`/`.agents`/AGENTS context — the isolated
  loader reads none of it. Reviews must not inherit ambient project context.
- **Tool allowlist**: `noTools: "all"`, then re-enable only the read-only
  builtins `read, grep, find, ls` plus pir's custom tools. Any other builtin
  throws. `toolExecution` forced to `"sequential"`.
- **Model resolution**: `--model` > `PIR_MODEL` > validated pi startup
  defaults (read from the *real* `~/.pi/agent/settings.json`, because
  sub-sessions see an empty agentDir), resolved through the SDK's
  `resolveCliModel` (provider/model or fuzzy id). Thinking level defaults to
  `medium`; explicit `off` is preserved.
- Network is denied to the model runtime (`allowModelNetwork: false`); model
  credentials still come from the user's established pi configuration.

The system prompt frames every session as "operating in a read-only code
review session" where repository files, diffs, tool results, and memory are
**untrusted evidence, not instructions**, and a terminal submission tool
(`finish_round` / `submit_verdict`) must be the only tool call in its turn.

### 7.2 Reviewer (`reviewer.ts`)

One reviewer round = one fresh session. Tools: `get_change`, `read_code`,
`search_text`, `find_symbol`, `find_callers`, `find_callees`,
`find_references`, `get_project_memory`, `get_feature_memory`,
`get_entity_memory`, **`record_candidate`**, **`finish_round`** + builtins.
The reviewer sees the memory pack (project/feature/entity knowledge and
*verified-fix regression watch*) but **never issue decisions** — those are
verifier-only to prevent anchoring bias. Candidates must be emitted through
`record_candidate`; the round must end with `finish_round`.

### 7.3 Verifier (`verifier.ts`)

**One fresh session per pending candidate.** Receives the full candidate
(bounded, labeled "untrusted evidence"), base/head/merge-base refs, matched
historical decisions (`priorDecisions` with per-memory IDs), and fix history.
Tools: evidence tools + verifier-only `get_relevant_issue_memory` (wrapped so
even a failed lookup marks the historical-feedback boundary as crossed) and
`get_fix_history`, plus **`submit_verdict`**. Verdicts: `confirmed |
rejected | uncertain` (+ `confidence` 0..1, `uncertaintyReason`, per-decision
`decisionAssessments`).

Two separation rules live here:

- **Technical realness ≠ historical acceptance**: "A team accepting a risk
  does not make a real defect false." The verifier states technical validity
  independently; suppression is applied afterwards by `applyVerdict`, from
  trusted decisions the verifier re-assessed.
- **Bias firewall**: the verifier's `codeFeedback` is discarded whenever it
  received or queried decisions — rationale text must never flow back into
  discovery.

### 7.4 Prompts (`prompts.ts`) & transcripts (`transcripts.ts`)

Prompts are sectioned, deterministic templates: role, change/round line,
process guidance ("trace the minimal causal slice", "actively seek
counter-evidence"), provenance rules (pinned tools are evidence; builtins are
navigation), findings-budget framing, memory pack between `=== REPOSITORY
MEMORY ===` markers.

Transcripts are opt-in (`PIR_TRANSCRIPTS=1`): every session of a run is dumped
as JSON (final SDK session messages — not provider wire captures) next to the
memory DB — deliberately outside the worktree so they survive cleanup in
serve/docker flows. An `effectiveConfig` allowlist records isolation facts
without auth, paths, or ambient settings.

---

## 8. Tools — `src/tools/`

`ToolContext` (`context.ts`) pins `head | base | merge-base` once per run
(WeakMap-cached) and resolves paths safely (no absolute/traversal). All
evidence tools read **immutable git revisions**, never the working filesystem.

**Evidence tools** (`review-tools.ts`, both agents):

| Tool | Purpose |
|---|---|
| `get_change` | merge-base→head diff, paginated (files → hunks → raw lines); removed code recoverable |
| `read_code` | pinned file reads at `revision`, bounded pages with continuation |
| `search_text` | `git grep` at a revision, ERE + git wildmatch globs, 30 s timeout |
| `find_symbol` / `find_callers` / `find_callees` / `find_references` | structural navigation via the code map — every result is prefixed "unpinned … navigation only, not evidence" |
| `get_project_memory` / `get_feature_memory` / `get_entity_memory` | direct memory lookups (knowledge layers only) |

**Collector tools** (`collector-tools.ts`):

- `record_candidate` (reviewer-only): title, claim, trigger, category,
  severity, anchors, evidence. **Server-side validation checks every
  anchor/evidence line range against the pinned head snapshot**
  (merge-base only for entirely deleted files) — the model cannot cite lines
  that do not exist in the reviewed revision. Assigns `F-<round><seq>` and
  builds the finding identity.
- `finish_round` (reviewer-only): summary, nextFocus, needsMoreRounds,
  coverage/unresolved/blockers; one-shot, terminates the session.
- `submit_verdict` (verifier-only): verdict/rationale/confidence, per-decision
  `decisionAssessments` validated against the seeded matched IDs, optional
  `codeFeedback`; one-shot, terminates.
- `get_relevant_issue_memory` / `get_fix_history` (verifier-only):
  historical decisions and resolutions — "verifier-only evidence" by file
  comment.

---

## 9. Findings — `src/findings/`

- **Severity** `P0..P3`; **categories**: correctness, concurrency, security,
  performance, resource-leak, error-handling, api-misuse, regression,
  maintainability, style, other. **Statuses**: `candidate → confirmed |
  rejected | uncertain`, plus decision statuses `expected, false_positive,
  accepted_risk, wont_fix, fixed`.
- **Identity** (`identity.ts`): `fingerprint = sha256(featureKey \0 entityKey
  \0 normalized category \0 normalized claim \0 normalized trigger)` —
  line-number independent, so history matches survive file movement.
  Normalization lowercases, strips markdown noise, and collapses whitespace
  ("retry_count" ≈ "retry count").
- **Dedup** (`dedup.ts`): exact fingerprint equality, else near-duplicate when
  same category + same entityKey + claim token-Jaccard ≥ 0.82. Applied within
  a round and against all candidates accumulated across rounds.

Findings persist through `src/memory/finding-store.ts` (`findings`,
`finding_evidence`, `review_runs` tables; sequential `F-<n>` display IDs per
project; runs recorded with counters and `running → completed | incomplete |
failed` status).

---

## 10. Repository Memory — `src/memory/`

### 10.1 Project identity (`identity.ts`)

```
projectId = sha256( normalizedRemote ?? "local"  +  "\0"  +  rootCommit )
```

`normalizedRemote`: lowercase, strip `ssh://`/`git@`/userinfo, `git@host:`
colon → `/`, drop `.git`, collapse slashes — so `git@github.com:co/app.git`
and `https://github.com/co/app` are the same project. `rootCommit` =
`git rev-list --max-parents=0 HEAD`. Identity survives clones, moves, and
machines; it is never the checkout path, and **never the branch**.

### 10.2 Storage (`sqlite-store.ts`, `migrations.ts`)

`node:sqlite` (`DatabaseSync`), WAL, FK on, 5 s busy timeout. DB location
resolution: explicit `dbPath` > `PIR_MEMORY_DB` > `PIR_STATE_IN_PROJECT=1` →
`<repo>/.pir/memory.sqlite` > `PIR_STATE_ROOT/<projectId>/memory.sqlite` >
XDG state dir per project.

Append-only ordered migrations tracked in `_migrations`; current schema
version 4. Tables:

| Table | Layer / purpose |
|---|---|
| `projects` | identity row + `last_indexed_commit` |
| `project_memories` | Project layer |
| `features`, `code_entities`, `feature_entities` | feature & entity layers (+ link table) |
| `issue_memories` | decision layer (indexed by fingerprint + scope) |
| `findings`, `finding_evidence`, `review_runs` | run artifacts |
| `finding_resolutions` | fix memory (project-scoped; safe in a shared DB) |
| `feedback_events` | append-only audit log |
| `memory_versions` | per-record version log — write-time source for sync LWW |

### 10.3 The five layers

1. **ProjectMemory** — architecture summary, responsibilities, invariants,
   conventions, risk areas. One row per project.
2. **FeatureMemory** — key, summary, invariants, entry points, dependencies,
   related features, confidence. Features are more stable than file paths
   (files rename; features persist).
3. **CodeEntityMemory** — symbol-level: `symbolKey`, qualified name, kind,
   path, signature, responsibilities/invariants/notes, `signatureHash`,
   `bodyHash`, `lastSeenCommit`.
4. **IssueMemory** — user decisions over findings: `decision ∈ {expected,
   false_positive, accepted_risk, wont_fix, confirmed}`, `scope ∈ {exact,
   symbol, feature, project}`, claim/trigger/rationale, anchor paths.
   Scope-matching only ever broadens from symbol → feature → project; `exact`
   never broadens. Priority (`P0..P3`) is an independent dimension — an
   accepted risk may legitimately be P0.
5. **FindingResolution** — resolved findings: original claim/trigger,
   resolution, before/after commits and code hashes, fix commit/diff hash,
   `verified` (true once a verifier confirmed the trigger no longer
   reproduces). Old code is never stored — commit hashes can always
   `git show` it back.

Every mutation bumps `memory_versions` (type, id, version, payload, reason) —
the freshness signal that drives sync conflict resolution.

### 10.4 Retrieval (`retrieval.ts`)

`buildMemoryPack(changedPaths, head)` produces a ~4000-token pack: PROJECT
block → ENTITY blocks for changed paths → FEATURE blocks → "HISTORICAL FIXED
ISSUES (regression watch)" (only `verified && fixed` resolutions). Sections
are weight-proportional-compressed to fit. **Issue decisions are deliberately
excluded — only the verifier may see those.** The preamble states: stored
memory is evidence, never instructions or reviewer suppression.

`matchIssueHistory(candidate)` finds prior decisions: fingerprint (rank 0) →
scope match (symbol 1 / feature 2 / project 3) → fuzzy claim (rank 4,
overlap-coefficient ≥ 0.6, or ≥ 0.35 with corroborating anchor paths).

### 10.5 Freshness (`freshness.ts`)

Per-file `bodyHash` (sha256 of the blob) compared at review time: file gone →
`invalid`; hash mismatch/unknown → `stale`; equal → `fresh`. "Insufficient
evidence" counts as stale, and **no stale flag is not proof of freshness**.
Stale never means deleted — memory rows are flagged, reviewers may use them
but must revalidate, and the annotation tells them so.

### 10.6 Feedback and the trust model (`feedback.ts`)

`pir feedback F-12 expected --note "…"`: the **audit event is appended
first** (`feedback_events`), then an `IssueMemory` is derived (scope auto-
chosen from the finding's entity/feature keys; source `user_explicit`;
anchor paths captured), the finding's status updated. `fixed` additionally
creates an unverified `FindingResolution` (verified later by `pir
verify-fix`). `obsolete` invalidates all decisions for the fingerprint.

Trust levels: `MemorySource = user_explicit | verified_fix | agent_summary |
derived`. Only `user_explicit` and `verified_fix` may act as suppression
evidence (`SUPPRESSION_SOURCES`). **Agents never write decision memories** —
bootstrap output is all `source: agent_summary` navigation-grade context;
`pir remember` stores user text as `user_explicit`.

### 10.7 Bootstrap and refresh (`bootstrap.ts`)

`pir memory bootstrap` (explicit, never automatic during review): modules
grouped from the code map (capped batches), one **isolated analyst session
per module** ("never the whole repo in one context"), one aggregation
session clustering module summaries into project memory + features +
entities, all `source: agent_summary` with per-file hashes recorded. Ends by
setting `last_indexed_commit`.

Re-bootstrap replaces only entries the previous agent pass generated
(`agent_fields`, migration v3) — user-added entries always survive.

`pir memory refresh` is incremental: diff `last_indexed_commit..HEAD`, mark
mismatched entities stale, re-summarize only affected files.

### 10.8 Remember (`remember.ts`)

`pir remember` / `/review-remember` — direct user knowledge at three scopes:
project (`invariant`→invariants, `note`→conventions, `risk`→riskAreas),
feature, symbol. Stored `user_explicit`, outranks every agent summary, may
act as suppression evidence.

### 10.9 Sync (`sync.ts`)

Local and server memories are separate SQLite DBs keyed by the same
`projectId`. `pir memory sync` exports a snapshot, the server runs the **same
deterministic merge** server-side, returns the merged snapshot, and the client
applies it — both sides converge.

- Syncable: the seven knowledge tables. `findings`/`review_runs`/
  `feedback_events` are session artifacts and stay local.
- Conflict resolution: source rank (`user_explicit > verified_fix >
  agent_summary > derived`) → newer write (from `memory_versions`) → table
  hooks (features prefer higher confidence; verified resolutions beat
  unverified regardless of time).
- Fingerprinted tables (`issue_memories`, `finding_resolutions`) merge
  **group-wise**: a contested fingerprint keeps one side's rows wholesale —
  never twin live decisions.
- Memories are never deleted; staleness is a flag. `--dry-run` reports
  without applying (and without leaving server-side traces).

---

## 11. Changes — `src/changes/`

- **`git.ts`** — every git call is `execFile("git", ["-C", root, ...])` with
  timeouts and output caps; `rev-parse --verify --end-of-options` +
  NUL-rejection guards ref injection. `createWorkingTreeSnapshot` builds a
  commit object for the working tree via a temp index (`add -A`, excluding
  `.pir`) and `write-tree`/`commit-tree` — reviewing uncommitted code
  **without touching the user's index, HEAD, or branches**.
- **`diff.ts`** — unified-diff parser (quoted paths, rename/copy, binary
  tolerance), added-line tracking.
- **`change-set.ts`** — `ChangeSet {base, head, mergeBase, files, patch,
  churn}`: resolves commits, computes the merge base ("actual old side of
  the three-dot diff"), fetches patch + name-status in parallel, reconciles
  A/D/R/M statuses.

---

## 12. Codemap — `src/codemap/`

`CodeMapProvider` is pir's own interface (`searchSymbols`, `callers`,
`callees`, `dependents`, `affectedTests`, `fileOverview`, `status`,
`ensureSynced`). Two implementations:

- **`CodeGraphCliAdapter`** — spawns the external `codegraph` CLI per call
  and parses JSON (process-level isolation; nothing is imported from the
  codegraph package). `ensureSynced` syncs only an existing index — pir never
  initializes one. Timeouts: 30 s queries / 120 s sync.
- **`DegradedCodeMap`** — when codegraph is absent/uninitialized/timed out.
  Structural queries throw `CodeMapError("not_initialized")` so agents adapt
  (the reviewer prompt notes the missing structural index);
  `fileOverview` falls back to a filtered directory walk.

The code map is an **ephemeral structural index** ("what the code is now");
it is never copied into memory DBs, which hold *semantic* knowledge.

---

## 13. Language packs — `src/plugins/` and `plugins/`

Language packs give the general finding loop language/framework-specific review
directions (Go today; Java/React follow the same shape). A pack is **pure
data**: `plugins/<name>/plugin.json` (name, version, marker files, extensions,
guidance paths) plus `guidance/reviewer.md` and `guidance/verifier.md`.
Packs ship inside the npm package (`files` includes `plugins/`); there is no
runtime plugin discovery and no code execution — a pack cannot add tools,
categories, or anything beyond its two guidance documents.

- **Loading** (`loader.ts`): `loadBuiltInPacks()` reads the shipped directory
  (resolved relative to `dist/`), hand-validates manifests, and **fails loud**
  on damage — a broken built-in pack is a release bug, not user input.
  `renderGuidance()` renders the per-role prompt section under a hard
  **8000-character budget** (over-budget content truncates with an explicit
  marker) so packs cannot bloat sessions.
- **Activation** (`detect.ts`): default `auto` — a pack activates when any of
  its `detect.markerFiles` exists at the **reviewed head commit** (pinned, via
  `git cat-file`, like every other evidence read; the working tree never
  influences activation). `--plugins golang,react` selects manually, `--plugins
  none` disables; unknown names are usage errors listing what exists.
  `pir plugins list` shows every pack and what the current repo activates.
- **Injection**: `resolveLanguagePacks()` runs once per `find`; the supervisor
  passes the rendered sections through `languageGuidance` into every reviewer
  round and verifier session, ahead of the memory blocks. Guidance length is
  charged to the token budget as prompt text. The envelope and human output
  report `plugins: [{name, version, activation}]` for transparency.
- **Trust model**: guidance is *trusted instructions*, same trust line as the
  rest of the prompt — it comes exclusively from pir's own shipped packs and is
  never derived from repository content. This is deliberately separate from
  repository memory, which stays untrusted evidence (§2.4). Third-party packs
  are a non-goal until an explicit trust model exists.
- **Content discipline** (golang pack): directions are defect patterns with
  change attribution — concurrency lifetimes, error-chain breaks, typed-nil,
  slice aliasing, backend/DB boundaries, API/JSON compatibility breaks, and
  tests that hide bugs — not style rules (gofmt/lint territory). Verifier
  playbooks are falsification scripts, including a **version gate**: read the
  `go` directive in go.mod before believing version-dependent claims (loop
  variable capture is fixed at go ≥ 1.22, math/rand auto-seeds at ≥ 1.20).
  `bootstrap.ts` also unions pack extensions into its code-file filter.

---

## 14. Configuration and environment

`~/.pir/config.json` (chmod 600): `{mode: local|remote, server: {url, token,
insecure}, model}`. Transport precedence and the wizard live in
`src/cli/config.ts`.

| Variable | Effect |
|---|---|
| `PIR_CONFIG_DIR` | relocate `~/.pir` |
| `PIR_NO_WIZARD` / `--no-wizard` | suppress first-run wizard |
| `PIR_SERVER_URL`, `PIR_MODE`, `PIR_SERVER_TOKEN`, `PIR_INSECURE` | transport overrides |
| `PIR_MODEL` | default model (after `--model`, before config) |
| `PIR_MEMORY_DB` | explicit memory DB path |
| `PIR_STATE_ROOT` / `PIR_STATE_IN_PROJECT` | state layout (server / docker exec mode) |
| `PIR_REPOS_ROOT`, `PIR_KEEP_WORKTREE` | server repo registry & worktree retention |
| `PIR_TRANSCRIPTS=1` | dump session transcripts |
| `PIR_TLS_CERT`, `PIR_TLS_KEY`, `PIR_CERT_DIR`, `PIR_ALLOW_HTTP` | server TLS |
| `PIR_WORKSPACE`, `PIR_SERVER_TOKEN` | serve defaults |
| `PI_AUTH_JSON`, `PI_API_KEY__<provider>`, `PI_DEFAULT_PROVIDER/MODEL/THINKING_LEVEL` | model credentials (docker seeding) |

---

## 15. Deployment

Two-stage Dockerfile (`node:22-bookworm-slim`): installs `git ripgrep
openssl`, optionally `@colbymchenry/codegraph`, runs as `node` with
`/workspace` and `/data` volumes, `ENTRYPOINT pir-entrypoint`. The entrypoint
seeds `~/.pi/agent` from a read-only `/pi-config` mount and merges
`PI_AUTH_JSON` / `PI_API_KEY__*` env into `auth.json`. Two modes:

- `docker run -v $PWD:/workspace pir <cmd>` — state in `<repo>/.pir/`
- `docker run -p 8790:8790 pir serve` — via `docker-compose.yml`
  (`PIR_SERVER_TOKEN` required; repos/state in named volumes) or the
  interactive `docker/deploy.sh` QA wizard (token, provider/model/key, port,
  TLS; writes a chmod-600 `.env`, health-checks, verifies model access).

CI (`.github/workflows/ci.yml`, `docker.yml`) builds, smoke-tests, and
publishes the package and the `ghcr.io/beiyanpiki/pir` image on every push to
`dev`.

---

## 16. Repository layout

```
src/
├── index.ts            library entry (re-exports every layer)
├── cli/                CLI bootstrap · arg parsing/executor · config/wizard ·
│                       remote relay (bundles) · drain-safe exit
├── extension/          Pi extension: /review-* commands, lifecycle
├── server/             HTTPS service: routes, auth, queue, TLS
├── app/                executor-adjacent services · context · find flow ·
│                       JSON envelope · server repo registry/worktrees
├── core/               supervisor · review state · frontier · budget ·
│                       convergence
├── agents/             session factory & isolation · reviewer · verifier ·
│                       prompts · transcripts · model catalog
├── tools/              tool context (revision pinning) · evidence tools ·
│                       collector tools (record/finish/verdict/decision lookups)
├── findings/           types · fingerprint identity · dedup
├── memory/             sqlite store & migrations · identity · five layer
│                       repos · retrieval · freshness · feedback · bootstrap ·
│                       remember · sync · finding store
├── changes/            git · diff parsing · change-set
├── codemap/            provider interface · codegraph CLI adapter · degraded
└── plugins/            built-in language packs: loader · marker detection ·
                        guidance rendering (budgeted)
plugins/                shipped pack data: golang/, typescript/{plugin.json,
                        guidance/*.md}
tests/
├── unit/               model-free unit tests (dedup, identity, memory,
│                       prompts, session factory, tools, …)
├── integration/        review loop, extension, cli, server, sync, supervisor
├── fixtures/           git fixture helpers
└── eval/               labelled scenarios · paired runs · scoring
docker/                 entrypoint · auth seeding · deploy wizard · pi-config
skills/pir/SKILL.md     installable skill teaching agents to drive the CLI
docs/                   README.zh-CN · for-llm · design (this file) · review-loop
```

---

## 17. Testing and evaluation

- `npm test` — model-free regression suite (unit + integration): builds, then
  runs against fixtures; covers tools, scheduler, session isolation, scoring.
- `PIR_EVAL=1 node tests/eval/run-eval.js` — live evaluation with a real
  model: labelled scenarios, paired baseline/candidate runs on identical
  committed fixtures with independently copied memory state.
- Scoring is one-to-one matching with claim/location/category/severity
  constraints: extra and duplicate reports count **against** precision;
  uncertain matches do not count as confirmed. Watch precision/recall together
  with token usage, wall time, verification errors, and pending candidates —
  and report repeated runs. The headline metric for memory quality is
  **repeated false-positive rate**: after the user explains a finding once,
  it must not come back (unless reality changed).

---

## 18. Key decisions and why

| Decision | Rationale |
|---|---|
| Repository Memory in SQLite, not chat history | Long sessions pollute reasoning; structured rows are queryable, syncable, and inspectable. Sessions stay short and disposable. |
| `projectId` from remote + root commit | Memory must survive clones, path moves, and machines — and branches must never fork it. |
| Reviewer blind to decisions, verifier re-assesses them | Prevents anchoring ("this was called false-positive before → skip it") while still reopening decisions when code drifts. |
| Suppression requires `user_explicit`/`verified_fix` + verifier re-assessment | Memory is evidence, not truth. An agent must never be able to talk itself out of a finding. |
| Fingerprint = semantic hash, not file:line | Line numbers drift; "same claim about the same symbol in the same feature" is the identity that matters. |
| Evidence tools pinned to git revisions | The reviewed snapshot is immutable and reproducible; builtin fs tools are navigation only. Anchor validation at submission catches fabricated lines. |
| One target-aware executor for change and audit modes | A second supervisor per review flavor would fork budgets, dedup and suppression semantics; `ReviewTarget` + shared drain keeps one loop with two adapters. |
| Audits review a pinned snapshot, never an empty-tree diff | Current-state semantics are not "everything ever added"; no fabricated base also makes root commits valid audit targets. |
| Audit coverage is process accounting, reported per file | A finished session with pinned reads of owned files is the honest definition of "reviewed"; budget stops surface as `unreviewed`/`incomplete`, never as a clean sweep. |
| Memory sync wire version pinned independently of migrations | Run-local tables (modes, coverage) must not break snapshot exchange between pir versions. |
| Bundles for remote review | The server needs no origin credentials, and unpushed/uncommitted code reviews fine — the client ships its actual state. |
| One executor for CLI/extension/server/remote | Feature work lands once; every face inherits it, and the JSON/exit contract stays identical everywhere. |
| Pending candidates persisted at limits | Budget exhaustion must never silently discard work; `candidate`-status rows keep it inspectable. |
| Optional codegraph behind an interface | Symbol structure is valuable but must stay swappable and degradable; nothing structural leaks into memory. |
| Language packs are data, not code | Language-specific review directions ship as pir-owned markdown under a hard character budget, activated by marker files pinned to head. No runtime discovery or execution; the trust line (trusted guidance vs untrusted memory evidence) stays crisp. |

---

*Historical note: this document replaced the original conversational design
spec. The original's core ideas — the finding loop, five-layer memory, trust
boundaries, evidence-not-instructions — shipped and are described above as
implemented.*
