# ADR 0004: Change-mode review pipeline — selection, coverage, duplicate feedback and per-file attention

## Status

**Accepted (2026-10-19; consolidated 2026-10-27).** Four decisions about what
a change-mode reviewer sees and what feedback it gets, all delivered in PR
#146:

| Part | Decision | Source | Outcome |
| --- | --- | --- | --- |
| I | Change-mode file filter — one shared selection gate | ADR 0004 | accepted |
| II | Coverage manifest — no new contract | ADR 0013 | rejected as a new contract; derivation rule recorded |
| III | Visible duplicate feedback in `record_candidate` | ADR 0014 | accepted |
| IV | Lightweight per-file attention prompt | ADR 0017 | accepted; recall effect not measured |

Source numbers are the retired per-decision ADRs; the [consolidation
map](README.md) records the mapping.

## Part I — Change-mode file filter

### Context

`pir audit` filters its scope (default exclusion globs, binary classifier,
1MB per-file cap, `--dry-run --list-files`); `pir find` had nothing. Every
file in merge-base..head was readable through `get_change`, including
lockfiles, generated bundles, vendored trees, binaries — and secrets (`.env`,
`.ssh`, registry credentials). Diff lines page 120 at a time, so one generated
file could consume a session's budget.

OCR solves this with a **six-gate pure filter** (`internal/agent/selection.go`,
`whyExcluded`; surveyed at `8eb8334`, Apache-2.0) in fixed order — binary →
secret paths → exclude → include → extension allowlist → built-in excludes —
plus post-gates for deleted files and oversized diffs. Three properties are
load-bearing: the secret gate is absolute (no user rule rescues it); preview
and the real run call the same `selectFiles` function; and dispatched subtasks
see global metadata but never other groups' patches.

The counter-risk decides the rest: filtering that hides files turns "no
findings" into "not looked at". The reviewer must still know a file changed,
and the operator must see what was withheld and why.

### Decision

1. **One shared policy module, `src/changes/filter.ts`.** Exclusion globs, the
   binary-extension set, `MAX_AUDIT_FILE_BYTES`, the tree-entry classifier,
   glob matching and include normalization move there with `FILTER_VERSION`
   (audit persists it as `scopeVersion`). `snapshot.ts` consumes the module
   and re-exports the pre-split names; `pir audit --dry-run` output is
   byte-identical to before, so the modes cannot drift.
2. **Four gates after `buildChangeSet()`, fixed order**, with include as the
   escape hatch for the last two:
   - **binary**: checked on both sides of a rename; not overridable.
   - **secret paths**: the table below; not overridable by include or skip.
     Renames are checked on both paths, so moving a key out of `.ssh/` does
     not launder it.
   - **include scope**: `--path`-style literal prefixes; outside a non-empty
     include set a file is `not-included`.
   - **skip patterns**: explicit `--skip` globs, then the default policy
     (dependencies, build output, lockfiles, minified output).
   - **oversized single-file diff**: `MAX_DIFF_FILE_BYTES`.
   An explicitly included file bypasses only the last two gates — an explicit
   ask — while binary and secret stay absolute, as in OCR.
3. **Secret table (versioned).** `**/.ssh/**`; `id_rsa*`, `id_dsa*`,
   `id_ecdsa*`, `id_ed25519*`; `**/.netrc`, `**/.npmrc`, `**/.pypirc`,
   `**/.dockercfg`; `**/.env`, `**/.env.*`. Basenames `.env.example`,
   `.env.sample`, `.env.template` are exempt: checked-in examples are
   documentation. The `**/` prefix is deliberate — these files are secret
   wherever they live. A false exclusion costs one unreviewed diff the
   reviewer still sees as metadata; a false inclusion costs a leaked
   credential.
4. **Excluded ≠ invisible.** An excluded file keeps all metadata (path, status,
   churn, language) and gains `excluded` + `excludedReason`; its hunks are
   emptied **at the source**, so the property belongs to the `ChangeSet`.
   `get_change` lists the file with its reason and refuses to page its hunks;
   the coverage ledger never counts them (no unreachable denominator); the
   reviewer knows the file changed even though it cannot read the patch.
   Because that covers only the diff channel, the secret gate is enforced on
   the pinned read channels too: change-mode `read_code`, `search_text` and
   collector evidence reads refuse a secret path on every revision (dogfood
   F-177). Audit never sets that guard. A change set with nothing excluded is
   returned unchanged.
