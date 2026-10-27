# ADR 0011: Deferred and rejected directions

## Status

**Accepted (2026-10-20 for the slicing and session-audit decisions; 2026-10-23 for
the non-borrows; consolidated 2026-10-27).** The directions the OCR-borrow series deliberately
did not pursue, delivered in PR #146:

| Part | Direction | Source | Outcome |
| --- | --- | --- | --- |
| I | Deterministic slicing of large changesets | ADR 0011 | rejected — trigger did not fire |
| II | Session-audit enhancements | ADR 0012 | rejected — trigger did not fire |
| III | OCR second-pass non-borrows | ADR 0021 | recorded — ten directions closed at their current evidence level |

Source numbers are the retired per-decision ADRs; the [consolidation
map](README.md) records the mapping. Parts I–II are data-triggered decision
points that were checked and declined; Part III absorbs the retired tracker so
the non-borrow list survives here. A non-borrow is a direction, not an
implementation: rejecting one says it is not justified on today's measured
evidence, not that it can never be right. Each revisit condition names the
measurement or consumer that would reopen it.

## Part I — Deterministic slicing of large changesets

### Context

The slicing proposal asked whether `pir find` should slice a large diff deterministically
(hunk adjacency, one reviewer round per slice, fingerprint dedup across
slices) instead of relying on OCR-style LLM grouping. The series made it
**data-triggered**: "the end-to-end benchmark shows large PRs (>2000 lines) materially worse on
findings density/cost, and the default budget hit frequently". The fallback
constraint was fixed up front: slicing must fail back to a single pass and
never act as a correctness gate.

The trigger is a conjunction of two measurements on material the end-to-end benchmark's population
can actually contain; both were checked against the data available at
Iteration 4.

### Evidence

**1. The benchmark population has no large PRs.** The the end-to-end-benchmark fixture is the
upstream `positive_samples` split (196 PRs; sha256 `02c8561f…`). Its
`change_line_count` is p50 154, p75 324, p90 689, **max 971**; PRs ≥1,000
lines: **0**, ≥2,000: **0**. The threshold cannot be reached on the positive
split, so the end-to-end benchmark cannot produce the first conjunct — not because large PRs looked
fine, but because the population contains none. This is now a documented
benchmark limitation for size claims.

**2. Sampled size/cost shows no "materially worse" regime.** The 57 completed
instances of the parked the end-to-end-benchmark round (reviewer side, judge-independent; per-PR
data in RESULTS Appendix A) bucket into size quartiles:

| quartile | n | total changed lines | tokens / PR | findings / PR | findings / 1000 changed lines | minutes / PR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| q1 (smallest) | 14 | 409 | 1,156,055 | 0.71 | 24.45 | 12 |
| q2 | 14 | 1,220 | 984,396 | 1.21 | 13.93 | 13 |
| q3 | 14 | 2,741 | 1,491,876 | 1.71 | 8.76 | 16 |
| q4 (largest) | 15 | 9,077 | 4,681,039 | 3.60 | 5.95 | 30 |

Cost per PR and findings per PR rise with size (roughly 4× and 5× from q1 to
q4), while per-line cost and density fall. That is the expected direction —
larger PRs carry more context per reference comment, and reference-comment
density falls with size — and the largest row is 971 lines, so no row
exercises the >2,000-line regime. Nothing shows a cliff slicing would remove.

**3. Budget pressure is not observable on either surface.** The end-to-end benchmark passes
`--max-tokens unlimited` by design (ADR 0007 Part II decisions 3 and 10), so
the default ceiling never applies inside a round. On the production surface, the 39
change-mode manifests under `~/.local/state/pir/*/transcripts/*/run.json`
record **0 `budgetStop` entries**: 36 stopped on reviewer completion, 2 on a
provider usage-limit failure, 1 on "max rounds reached (1)". Neither supports
"budget hit frequently", and the production sample is small-PR by
construction.

