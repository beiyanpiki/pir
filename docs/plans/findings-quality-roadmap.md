<!-- DEVELOPMENT RECORD — NOT PERMANENT DOCUMENTATION.
     This file tracks the findings-quality roadmap implementation series.
     When every task in the tracking issue is done, DELETE THIS FILE; the
     durable record is ADR 0003 plus whatever design docs the series lands.
     The PR-series and sequencing sections below describe the development
     process, not a supported interface. -->

# Findings-quality roadmap — implementation plan

Decision record: [ADR 0003](../adr/0003-findings-quality-roadmap.md).
This document is the implementation plan for that decision: the PR series,
per-slice designs down to signatures and edge cases, tests, live QA,
acceptance criteria, and the benchmark protocol that judges them.
Progress is tracked in issue #73; this file is re-synced to reality as
slices land.

**Status (post-Q3).** D1 (this plan + ADR 0003) merged via #74; B1 merged
via #76; Q1 merged via #78; Q2 merged via #80; Q3 merged via #81. The
original D1-rooted stacked-PR convention was retired when D1 merged —
every landed slice branched off `dev` directly and later slices do the
same (see "PR convention"; ADR 0003's process paragraph is amended to
match). **Next slice: Q4 — persisted confidence, `--min-confidence`
split, run-level verdict.**

## Goals

1. **Recall (coverage):** more of the real, introduced-by-change defects in
   a diff get found — measured, not felt.
2. **Precision:** fewer false positives reach the report — targeting the
   measured root cause (context failures, ~87% of rejected findings).
3. **Measurability:** every behavioral change in the series is measured
   (scenario harness per PR; ReviewBench delta rows — waived for
   pre-baseline slices by the deferral decision, active from the baseline
   onward — see the benchmark protocol); changes that cannot justify
   themselves are reverted or stay behind default-off flags.

## Non-goals

- Leaderboard submission or the ReviewBench docker agent contract
  (`AGENT_CONTRACT.md`) — local evaluation only (ADR 0003 §4).
- A model-facing spawn/delegation tool inside review sessions (ADR 0003 §1).
- Reviewer-side generation suppression from memory (deferred; see PR-8).
- AI-authorship detection for automatic cross-model routing (defered; see
  PR-6 out-of-scope).

## Principles applied to every slice

- **Flow-driven supervisor.** New parallelism/specialization is deterministic
  orchestration in `src/core/supervisor.ts`; sessions stay isolated,
  read-only, terminal-tool-bounded.
- **Defaults preserve today's behavior.** New knobs are default-off or
  identity (`verifyConcurrency=1`, `minConfidence=0`, `--angles` unset).
- **Machine-checkable beats prompt-only.** Where a rule can be enforced at
  a tool boundary (evidence gate, anchor line validation) it is; prompts
  state the rule, code enforces it.
- **Model-free tests are the default proof**; model-dependent behavior gets
  one recorded live run per PR (repo, command, outcome) per the PR template.
- **One slice per PR**, conventional commits, dogfood gate before every push
  (work-with-pr lifecycle).

---

## PR series overview