5. **Envelope change is purely additive.** `data.run.files[]` gains
   `excluded` (always) and `excludedReason` (excluded only); the four pre-filter keys
   keep their names and values; envelope and run manifest share one
   `changedFileSummary()` projection.
6. **`MAX_DIFF_FILE_BYTES = 200_000`**, measured on the pageable diff body
   (hunk headers plus raw diff lines, UTF-8). That is ~50k tokens for one file
   and ~45+ pages at 120 lines a call — more than a one-or-two-round session
   reads, and enough to consume its budget. It is deliberately below audit's
   1MB cap because audit spreads a file across work units while change mode
   hands it to one session. The boundary is exact: at the cap selected, one
   byte over excluded.
7. **`pir find --preview` reuses the same pure function.** It calls
   `buildChangeSet()` plus the same `selectChangeFiles()` that
   `applyChangeFilter()` runs, printing the per-file result (path, status,
   churn, selected/excluded, gate, reason) as text and `--json`. No run row,
   no session, no writes; run-shaping flags are usage errors, not silent
   no-ops (the `audit --dry-run` precedent, #56).
8. **No new include flag in this change.** find passes defaults; the include/exclude
   parameters are the seam the project rule file wires into — a behavior gate, not a
   configuration feature.

### Consequences

- Change mode stops spending reviewer budget on binaries, lockfiles,
  generated output and vendored trees; secret paths cannot reach a prompt
  through any pinned channel; audit and change mode share one policy table;
  the coverage denominator stays reachable; selection is auditable before a
  run is paid for. The end-to-end benchmark is the surface meant to measure the effect on real PRs.
- The recall trade is real: an interesting lockfile or generated-file change
  is no longer diff-reviewed by default, and the 200KB cap can withhold a
  large hand-written diff (the reviewer can still read the file at head).
  the project rule file is the sanctioned explicit include. Ordinary `.npmrc`
  config changes are withheld because the gate cannot tell a registry URL from
  an auth token.
- Audit behavior is unchanged, so include semantics differ by mode — audit's
  `--path` narrows scope without bypassing its policy, change mode's include
  bypasses skip/size gates. Both are pinned by tests and stated in preview.
  The SDK's builtin `read`/`grep` read the working tree, not the pinned
  revision, and stay outside this gate.

## Part II — Coverage manifest: no new contract

### Evidence

**1. The surface already exists.** Change mode records `hunksTotal` /
`hunksCovered` / `filesTotal` / `filesCovered` and a per-file
`{ path, covered, total }` list (capped at 200) on the manifest and each
round (`src/core/change-coverage.ts`, `RunManifest.changeCoverage`). A hunk
counts as covered only through a deliberate read — paged `get_change` or a
head-revision `read_code` window intersecting it — never through listings or
collector evidence. Part I adds `excluded`/`excludedReason` to the same
file list. Audit already has its per-file ledger (`reviewed`, `partial`,
`unreviewed`, `blocked`, `failed`). All of it is exposed by the web
coverage endpoint, `pir runs status` and `docs/for-llm.md`.

**2. No consumer asks for the new vocabulary.** The web run detail,
`pir runs status` and `pir audit coverage` read the current fields. The end-to-end benchmark
driver deliberately does not persist coverage (a row records findings and
cost; the judge never needs hunk coverage). No issue, dogfood finding or ADR
requests per-file terminal states or coverage-gated completion; the only
source is OCR's manifest, and the series pursues measured gaps, not parity.

**3. Terminal states are derivable from the two existing fields.** For a file
in `changeCoverage.files`: `covered === total` → reviewed;
`0 < covered < total` → partial; `covered === 0` → unreviewed. Excluded
files are already terminal in `files[]` and deliberately absent from the
denominator (Part I §4). A second state machine would duplicate that and
create two sources of truth. The only missing value, "skipped/not selected",
is an audit-mode concept; change mode's denominator is the reviewed diff, so
there is nothing to call skipped.

**4. Gating `incomplete` on coverage would reverse the coverage ledger's stance.** That
ledger decided coverage never gates, suppresses or drops findings; the one intervention is
one forced follow-up round listing unread hunks. Tying clean completion to
coverage would turn a quality signal into a correctness gate, change the
`incomplete`/exit-code contract automation depends on (ADR 0001,
`docs/review-loop.md`), and mark ordinary large reviews incomplete whenever
a hunk is unreachable. No consumer has asked for it.

### Decision

**Reject the new contract; keep the existing two additive surfaces.** Do not
add a per-file state field and do not gate `incomplete` on coverage. The
documented derivation for automation: join `files[]` (exclusion) with
`changeCoverage.files` (hunk coverage), derive reviewed/partial/unreviewed
as above, and treat `excluded` as terminal-but-outside-the-denominator.
`incomplete` stays tied to actual unfinished work: pending verification,
verification execution errors, unfinished discovery, unfinished audit
coverage.

### Revisit conditions

- **A real consumer that cannot join the two artifacts** — a SARIF/coverage
  export, a CI consumer, or a client needing one frozen per-file picture.
- **A shared cross-mode schema** — if web or export clients need change and
  audit coverage to share one vocabulary, design it once for both.
- **Part I's exclusion vocabulary proves insufficient** — extend the
  `excluded`/`excludedReason` pair rather than adding a parallel state
  machine.
- If reopened, additive only: `files[].state` ∈ {reviewed, partial,
  unreviewed, excluded}, with no gating of completion.

### Consequences

- No code change; the current fields stay the contract, and the derivation
  rule is recorded so the omission is a decision, not an oversight.
- The coverage ledger remains the denominator for the forced round;
  `incomplete` keeps its meaning and exit-code behavior.
- The remaining gap is documentation/discoverability: automation joins two
  documented fields, and the join is now written down.

## Part III — Visible duplicate feedback in `record_candidate`

### Context

`record_candidate` answers with `Recorded candidate F-X: <title>` whether
the candidate is a new defect or a restatement of one the run already holds;
duplicates are resolved afterwards in the supervisor by
`deduplicateCandidates`. The model therefore cannot distinguish "new" from
"overlaps an existing finding". This is a **feedback gap, not a lost-record
bug**: the candidate is recorded, deduplicated and reported exactly as before,
but the session cannot state how a different defect differs and can burn a
slot on a pure restatement. OCR treats the same blind spot as a tool-surface
defect: an empty or no-op submission must error rather than return a
success-shaped confirmation.

### Evidence

**1. The gap is structural.** The reviewer prompt carries the diff, memory,
focus, rules and the previous round's summary, but never the accumulated
candidate set: `state.known` is the dedup baseline, not prompt content. The
confirmation is the only moment a session could learn about an overlap.

**2. The comparison boundary is narrower than dedup's.** Dedup runs on the
merged output of every session in a round. Prior-round `state.known` is
stable and already the strict baseline, so it can be shown; the session's own
earlier candidates can be shown; a parallel angle session's same-round
candidates cannot (they arrive concurrently, the cross-angle merge relaxes
the category gate and can displace a less severe representative, and merging
mid-run needs shared mutable state). The supervisor stays the only place
those collapse.

**3. The hint must use the dedup rule literally.** A different predicate
would promise a collapse that will not happen or stay silent on one that
will. `duplicateMatch` is extracted as a pure, read-only predicate and used
by both: exact fingerprint first, then same entityKey with same category and
claim similarity at or above the threshold. Scanning order is shared too:
prior-round knowledge, then the session's own earlier candidates.

**4. Wording is contract.** The sentence states the candidate **was**
accepted and recorded for deduplication, names the overlapped finding and
criterion, tells the model to state the difference when the defect is
genuinely different, and forbids only resubmitting the same finding. It never
says the finding will not count, never blocks submission, never touches
severity, and adds no required parameter.

**5. The no-overlap path stays byte-identical.** Dedup, `displayId`
assignment, the reporting cap and the verifier are untouched; the hint is
computed only after a candidate fully validated, so a rejected submission
reports no hint and mutates nothing.

### Decision

Attach an **optional, visibility-only duplicate hint** to the
`record_candidate` result.

- Baseline: a snapshot of prior-round knowledge taken at session start
  (`ReviewerDeps.known` → `CandidateCollector.known`, from `state.known`
  in both change-mode paths and audit) plus the same collector's earlier
  candidates. Read-only: the tool never mutates it, never adds the round's
  output, never calls `deduplicateCandidates`.
- Overlap rule: `duplicateMatch` with the strict prior-round gates (no
  cross-angle relaxation).
- Result: the unchanged `Recorded candidate F-N: <title>` line, then
  `Accepted and recorded for deduplication. It overlaps an existing finding
  (F-12) by fingerprint|claim similarity. If it is materially different,
  state the difference in the claim/trigger. Do not resubmit the same
  finding.` The structured `duplicateOf` field rides on the tool output for
  tests and observability and is never forwarded to the model.
- No new required parameter, no new tool, no request-envelope change, no
  cross-angle state.

### Revisit conditions

- **The hint suppresses genuine findings** — dogfood or a benchmark shows
  sessions dropping a second, materially different defect because "Do not
  resubmit" was over-read. Rewrite the sentence or gate the hint.
- **The hint inflates volume** — the model restates the overlapped id to
  appear different. Tighten the overlap rule or the sentence, not dedup.
- **Cross-angle state becomes shareable cheaply** — re-examine the narrower
  boundary instead of assuming it.
- **Dedup's predicate changes** — because the hint reuses `duplicateMatch`,
  any change there re-opens this part's wording review.

### Consequences

- A session can tell a restatement from a new defect when it submits, and
  spend its remaining effort on the difference.
- Hint and dedup cannot drift: one predicate, one scan order.
- Dedup, `displayId`, reporting counts, severity rules and the verifier are
  unchanged; the no-overlap path is byte-identical.
- Parallel angle sessions keep independent hints; cross-angle and same-round
  duplicates remain visible only in the supervisor's merge.

## Part IV — Per-file attention prompt

### Context

The end-to-end benchmark reports weak recall across sizes: `≥500` lines is 31 PRs / 469 references
/ 8.8% recall (`confirmedOnly` 8.2%), `50–199` lines is 68 PRs / 443
references / 9.2% ([the end-to-end-benchmark results](../../tests/eval/aacr/results/M1-2026-10-26-full-roadmap.md)).
Two caveats travel with the signal: the `≥500` bucket is substantial, and the
reference population is maintainability-heavy, a category pir deliberately
de-emphasises — so no single intervention is expected to move
`balanced_score` alone.

OCR injects the changed-file list and asks for a pass per `<review_files>`
entry. pir does not list changed files at all: the reviewer discovers them
through `get_change`, one file at a time, so the shape of the whole change is
never visible before the first read. That is a plausible mechanism for a file
never entering the investigation, but a hypothesis on a directional signal,
not a measured cause. The plan phase is a separate decision point and must
not ride along; the reviewer cannot be asked to read more than it already
reads. This part adds **attention**, not work.

### Decision

1. **Inject a bounded `CHANGED FILES` section** into the change-mode
   reviewer prompt: `path`, `status`, churn, and the exclusion reason for a
   withheld file. The data is the existing `changedFileSummary` projection,
   the same one the envelope and `run.json` record, so the prompt cannot
   disagree with the run log. Nothing new is computed from git.
2. **Cap at 60 entries with an explicit remainder line.** The heading count is
   always the true total, so a truncated list never reads as complete.
3. **Place it after the change line (and angle block) and before
   `PROCESS`** — the map before the method. Evidence and memory stay last.
4. **Ask for per-file accounting in the existing vocabulary.** Before
   `finish_round`, each listed file is investigated or explicitly skipped
   with a reason in `coverage`; a silently omitted file is not a skip; and
   the text says outright this is **not a hard error** — accounting is
   required, reading is not. It also names the tool's limit: `coverage` holds
   40 entries, so a longer list groups related files instead of dropping any
   (dogfood F-3 caught the first draft contradicting the tool).
5. **Zero extra calls, no state, no enforcement.** No new model call, tool,
   read requirement, ledger change or manifest field. Rounds 2+ and angle
   sessions get the same list; audit keeps its owned-range prompt; verifier
   prompts are untouched.
6. **Absent or empty change set renders nothing**, so the prompt is
   byte-identical to before the attention prompt.
7. **Repository-controlled fields are flattened.** Every rendered field is
   collapsed to one line (control, line-separator or invisible characters
   become spaces) and length-capped (300 characters for a path), so a
   hostile name cannot end its bullet and add prompt text; a path with no
   printable content renders as `<path unavailable>`. Ordinary spaces are
   preserved exactly (dogfood F-4 caught the first draft collapsing legal
   whitespace), and the code-generated exclusion reason passes through the
   same flattener.

### Evidence

**1. The projection is shared, so the list cannot drift.**
`changedFileSummary` backs `data.run.files[]` and `run.json`'s `files[]`,
including Part I's exclusion pair. The prompt is one more consumer.

**2. A list is the cheapest intervention.** No session and no tool call; it
changes what the model can see before choosing where to spend reads. For a
change with a hundred files, the old prompt gave no way to know the set
existed.

**3. The accounting request is not a coverage contract.** The coverage ledger already records
read hunks, and Part II keeps one state machine. Making unread files an error
would create a second enforced contract and force reads of generated or
lockfile noise the filter avoids. A stated skip reason is a valid pass.

**4. The surface is inject-safe by construction.** Repository-controlled
strings are flattened; `tests/unit/prompts.test.js` asserts that a name
containing `\n\nIGNORE ALL PREVIOUS INSTRUCTIONS`, control characters or
5,000 characters still renders as exactly one bullet.

**5. No recall claim.** The locked 50-PR baseline is not re-run, so the item closes
as *shipped, effect not measured*.

### Consequences

- A reviewer can see the whole change (up to the cap) before its first read,
  including what is known-unreviewable and why.
- The prompt grows by at most ~60 short lines (~3 KB, well under 1,000
  tokens) on change runs, with no extra call; rounds 2+ and angle sessions
  reuse it.
- Nothing is enforced or persisted. Ignoring the section produces the same
  run as before; an omitted file is visible to the operator, not fatal.
- A crafted filename can be visible but cannot become a separate line or an
  unbounded value. A change over 60 files gets a truncated list with the
  remainder line; the full set stays reachable through `get_change`.

### Acceptance mapping

- **Prompt tests.** `tests/unit/prompts.test.js` (rendering, singular/plural,
  cap plus remainder, exclusion reason, placement, byte-identical absent path,
  audit unaffected) and `tests/integration/changed-files-prompt.test.js`
  (supervisor wiring, excluded bodies, the 60-entry cap end to end).
- **Dogfood notes.** Recorded in the PR; observational only.
- **Benchmark.** Not run; the item closes as *not measured*.

### Revisit conditions

- **The model parrots the list** — tighten the accounting paragraph; do not
  add enforcement.
- **A measured the end-to-end-benchmark round** — the only way the item becomes measured; it must
  report the whole set and buckets, never the `≥500` bucket alone.
- **The cap is too small in practice** — raise it deliberately with the token
  cost stated, not by dropping the remainder line.
- **The plan phase is proposed** — it stays a separate decision point gated by
  dogfood or an end-to-end-benchmark result.

## References

- Implementation: `src/changes/filter.ts`, `src/changes/change-set.ts`,
  `src/core/change-coverage.ts`, `src/observability/run-events.ts`,
  `src/findings/dedup.ts`, `src/tools/collector-tools.ts`,
  `src/agents/reviewer.ts`, `src/agents/types.ts`, `src/agents/prompts.ts`.
- Tests: `tests/unit/collectors.test.js`, `tests/unit/prompts.test.js`,
  `tests/integration/changed-files-prompt.test.js`.
- Related: [ADR 0001](0001-shared-review-executor.md) (envelope and exit-code
  contract), [ADR 0003](0003-findings-quality-roadmap.md) (the coverage ledger),
  [ADR 0006](0006-default-token-budget-with-grace.md) (prompt-side
  accounting), [ADR 0011](0011-deferred-and-rejected-directions.md)
  (cross-angle merge boundary), [ADR 0016](0016-invocation-inputs-outputs-and-long-runs.md)
  (the other Iteration 3 input).
- Contracts: `docs/for-llm.md`, `docs/review-loop.md`, `docs/design.md`.
- External: OCR `alibaba/open-code-review` (Apache-2.0), `8eb8334` and
  `375f64c`.