**4. A cheaper attention mechanism exists.** The change-mode coverage ledger
shipped with one forced follow-up round listing unread hunks (ADR 0003
decision 2; `docs/for-llm.md`). Slicing would add a second, structural
attention mechanism before the observational one shows a gap.

### Decision

**Reject slicing for now; do not implement it.** The trigger's first
conjunct cannot be measured on the current benchmark and its second is
contradicted by the production manifests. Implementing a large structural
feature on absent evidence is what the data-triggered designation exists to
prevent.

This is a *reject*, not a permanent foreclosure. If reopened, the constraints
stand: slice by hunk adjacency, one round per slice, fingerprint dedup across
slices, failure falls back to a single pass, and slicing never becomes a
correctness gate.

### Revisit conditions

- **Population:** material with ≥2,000-line PRs — a production sample, another
  benchmark, or an extension — so the first conjunct is measurable.
- **Density:** findings per 1,000 changed lines and per PR for those large
  PRs, compared against the same repository's small-PR rows; "materially
  worse" must be a pre-registered effect size before looking.
- **Cost/budget:** a round with the budget's **default** ceiling (not `unlimited`)
  showing budget stops in a material share of the large-PR subset.
- **Coverage:** large PRs that still leave hunks unread after the coverage ledger's forced round
  and produce fewer findings per line — attention, not structure, is the
  bottleneck.
- Reopen only when **density and budget** both hold; otherwise use the cheaper
  coverage-ledger lever.

### Consequences

- No new code, configuration or reviewer-contract change.
- AACR-Bench's positive split is documented as unable to test PR-size
  hypotheses; a future claim must not cite it.
- The scaling table remains the reference for sizing a future decision or
  budget experiment.

## Part II — Session-audit enhancements

### Context

The session-audit proposal compared pir's audit surface with OCR's: OCR writes full JSONL session
logs and ships a viewer with replay, marks and comparison; pir writes opt-in
snapshots (`PIR_TRANSCRIPTS=1`) plus a `run.json` manifest and a read-only
web explorer. The series made it **data-triggered**: act only on "accumulated
debugging / cost-attribution demand, or prompt tuning needing replay
evidence", with `localStorage` mark-and-hide named as the action. The trigger
is demonstrated need, not parity.

### Evidence

**1. Cost attribution is already answered without transcripts.** `run.json`
records usage (input/output/cache tokens, cost), rounds, session references,
stop reason and coverage; `pir runs status` prints mode, stop reason,
coverage and costs; web summaries expose model, duration, tokens and cost; the
the end-to-end-benchmark driver's `summary.json` attributes tokens and duration per instance (the
per-PR table was built from it). Of the 39 change-mode manifests on this
machine, **39 carry usage** and none needed a transcript to answer "what did
this run cost".

**2. The debugging that happened did not need replay.** The the end-to-end-benchmark driver's last
defects were diagnosed from the round summary, per-instance rows and stderr
tails: exit 3 with a valid envelope was an incomplete row rather than an error
(ADR 0007 Part II), and the paused round's state was reconstructed from
`summary.json`, round directories and pinned docs. The dogfood backlog
contains no entry whose disposition depends on replay, and the review loop
resolves findings from the findings JSON and `verify-fix`.

**3. Prompt tuning used labels and findings, not replay.** The rejection-grounds
clause and the `PROJECT RULES` injection were evaluated on the verifier benchmark's 2,134
labelled comments and on dogfood findings; the evidence was score movement
and finding provenance, not replay. The fidelity limit reinforces this:
transcripts are retained SDK session snapshots (compaction may replace
earlier context), **not provider request captures** — an "on by default"
replay surface would invite over-reading them as wire evidence.

**4. The missing UI feature has no recorded demand.** Transcripts are opt-in
for CLI runs and enabled by default only for web-enabled server runs, the
explorer is read-only, and alerts already have mark-read. No roadmap item,
dogfood finding, issue or ADR asks for mark-and-hide; OCR is the only source,
and the series pursues measured gaps.