| PR | Slice | Type | Status | Depends on | Cost | Risk |
|----|-------|------|--------|-----------|------|------|
| D1 | This plan + ADR 0003 (docs) | docs | merged #74 | — | — | — |
| B1 | ReviewBench real-world tasks as a local benchmark (extends `tests/eval/`) | feat | merged #76 | — | M | L |
| B1-baseline | 2× test-25 baseline on dev | bench | deferred (maintainer decision; lands before F1 — reference for F1+ rows; pre-baseline slices' rows waived) | B1 | S | — |
| Q1 | Prompt hardening: do-not-report blacklist + severity calibration | feat | merged #78 (ReviewBench row waived by the baseline deferral) | B1 (for delta rows) | S | L |
| Q2 | Parallel verification drain (`verifyConcurrency`) | feat | merged #80 (live A/B 1.56x wall-clock, identical fingerprint sets) | — | M | M |
| Q3 | Verifier evidence gate on `submit_verdict` | feat | merged #81 (dogfood fixed two citation gaps, F-116/F-117) | — | S–M | M |
| Q4 | Persisted confidence, `--min-confidence` split, run-level verdict | feat | **next** | — | M | L |
| Q5 | Separate verifier model option | feat | pending | Q2 preferred (design carries a no-Q2 fallback) | S | L |
| C1 | Change-mode diff coverage ledger | feat | pending | — | M | M |
| M1 | Memory denoising, observational (similar-dismissed context) | feat | pending | — | M | M |
| F1 | Multi-angle finder fan-out (default-off) | feat | pending | B1 numbers, Q2 pool | L | H |

### PR convention

The original plan stacked every implementation PR on D1 via the `gh stack`
extension. That convention was retired when D1 merged: **every slice
branches off `dev` directly** and follows the plain work-with-pr lifecycle
(isolated worktree, model-free tests + live QA, dogfood gate before each
push, CI green, merge on explicit approval). Consequences:

- Merge order is only dependency-ordered, not stack-ordered: B1 before any
  PR that cites its delta rows, Q2 before F1 (worker-pool reuse). Q5 may
  land before or after Q2 — its design section carries an explicit
  no-Q2 fallback. Everything else may land in any convenient order.
- Independent slices may be developed concurrently in separate worktrees;
  rebase onto `dev` before linking if another slice landed in between.
- The tracking issue (#73) is the live status; this file is re-synced as
  slices land.

### Benchmark protocol (applies to Q*/C1/M1/F1)

Two measurement surfaces, one per cost tier:

- **Scenario harness (`tests/eval/`, exists today).** Synthetic
  human-labelled scenarios with positive *and negative* expectations
  (`preexisting-bug-unchanged`, `guarded-negative`, clean refactors), paired
  baseline/candidate CLI runs, repeats for variance. This is the cheap gate:
  every behavioral PR runs it against the baseline build before pushing.
  It directly measures blacklist behavior (Q1) and evidence-gate behavior
  (Q3) on its negative scenarios.
- **ReviewBench (added by B1).** Real-world PRs with human golden findings.
  The real-world gate: the 2× test-25 baseline on dev plus delta rows
  appended by each behavioral PR — currently deferred, see below.

Standing rules for both surfaces and the post-baseline delta-row era:

- **Variance discipline:** any "no regression" claim on recall/precision
  requires both runs not worse than baseline's worse run.
- **Cost:** ReviewBench subset-10 is the iteration surface; full test-25
  only for baseline and release-ish claims.

**B1-baseline deferral (maintainer decision, recorded in #73):** the 2×
test-25 baseline on dev is deferred until development completes. Until it
lands, behavioral PRs are gated by the scenario harness alone. The
consequences, stated honestly rather than pretended away:

- The baseline lands **before F1** — F1's gate cites B1 numbers, so
  "until development completes" means before the closeout gates, not
  after them. From the baseline onward the delta-row regime resumes
  (F1's A/B rows and later).
- Per-PR ReviewBench attribution for slices merged before the baseline
  (Q1–M1) is **waived, not deferred**: the baseline's dev build already
  contains every one of them, so no later comparison can isolate a
  single slice's effect — backfilling individual rows is explicitly not
  attempted. Their measurable gate is the scenario-harness variance bar.
- ADR 0003 acceptance is amended to what is measurable under the
  deferral (see the ADR's Status section): Q1–Q3 merged under the
  scenario-harness gate, the baseline era opened, F1's A/B rows
  non-regressing.
- Blanket rule for the per-slice sections below: where an acceptance or
  QA clause cites a ReviewBench delta row and the slice lands
  pre-baseline (Q2–M1), the scenario-harness variance bar substitutes
  for that half; F1's clauses stand (it merges post-baseline).
- `tests/eval/reviewbench/RESULTS.md` and the harness README carry the
  same notice so a contributor opening either sees it.

---

## B1 — ReviewBench real-world tasks as a local benchmark

**Branch:** `feat/reviewbench-local-harness`.

### Motivation

pir already measures itself on synthetic scenarios (`tests/eval/`:
human-labelled fixtures, regex + location expectations, paired
baseline/candidate CLI runs with repeats — see its README). That harness is
reproducible and cheap but synthetic: small fixtures, no real-world PR
diversity, no severity/category-stratified recall against human consensus.
ReviewBench (MIT, `review-bench/ReviewBench`) complements it: 219 real PRs
with human-labeled golden findings — severity, category,
`scope: introduced-by-pr`, `context_required: diff-only` — plus frozen repo
mirrors and a locally runnable judge whose metrics match the leaderboard's.
We use it strictly as a local benchmark (ADR 0003 §4), extending the
existing eval surface rather than building a parallel one.

### Current code

`tests/eval/` contains `scenarios.js` (synthetic fixtures + labels),
`run-eval.js` (opt-in live-model runner gated by `PIR_EVAL=1`, paired
baseline/candidate comparison, isolation, JSON output) and `scoring.js`
(`scoreFindings` regex+location matching, `validateExpectations`,
`summarizeRuns`). Results live as dated JSON files under
`tests/eval/results/`. Nothing covers real-world repositories.

### Design

New code lives **inside the existing eval surface** so gating, isolation
conventions, and result records stay uniform:

```
tests/eval/reviewbench/
  README.md               # usage, license attribution, protocol
  run-rb.ts               # task runner (materialize → run pir → normalize)
  normalize.ts            # FindOutcome → judging-input JSON
  prefilter.ts            # deterministic advisory matcher (golden × pir)
  fixtures/
    REVIEWBENCH_SHA       # pinned upstream commit used for vendoring/judge
    test-set.json         # vendored corpus/test/test.json (25 tasks)
    golden/*.json         # vendored golden findings for those 25 tasks
    LICENSE-attribution.md
  RESULTS.md              # ReviewBench baseline + per-PR delta rows (tracked)
```

`.gitignore`: `tests/eval/reviewbench/.cache/`, `tests/eval/rb-out/`.

**Opt-in gate (same contract as the scenario runner):** without
`PIR_EVAL=1` the runner exits successfully without network, model, or
database access; importing its modules has no side effects; `--help` is
model-free.

**Task materialization** (`run-rb.ts`, reusing `try-agent.sh`'s proven
logic): for each manifest entry (`nwo`, `pr_number`, `base`, `head`):

1. Cache dir `tests/eval/reviewbench/.cache/repos/<owner>_<repo>/`;
   `git init` once; remote `origin` →
   `https://github.com/review-bench/<owner>_<repo>.git` (frozen mirror),
   `upstream` → the original repo as fallback.
2. `GIT_LFS_SKIP_SMUDGE=1 git fetch --filter=blob:none origin <base> <head>`
   only when `git cat-file -e <sha>^{commit}` fails for either SHA.
3. Materialize a per-task checkout under `.cache/work/<pr_key>/`:
   `git worktree add --detach <dir> <head>` inside the cache repo
   (isolates concurrent tasks; removed after the run).
4. State isolation follows the scenario runner's precedent (state DB
   outside the reviewed checkout): a fresh SQLite per task, discarded with
   the cache. Each task reviews with cold memory — deliberate: it measures
   the review engine, not accumulated decisions, and it is reproducible.

**Running pir:** same shape as the scenario runner's CLI invocation —
absolute `dist/cli/cli.js` path, forced-local config isolation,
`--json --base <base> --head <head> --cwd <checkout> --model <id>`,
`PIR_NO_WIZARD=1`, per-task timeout (default 30 min, `--task-timeout`).
Baseline/candidate pairing is supported the same way
(`--baseline-cli`/`--candidate-cli`, alternating order, `--repeats`) so
A/B comparisons match the existing harness semantics rather than
introducing a second comparison model. A failed/timed-out task records an
error row and the run continues. `--limit N` / `--only <pr_key>` subset
the manifest.

**Normalization** (`normalize.ts`) — exact spec:

- Input: the CLI `--json` envelope (`data.findings[]`, each a finding row
  with `displayId`, `status`, `title`, `claim`, `trigger`, `anchors[]`,
  and run metadata `data.usage`, `data.durationMs`).
- Reported set = rows with `status` ∈ {`confirmed`, `uncertain`}. A second
  file with `confirmed`-only is emitted alongside for a stricter precision
  view.
- Output per task, judging-input format
  (ReviewBench `docs/JUDGING_INPUT.md`):

```json
{
  "pr": { "repo": "<manifest repo URL>", "pr_number": N,
          "base": "<40-char sha>", "head": "<40-char sha>" },
  "agent": "pir",
  "findings": [
    { "producer": "pir", "file": "<anchors[0].path>",
      "start_line": <anchors[0].startLine>,
      "end_line": <anchors[0].endLine ?? anchors[0].startLine>,
      "message": "<title> — <claim> Trigger: <trigger>" }
  ],
  "usage": { "total_tokens": <usage.totalTokens>, "time_in_ms": <durationMs> }
}
```

- `file` normalized to forward slashes, no leading `./`. Rows without a
  usable anchor (should be impossible — `record_candidate` validates
  anchors) are dropped with a loud warning counted in the summary.
- Output layout: `tests/eval/rb-out/<round-name>/<pr_key>.json` where
  `pr_key` matches the golden filename stem
  (`<owner>_<repo>_<pr>-<head8>`), so the prefilter and the judge
  directory mode both work unchanged.

**Deterministic prefilter** (`prefilter.ts`) — advisory only, before any
LLM judge spend. The scenario harness matches labels with regexes +
location overlap because its labels are authored for that; ReviewBench
golden messages are natural language, so the prefilter scores pairs by
`claimSimilarity` (`src/findings/identity.ts`, token Jaccard) with a +0.2
bonus when anchor paths intersect; pairs ≥ 0.5 are listed as probable
matches. Emit `tests/eval/rb-out/<round>/PREFILTER.md`: crude recall
bounds (golden findings with ≥1 probable match / total), crude precision
(matched pir findings / reported), and unmatched lists on both sides.
Official numbers always come from the judge; the prefilter exists to aim
cheap iteration.

**Judge delegation** (`bench:judge` npm script): clone
`review-bench/ReviewBench` at the pinned SHA recorded in
`fixtures/REVIEWBENCH_SHA` into `.cache/reviewbench/`, `npm ci` there
once, then run its CLI:

```sh
npm --prefix tests/eval/reviewbench/.cache/reviewbench run judge -- \
  --candidate <abs path to rb-out/<round>> \
  --provider <RB_JUDGE_PROVIDER> --model <RB_JUDGE_MODEL> \
  --output <abs path to rb-out/<round>/scores.json>
```

Credentials pass through the provider's documented env vars. Judge model +
provider + ReviewBench SHA are recorded in every RESULTS.md row (judge
drift invalidates comparisons).

### Tests (model-free)

Follow `tests/unit/eval-scoring.test.js`'s discipline (Node + local git +
temp files only, no dist/credentials/network):

- `tests/unit/rb-normalize.test.js`: fixture finding rows → exact JSON
  contract (field-by-field), uncertain-included/confirmed-only variants,
  anchor fallback `end_line`, path normalization, drop-and-warn path.
- `tests/unit/rb-prefilter.test.js`: matching thresholds, path-bonus,
  per-task isolation of pairs, markdown emission shape.
- `tests/unit/rb-run.test.js`: manifest parsing, mirror URL derivation,
  subset flags, timeout wiring, `PIR_EVAL=1` gate (no side effects when
  unset), baseline/candidate argument handling.
- Integration (no network): materialization against a local bare fixture
  repo (pattern of existing git fixtures) — fetch-skip when SHAs present,
  worktree add/remove per task.

### Live QA

Run 3 tasks end-to-end with real credentials (`--only` × 3) under
`PIR_EVAL=1`, then `bench:judge` on the output; record commands + observed
scores in the PR body. Record the wall-clock and token cost of one task as
the budgeting reference.

### Acceptance

- `npm test` green with the new tests; typecheck clean.
- 3-task live run + judge scores produced; RESULTS.md gains a "harness
  smoke" section (not a baseline yet).
- README documents the protocol, the opt-in gate, and the MIT attribution.

### Risks / mitigations

- Upstream ReviewBench format drift → pinned SHA for both vendored data and
  judge; re-vendoring is an explicit PR.
- Mirror network flakiness → upstream fallback already in the fetch logic;
  materialization failures are per-task errors, not run-fatal.
- Token spend → subset-10 default iteration surface; timeouts per task.

### Out of scope

Docker/`AGENT_CONTRACT` adapter, portal onboarding, full-corpus (219) runs,
CI integration of benchmark runs.

---

## Q1 — Prompt hardening: do-not-report blacklist + severity calibration

**Branch:** `feat/prompt-do-not-report`.

### Motivation

Precision work targets the measured FP root cause. Codex's open review
rubric is the strongest public template: seven comment-worthiness
conditions including "introduced in this commit" and the anti-speculation
clause; Claude's review plugin carries an explicit FP blacklist. pir states
positive rules only (`src/agents/prompts.ts`, reviewer prompt: "not
pre-existing debt"), so the negative space is model-inferred.

### Current code

`reviewerPrompt` (`src/agents/prompts.ts:27`) and `auditReviewerPrompt`
(`src/agents/prompts.ts:105`): PROCESS → provenance → FINDINGS BUDGET →
dynamic sections. Severity line exists ("Severity measures impact and
urgency … not confidence") without P0 reservation wording.

### Design

New shared builder in `prompts.ts`:

```ts
function doNotReportLines(mode: "change" | "audit"): string[]
```

Seven items, ≤ 1 line each, placed after the FINDINGS BUDGET lines:

1. A defect that already exists at merge-base — change mode only, phrased
   as the falsification test ("the defect must not reproduce on the old
   side unless this change unmasked it"). **Omitted in audit mode** — an
   audit reports long-standing defects by definition; this divergence is
   the whole reason the builder takes a mode.
2. Code that looks suspicious but is guarded, contracted, or tested
   elsewhere — verify the guard before reporting.
3. Issues a linter/type-checker would catch (unused imports, formatting),
   unless they mask a real defect.
4. Pedantic style or naming preference with no behavioral impact.
5. Speculative downstream breakage: naming the concrete affected code path
   (file + behavior) is required; "might break something elsewhere" without
   that path is not a finding.
6. Design choices that tests, contracts, or comments evidence as
   intentional.
7. Generic quality complaints without a concrete failure mode.

Severity calibration (both modes), appended to the existing severity line:
"P0 is reserved for unconditional, input-independent breakage; when impact
cannot be determined, keep severity by mechanism and put the uncertainty in
finish_round — do not convert weak evidence into a low-severity finding."

Prompt-size guard: the change adds ≤ ~1.8 KB; a unit test asserts
`reviewerPrompt(...)` length stays within current + 2 000 chars so the
dilution risk (Claude's documented "a long REVIEW.md dilutes the rules that
matter most") is mechanically bounded.

`record_candidate`'s tool description is untouched in this slice (its
validation semantics already encode anchor grounding).

### Tests

Extend the prompt unit tests (pattern: existing `tests/unit/` prompt
rendering tests): change prompt contains items 1–7 including the
merge-base clause; audit prompt contains 2–7 and does **not** contain the
merge-base clause; P0 line present in both; length budget holds for both
minimal and fully-populated inputs; section order unchanged (blacklist
after FINDINGS BUDGET, before PREVIOUS ROUND SUMMARY).

### Live QA

Two surfaces, per the protocol: (a) the scenario harness against
baseline/candidate builds — its negative expectations
(`preexisting-bug-unchanged`, `guarded-negative`, clean refactors) are the
direct measurement of this change; (b) dogfood gate on this diff itself.
Plus, since B1 has landed: ReviewBench subset-10 delta row before/after.
*(Recorded outcome: (a) and (b) ran — runs 5–6 passed the variance bar;
the subset-10 row was waived by the B1-baseline deferral, not skipped by
choice.)*

### Acceptance

- Tests green; benchmark delta row shows precision not worse and recall not
  worse beyond the variance rule; if either regresses, the offending item
  is removed in the same PR rather than argued for.
  *(Superseded by the B1-baseline deferral for the ReviewBench half: the
  row is waived, the scenario-harness variance bar was the gate that
  applied — and passed.)*

### Out of scope

Language-pack changes; `record_candidate` schema changes.

---

## Q2 — Parallel verification drain

**Branch:** `feat/parallel-verify-drain`.

### Motivation

`drainVerifications` (`src/core/supervisor.ts:164`) verifies candidates
strictly serially; each verification is an independent session (own memory
match computed up-front, own collector, own transcript). Wall clock of a
drain is the sum of verifier latencies. Industry consensus concurrency for
review fan-out is 4 (Goose `MAX_WORKERS=4`, Codex slots 4–6, pi's official
subagent example 4 workers / 8 tasks). At C=4 with the default 8
verifications/round the drain phase drops ~3–4×.

### Current code

`while (state.pending.length > 0 && counters.verified < limits.maxVerifications
&& findingsAllowed() && !budget.exhausted())` — one `state.pending.shift()`
per iteration; per-candidate body: `matchIssueHistory` → `runVerifier` →
`budget.chargeSession` → `state.pending.shift()` → `applyVerdict` →
feedback append. Shared by change and audit loops unchanged.

### Design

**Option plumbing.** `FindOptions`/`AuditOptions` gain
`verifyConcurrency?: number`; validation `positiveInteger`, clamped to
**1..8**. CLI `--verify-concurrency N`; env `PIR_VERIFY_CONCURRENCY`;
serve-mode passes it through like other find options. Default `1` =
byte-for-byte today's behavior.

**Refactor.** Extract the per-candidate body into:

```ts
async function verifyOne(
  deps: DrainDeps, candidate: CandidateFinding,
): Promise<{ candidate: CandidateFinding; verdict: VerifierResult;
             memoryMatches: MemoryMatch[] }>
```

containing exactly today's sequence minus budget mutation and state
mutation (memory match, `runVerifier` call with transcript/sink wiring).
`DrainDeps` gains `verifierModel?: string` now (used by Q5 later; passed
through as `model: deps.verifierModel ?? deps.model`).

**Scheduler** (replaces the while loop):

```
admission(): verified + inFlight < maxVerifications
          && (maxFindings === null || reportedCount(state) + inFlight < maxFindings)
          && !budget.exhausted()
workers: C async workers pull the next pending index while admission() holds
apply:   as each result lands — budget.chargeSession, counters, applyVerdict,
         feedback collected into a batch list
settle:  when the pool drains, sort the batch's feedback by displayId,
         append to state.investigationFeedback (cap 12, unchanged);
         sessionFiles sorted by candidate order; continue while pending
         remains and admission() holds
```

The `maxFindings` guard counts **in-flight** candidates against the
reporting ceiling (reservation semantics): a batch can never oversubscribe
report slots, only underuse them when verdicts reject — conservative and
correct for the #57 cap contract. Token-budget overshoot is bounded by C−1
in-flight sessions, which the documented budget semantics already tolerate
(`src/core/budget.ts`: "checked between sessions; an in-flight model turn
may exceed the limit").

**Unchanged on purpose:** completion-order application (verified array
order becomes nondeterministic under C>1 — harmless: rows are keyed by
displayId; audit's `persistVerified` runs over a slice after drain returns
and looks rows up by displayId); progress `verify` events fire at dispatch
with today's message; round-end counters aggregate identically.

### Tests

Fake-factory scripted sessions (existing pattern):

- C=1: verdict application order and all observable state identical to a
  captured golden of today's behavior.
- C=4: all candidates verified; counters/round record correct; concurrent
  session count never exceeds 4 (factory records peak concurrency).
- Admission: with `maxVerifications=3`, exactly 3 run; with
  `maxFindings=2` and 4 pending, peak in-flight ≤ remaining slots (assert
  via recorded dispatch times); budget exhaustion mid-batch stops further
  dispatch but applies landed results.
- Feedback batch sorted by displayId; cap 12 preserved.
- Audit loop reuse: same tests against `auditIssues` drain rounds.

### Live QA

Real diff, `--verify-concurrency 4` vs serial: findings fingerprint sets
equal; wall-clock recorded in the PR body; transcripts for all candidates
present and readable in the web UI.

### Acceptance

All tests green; C=1 golden equivalence; live A/B set equality + measured
speedup; no provider-rate-limit failures in the live run (else default cap
documented lower).

---

## Q3 — Verifier evidence gate on `submit_verdict`

**Branch:** `feat/verifier-evidence-gate`.

### Motivation

A second opinion without new external evidence measurably *hurts* accuracy
(critique agents hallucinate flaws to justify their role — CRITIC,
Snorkel, Greptile's failed LLM severity judge all converge on this). pir's
verifier can currently call `submit_verdict` without a single pinned read
in the session (`src/agents/verifier.ts` wires no observers;
`createSubmitVerdictTool` validates only schema and memoryId whitelist),
with confidence defaulting to 0.7. This is the exact gap Claude's
"verification bar: require file:line evidence" closes in prompt form; we
close it at the tool boundary.

### Design

**Session-local evidence tracker** (`src/agents/verifier.ts`):

- `pinnedReads: Set<string>` — populated by cloning the tool context with
  `readObserver` exactly as the audit reviewer does
  (`src/agents/reviewer.ts:102-104`); counts distinct pinned `read_code`
  paths.
- `evidenceCalls: number` — incremented by wrapping the `execute` of
  `search_text`, `find_symbol`, `find_callers`, `find_callees`,
  `find_references`, `get_change` (change mode) when building the session's
  tool array (the verifier already constructs this array in one place).

**Tool gate** (`src/tools/collector-tools.ts`):
`createSubmitVerdictTool(collector, matchedIds, evidence?: () => { pinnedReads:
number; evidenceCalls: number })`. In `execute`, before accepting a
 verdict: if `pinnedReads === 0 && evidenceCalls === 0`, return
`errorOutput("No evidence gathered in this session: read the candidate's
code (read_code/get_change) or run a search before submitting a verdict.")`
— a non-terminal error, the same mechanism `record_candidate` uses to push
the model back to work. A session that never recovers still ends in today's
`uncertain`/`missing-verdict` fallback, so the failure mode degrades
exactly like a silent verifier.

**Stage 2 (second commit in this PR) — rationale citation:** extract
`path[:line]` tokens from the rationale via regex; require at least one
token whose path is in `pinnedReads`. Path-level (not line-level) matching
in v1; line-level intersection is recorded as a possible hardening, not
shipped (the observer currently carries no line ranges — extending
`readObserver` to ranges belongs to C1, which needs it anyway).

**Prompt line** (both verifier prompts, one sentence): "A verdict is
accepted only after this session has examined evidence: read the relevant
code before calling submit_verdict."

**Deliberate strictness:** memory-only sessions (suppression assessment
with matched decisions) still require ≥ 1 pinned read — consistent with the
existing prompt contract that `stillApplies=true` requires verifying
material equivalence against current code.

### Tests

Scripted verifier sessions: immediate `submit_verdict` → tool error, then a
`read_code` → acceptance; memory-lookup-only session → error persists;
`get_change` alone counts as evidence (change mode) but not in audit mode
(audit has no `get_change` — the audit variant requires reads/searches);
stage 2 regex: rationale citing an unread path → error, citing a read path
→ accepted; verdict still terminal-alone rule unaffected.

### Live QA

Run on a real diff; inspect transcripts: `submit_verdict` preceded by ≥ 1
pinned read in every verifier session; wall-clock delta recorded (expected
negligible).

### Acceptance

Tests green; live transcripts show the gate never silently passing; no
increase in `uncertain`/`missing-verdict` rates beyond noise in the
benchmark delta row. (Pre-baseline slice — the ReviewBench half is
waived per the deferral note; the scenario-harness variance bar
substitutes.)

---

## Q4 — Persisted confidence, `--min-confidence` split, run-level verdict

**Branch:** `feat/confidence-and-run-verdict`.

### Motivation

The verifier already produces `confidence` 0–1 (`VerifierResult.confidence`)
but it evaporates after `applyVerdict` — `VerifiedFinding` has no such
field, so nothing downstream can filter on it. Codex ships
`confidence_score` + `priority` per finding and a run-level
`overall_correctness`; pr-agent's threshold knob is the canonical
"one knob trades recall vs precision" control.

### Design

**Persist confidence:**

- `VerifiedFinding` gains `confidence?: number` (`src/findings/types.ts`);
  `applyVerdict` (`src/core/review-state.ts`) copies it from the verdict.
- `src/memory/finding-store.ts` + `src/memory/migrations.ts`: new nullable
  `confidence REAL` column on findings (migration up; no-op when present).
  Write paths: `insert`, `updateVerified`.

**Reporting split (`--min-confidence`):**

- `FindOptions.minConfidence?: number` (0..1, default 0 = off), CLI flag,
  env `PIR_MIN_CONFIDENCE`, serve pass-through.
- `FindOutcome` gains `lowConfidenceFindings: FindingRow[]`: confirmed
  findings with `confidence < threshold`. **Bucketing only** — they remain
  reported, still count toward `maxFindings` (no refund: the cap contract
  stays conservative), and are rendered in a separate "low-confidence"
  section in CLI markdown and serve JSON. Rationale: thresholding that
  deletes findings changes the #57 semantics; a presentation split is
  reversible by the reader.

**Run-level verdict (deterministic, no extra session):**

```ts
type RunVerdict = "incorrect" | "correct-with-findings" | "needs-review" | "correct";
// any confirmed P0/P1        → "incorrect"
// any other confirmed        → "correct-with-findings"
// any uncertain (no confirmed) → "needs-review"
// otherwise                  → "correct"
```

On `FindOutcome.runVerdict`, the run manifest, and the serve JSON. Style/
doc findings never flip `incorrect` (mirrors Codex: verdict ignores style).

**Docs:** `docs/for-llm.md` JSON contract additions (new fields), README +
README.zh-CN flags.

### Tests

- Bucketing boundaries (0, threshold, 1; uncertain findings never bucketed
  as low-confidence — they are already flagged).
- Verdict truth table (all 4 states, severity interactions).
- Migration: fresh DB, existing DB upgrade, idempotent re-run; round-trip
  of confidence through insert/updateVerified/select.
- Serve JSON shape + CLI markdown rendering of the split sections.

### Live QA

Real diff with `--min-confidence 0.7`: verify bucketing in output and serve
JSON; verdict present in run manifest.

### Acceptance

Tests green; live QA recorded; for-llm.md updated; no change to exit-code
contract (documented explicitly in the PR scope check).

---

## Q5 — Separate verifier model option

**Branch:** `feat/verifier-model-option`.

### Motivation

Greptile's model-inversion data: models have blind-spot overlap with their
own output class; cross-family review of AI-authored PRs scored ~6–10
recall points higher. pir's session factory already accepts a per-session
model (`config.model ?? PIR_MODEL ?? startup`,
`src/agents/session-factory.ts:248`); only the plumbing is missing.

### Design

- `FindOptions`/`AuditOptions` gain `verifierModel?: string`; drain deps
  pass `deps.verifierModel ?? deps.model` to `runVerifier` (the seam is
  created in Q2; if Q2 has not landed, the one-line substitution is made
  directly in `drainVerifications` and Q2 preserves it).
- CLI `--verify-model <id[:level]>`, env `PIR_VERIFIER_MODEL`; serve
  pass-through; run manifest records both models
  (`model` + `verifierModel`).
- Validation reuses the existing model-resolution error path (an
  unresolvable id is a hard error, never a silent fallback).

### Tests

Fake factory records the model per session: reviewer sessions get
`--model`, verifier sessions get `--verify-model`; omission → identical
models; manifest fields.

### Live QA

Real diff with a different verifier model id; transcripts confirm the
verifier session's effective model.

### Out of scope

AI-authorship detection and automatic routing (Co-authored-by trailers) —
recorded in ADR as future work; needs its own accuracy story.

---

## C1 — Change-mode diff coverage ledger

**Branch:** `feat/change-coverage-ledger`.

### Motivation

Audit has exact coverage accounting (CoverageLedger + pinned-read
completion requirement); change mode has nothing — whether the reviewer
read every hunk is unobservable. The recall evidence (Claude's "read every
hunk, then the enclosing function"; Codex's "do not stop at the first
qualifying finding"; Greptile's finding that depth-first models drop bugs
they already reasoned about) all reduces to: coverage must be an account,
not a hope.

### Current code

`ToolContext.readObserver` exists (`src/tools/context.ts:21`) and fires on
every pinned read (`:66`) but only the audit reviewer wires it
(`src/agents/reviewer.ts:102`). `get_change` pages hunks
(`src/tools/review-tools.ts`, `hunkIndex` path returns raw diff lines)
with no observation hook. `RoundInfo` has no coverage field.

### Design

**Observer extensions** (backward compatible):

- `readObserver?: (path: string, revision, range?: { startLine: number;
  endLine: number | null }) => void` — `read_code`'s pagination site
  supplies the observed line range (it already knows the window).
- `ToolContext.hunkObserver?: (path: string, hunkIndex: number) => void` —
  fired by `get_change` only when raw hunk lines are returned (the overview
  and hunk-index listings do not count as reads).

**ChangeCoverage** (new `src/core/change-coverage.ts`):

```ts
class ChangeCoverage {
  constructor(changeSet: ChangeSet);           // hunks with new-side intervals
  recordHunk(path: string, hunkIndex: number): void;
  recordRead(path: string, range: { startLine; endLine: number | null }): void;
  summary(): { hunksTotal; hunksCovered; filesTotal; filesCovered;
              files: Array<{ path; covered; total }> };  // files capped at 200
}
```

A hunk is covered iff its raw lines were paged (`recordHunk`) **or** a
head-revision `read_code` range intersects the hunk's new-side interval
`[newStart, newStart + addedLines)`. Deleted files have no head-side
interval: their hunks count toward totals and are covered only via
`recordHunk`. Renames use the new path.

**Wiring:** the change-mode reviewer clones its tool context with both
observers (same pattern as audit); `runReviewerRound` returns
`coverageEvidence` alongside `readPaths` today; `findIssues` maintains one
`ChangeCoverage` across rounds (reads accumulate) and stamps
`RoundInfo.coverage` + the run manifest.

**Stage 2 (separate commit) — interventional:** after a reviewer round
that signaled `needsMoreRounds=false` with incomplete coverage, when budget
rounds remain and the findings cap is not hit, inject a focus entry
("Unread diff hunks: path:hunkIndex, …" capped at 12) and set
`needsReview=true` for one forced follow-up round; at most one forced
coverage round per run (state flag) so a reviewer that still refuses cannot
loop. The audit loop is untouched.

### Tests

- Interval math: boundary intersections, single-line hunks, `endLine=null`
  reads (to EOF), non-overlapping adjacent hunks.
- Deleted/renamed files; oversized diffs where hunks span pagination.
- Manifest + RoundInfo fields; `files` cap.
- Stage 2: forced round fires once, not when coverage complete, not when
  budget/cap exhausted (scripted sessions).

### Live QA

Real diff: manifest shows coverage counts consistent with the transcript's
reads; a deliberately partial read (small `--max-tokens` run) shows
uncovered hunks and (stage 2) a forced follow-up round in the round log.

### Acceptance

Tests green; live QA recorded; benchmark delta row (expected: recall trend
up on `diff-only` golden findings; precision unchanged). (Pre-baseline
slice — the ReviewBench half is waived per the deferral note; the
scenario-harness variance bar substitutes.)

---

## M1 — Memory denoising, observational (similar-dismissed context)

**Branch:** `feat/memory-similar-dismissed`.

### Motivation

Greptile's per-team embedding memory is the largest single precision win
on record (comment address rate 19%→55%): "nit" is team-subjective and
must be learned from dismissals. pir already stores per-finding decisions
(`IssueMemory`: decision, claim, anchorPaths, scope, stale) but
`matchIssueHistory` (`src/memory/retrieval.ts:182`) generalizes only
within entity/feature scope; there is no cross-entity signal channel.

### Design

**New query** (`src/memory/issue-memory.ts`):

```ts
similarDismissed(input: { category: string; anchorPaths: string[];
                          normalizedClaim: string },
                 opts?: { minOverlap?: number /* default 0.5 */; limit?: number }):
  { count: number; samples: Array<{ id: string; decision: string;
      claim: string; scope: string; stale: boolean; overlap: number }> }
```

Match rule: decision ∈ {`expected`, `false_positive`, `accepted_risk`,
`wont_fix`} AND category equal (normalized) AND (anchor-path intersection
non-empty OR `claimOverlap ≥ minOverlap`). Samples: top 3 by overlap,
stale entries included but flagged (staleness is signal, not exclusion).
Straight table scan over the issues store (bounded size); index only if a
measured need appears.

**Wiring:** `drainVerifications` computes it alongside `matchIssueHistory`
(once per candidate, before dispatch — works unchanged under Q2) and
passes it into `runVerifier` → verifier prompt.

**Prompt block** (both verifier prompts, bounded like PRIOR DECISIONS):

"SIMILAR DISMISSED HISTORY (background signal, not a decision): N earlier
findings judged {decisions} resemble this candidate (examples…). Weigh as
prior team signal and revalidate against the code; suppression still
requires your explicit stillApplies endorsement of a matched decision."

**Contract preserved (ADR 0003 §2):** this can never suppress by itself —
only `applyVerdict`'s existing trusted-decision + verifier-endorsement
path suppresses. Reviewer-side generation suppression is explicitly
deferred until the benchmark shows no recall cost.

### Tests

- Query: category mismatch excluded; path-intersection match;
  overlap-threshold edges (0.49/0.50); suppressive-decision filter;
  stale flagging; sample cap.
- Prompt rendering (both modes) with and without the block; bounded
  length.
- Drain passes counts through (scripted session captures the prompt).

### Live QA

On pir's own repository memory (dogfood config has recorded feedback
decisions): run `find`, confirm a verifier prompt contains the block with
sane contents. Benchmark task repos have cold memory → block absent (safe
no-op there — expected and asserted in tests).

### Acceptance

Tests green; live QA recorded; benchmark delta row (cold-memory tasks
expected unchanged — the row documents the no-op, the mechanism's value is
for warm-memory production use and later benchmarking on pir's own
history). (Pre-baseline slice — the ReviewBench half is waived per the
deferral note; the scenario-harness variance bar substitutes.)

---

## F1 — Multi-angle finder fan-out (default-off)

**Branch:** `feat/multi-angle-finders`. **Depends on:** B1 (measurement),
Q2 (worker pool).

### Motivation

One general reviewer session currently opposes the whole diff. Greptile's
v5 swarm of narrowly-scoped agents (1M+ PR A/B: median time 5:04→2:25,
address rate 52%→66%) and Claude's finder angles both show narrow scopes
find more, faster; SWE-PRBench shows detection passes degrade when context
is stuffed — narrow angles are also a context-limiting device.

### Design

**Angle definitions** (`src/agents/prompts.ts`):

```ts
interface AngleDef { id: string; label: string;
                     categories: FindingCategory[]; checklist: string[] }
```

Built-ins (five): `correctness` (correctness, regression),
`concurrency` (concurrency, resource-leak), `security` (security),
`contracts` (error-handling, api-misuse), `performance` (performance).
`maintainability`/`style` get **no** angle — Q1's blacklist is their
governor. `runReviewerRound` gains `angle?: AngleDef`; the prompt gains a
"SPECIALIZED FOCUS (angle `<id>`): report only findings whose category is
in `<categories>`; checklist: …" section. v1 keeps the same memory pack
across angles (filtering the pack per angle is a recorded tuning knob, not
shipped).

**Fan-out (change mode, round 1 only):** when `--angles` is set (explicit
list or `all`), the supervisor runs K = min(angles, 4) reviewer sessions
concurrently through Q2's pool machinery; candidates from all sessions
merge into the existing `deduplicateCandidates` + severity-sorted pending
queue. Later rounds stay single general-session with merged focus.

**displayId collision (must-handle):** `record_candidate` assigns
`F-<round><seq>` per session — parallel sessions collide. The supervisor
reassigns sequential displayIds to merged fresh candidates immediately
after the merge, before any persistence, feedback, or transcript-index
reference; the collector-level ids remain only inside each session's
transcript (mapping recorded in the sessionFiles entries).

**Aggregation:** `needsReview = any(needsMoreRounds)`; `priorSummary` =
joined angle summaries (cap 6 000 as today); `focus` = deduped union (cap
16). Budget guard: if `maxTokens` is set and remaining tokens <
K × 150 k, reduce K (drop trailing angles, log); wall-clock check analog.

**Flag surface:** `--angles correctness,security` | `--angles all`;
default off; documented experimental. Serve pass-through.

### Tests

- Prompt rendering per angle (section present, categories listed).
- Scheduling: K sessions dispatched, pool bound respected (factory peak
  concurrency); budget shrink drops angles deterministically (stable
  order).
- Merge: cross-angle duplicates collapse via existing dedup; displayId
  reassignment unique and stable; feedback refers to reassigned ids.
- Aggregation rules (needsReview OR, summary cap, focus cap).
- Audit mode unaffected (no angles there in v1).

### Live QA

Manual: two real PRs with `--angles all`; transcripts show per-angle
sessions and merged candidate ids. Benchmark: subset-10 A/B
baseline vs angles (recall, precision, cost, wall-clock).

### Acceptance

Benchmark shows grounded recall improvement without precision loss beyond
the variance rule, at a documented cost multiplier; otherwise the feature
stays default-off with the A/B numbers recorded in RESULTS.md for
re-evaluation after model upgrades.

---

## Sequencing summary

1. **D1** — merged (#74). The stacked-PR convention retired with it; all
   later slices branch off `dev` directly (see "PR convention").
2. **B1** — merged (#76). The scenario-harness baseline already exists
   (`tests/eval/results/2026-09-29-dev-vs-review-loop-glm-5.3-run1.json`)
   and keeps accumulating dated runs per its own convention. The
   ReviewBench 2× test-25 baseline is deferred by maintainer decision
   until development completes (see "Benchmark protocol").
3. **Q1** — merged (#78): scenario-harness runs 5–6 passed the variance
   bar; its ReviewBench delta row is waived by the baseline deferral.
4. **Q2** — merged (#80): peak concurrency ≤ C, C=4 output identical to
   serial, live A/B 1.56x wall-clock with identical fingerprint sets.
   **Q3** — merged (#81): verifier evidence gate on `submit_verdict`;
   the dogfood loop found and fixed two citation-matching gaps
   (F-116/F-117).
5. **Q4 next** (`feat/confidence-and-run-verdict`), then Q5 → C1 → M1
   (Q4/Q5 touch options plumbing — landing before C1/F1 reduces
   conflicts; no semantic dependency).
6. **F1** last, gated on B1 numbers + Q2 pool — the B1-baseline therefore
   lands before F1 (see the deferral note under "Benchmark protocol").
7. ADR 0003 status → Accepted once Q1–Q3 have landed under the
   scenario-harness variance gate and the pre-F1 baseline era has opened
   with F1's A/B rows non-regressing (per-PR ReviewBench rows for
   pre-baseline slices are waived by the deferral; the ADR's Status
   section carries the amended acceptance clause). Any reverted item
   amends the ADR.
8. When every task in the tracking issue is complete, **delete this plan
   file** (top-of-file note) — ADR 0003 and the landed design docs are the
   durable record.

Every PR in the series follows the work-with-pr lifecycle: isolated
worktree, model-free tests + live QA, dogfood gate before each push, CI
green, merge only on explicit approval.