### Decision

**Reject session-audit enhancements for now; keep transcripts opt-in and cost attribution
manifest-based.** Defaulting transcripts on is a privacy/disk/retention
decision, not a neutral toggle, and no measured need justifies it. Web marking
is deferred with it, since it only has a subject once transcripts are the
default inspection surface.

### Revisit conditions

- **Debugging:** an incident where the manifest, findings, `verify-fix` and
  stderr tails cannot locate the cause and replay demonstrably would have —
  record it here before changing defaults.
- **Prompt tuning at scale:** a campaign needing cross-session replay that
  verifier and end-to-end benchmarks scores plus findings cannot answer.
- **External demand:** a user or automation consumer asking for per-finding
  cost or replay in the UI; the request itself is the data.
- **If transcripts become default:** a documented retention/size budget, a
  delete/export story (they include prompt and tool traffic), and a note that
  they are not provider request captures must land in the same change.

### Consequences

- No new UI work, no default change, no new knob; the read-only explorer and
  manifest stay the audit surface.
- Evaluation isolation is unchanged: the end-to-end-benchmark runs with `PIR_TRANSCRIPTS=0`.
- The OCR-style viewer stays deliberately unborrowed; the next observability
  investment is justified by an incident, not parity.

## Part III — OCR second-pass non-borrows

### Context

The second OCR-borrow series examined seven candidate borrowings across feedback,
calibration, attention and recovery, recording decisions in
ADRs 0004–0010 and 0016 (as consolidated). It retires its tracker now that
every item has a verdict, and the tracker's deletion checklist requires the
non-borrow list to be absorbed before the file is removed.

The first OCR-borrow series retired the same way: PR #128 deleted that tracker
and absorbed its non-borrow principle into surviving ADRs; commit 340b1bc
shows the pattern. This part follows it: each direction keeps the reason it
was refused, the decision that governs it, and the evidence that would reopen
it, so it can be re-litigated on new evidence rather than on the absence of a
record.

### Decision

The ten directions below are deliberately not borrowed. Each row carries the
direction, the reason recorded when the series declined it, the governing ADR
or product boundary, and the condition that would reopen it.

| Direction | Reason not borrowed | Governing ADR / boundary | Revisit condition |
| --- | --- | --- | --- |
| Reflection filter as a cost funnel | The verifier benchmark's offline material shows a small removal surface (8.0% kill / 3.0% false kill). Those are offline percentages, not online false-kill rates, and do not establish verifier cost savings per candidate; a pre-filter would also add a loss channel. | No separate ADR: the data is [ADR 0007](0007-aacr-benchmarks-and-verifier-calibration.md) Part I; the missing evidence is the cost comparison. | Measured per-candidate costs showing the filter is much cheaper than the verifier and online false-kill behaviour is acceptable while the removal surface stays small. |
| Semantic grouping / large-PR slicing | Part I's trigger did not fire: the end-to-end benchmark's weak recall is not large-PR-specific, and grouping adds cross-group drift risk on top of an unmeasured benefit. | This ADR, Part I. | Part I's conditions: material with ≥2,000-line PRs, density measured as materially worse, and budget stops in a material share under the default ceiling; reopen only when density and budget both hold. |
| Cross-file relocation | [ADR 0005](0005-snippet-anchored-location-correction.md) §4: a unique-hit relocation can retarget a finding to a file the model never analysed, and the evidence gate is the better constraint. | ADR 0005 §4. | A measured anchor-error class where findings are uniquely located in another changed file; ADR 0005 changes only with measurement evidence, anchor metrics included. |
| In-session three-zone compression | pir opens a fresh session per round, so the long-conversation bloat OCR's compression manages does not exist structurally. | [ADR 0006](0006-default-token-budget-with-grace.md) Context (refusal recorded while adopting controlled truncation). | pir reuses one long conversation across rounds or sessions, with a measured token cost the fresh-session model cannot avoid; then it becomes a new context-management decision. |
| Coverage manifest / per-file terminal states | The coverage ledger and exclusion record already derive the states; [ADR 0004](0004-change-mode-review-pipeline.md) Part II rejects a second state machine. Audit-resume discovery is execution recovery, not this contract. | ADR 0004 Part II (the coverage-contract decision). | ADR 0004 Part II's conditions: a consumer that cannot join the two artifacts, a shared cross-mode schema, or an exclusion case the `excluded`/`excludedReason` pair cannot express. |
| Session viewer / audit enhancements | Part II: no recorded demand, and transcripts are retained SDK snapshots, not wire captures. | This ADR, Part II. | Part II's conditions: a debugging incident that replay would have solved; a prompt-tuning campaign needing cross-session replay; external demand; and if transcripts become default, a retention/size budget plus delete/export in the same change. |
| Delegation mode / ACP / multi-provider / ChatGPT auth | Different product form factors; pir's skill + JSON envelope + serve already cover the equivalent. | Product boundary; no review-quality ADR. | A named consumer needs a form the skill + envelope + serve lane cannot serve; that is a product-form decision with its own ADR. |
| Auto-fix / `suggestion_code` | The reviewer prompt deliberately says "Do not propose fixes"; suggestions change the product boundary and need their own verification. | Product boundary; no review-quality ADR. | A product decision to change the no-fix boundary, with its own verification design; review-quality evidence alone does not reopen it. |
| LLM grouping call | Same as semantic grouping: the metadata-only trick is clever, but the need is unproven. | This ADR, Part I. | Part I's conditions, plus measured evidence that a metadata-only grouping call beats the no-grouping control without cross-group drift. |
| Re-location LLM fallback | The snippet-anchored correction chose reject-and-resubmit over letting the model guess again; OCR's own prompt demands VERBATIM, showing how error-prone the fallback is. | [ADR 0005](0005-snippet-anchored-location-correction.md). | A measured anchor-error class that reject-and-resubmit cannot clear, with anchor metrics showing the fallback is accurate enough to justify the added loss channel. |

### Consequences

- The tracker's precondition is met: the ten directions survive here instead of
  in a temporary file, and the file can be deleted with its decisions intact.
- These directions are closed at their current evidence level. A proposal
  citing one must meet its revisit condition; parity with OCR is not new
  evidence.
- No code, configuration, CLI contract or benchmark population changes. The
  governing decisions (ADR 0004 Part II, ADR 0005 §4, ADR 0006, and Parts I–II)
  stand as accepted.
- The quoted numbers keep their caliber: the verifier benchmark is offline verifier material
  (ADR 0007 Part I), Part II is the end-to-end protocol (Part II). Neither
  establishes online behaviour.

## References

- Measurement sources: `tests/eval/aacr/results/RESULTS.md`; the end-to-end-benchmark fixture
  pin in `tests/eval/aacr/meta.json`; RESULTS Appendix A; local run manifests
  under `~/.local/state/pir` (machine-local, not committed).
- Related: [ADR 0003](0003-findings-quality-roadmap.md) (the coverage ledger, local-only
  evaluation), [ADR 0004](0004-change-mode-review-pipeline.md) (the coverage-contract decision),
  [ADR 0005](0005-snippet-anchored-location-correction.md),
  [ADR 0006](0006-default-token-budget-with-grace.md),
  [ADR 0007](0007-aacr-benchmarks-and-verifier-calibration.md).
- Precedent: PR #128 (first tracker retirement), commit 340b1bc (non-borrow
  principle absorbed into surviving ADRs).
- External: OCR `alibaba/open-code-review` (Apache-2.0), as surveyed by both
  series; pinned revisions live in the individual ADRs.
