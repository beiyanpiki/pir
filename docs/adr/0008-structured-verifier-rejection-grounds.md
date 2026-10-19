# ADR 0008: Structured verifier rejection grounds (B4)

## Status

**Accepted (2026-10-19).** Roadmap item B4 of
`docs/roadmap-ocr-borrow-and-aacr-benchmark.md` (borrow track, P1) in
Iteration 2. A rejected verification names *why* it rejected, in a fixed
vocabulary, so the reason survives the session and can be audited, bucketed
and compared. M0's kill-family numbers are the merge gate.

## Context

`runVerifier` (`src/agents/verifier.ts`) ends every session on
`submit_verdict`, whose evidence gate (`src/tools/collector-tools.ts`, Q3)
already refuses a verdict from a session that read nothing and whose
rationale cites no pinned path. What it does **not** record is the kind of
argument a rejection rests on: `verdict: "rejected"` plus free text is the
entire contract. That is enough to act on in the moment and not enough to
learn from afterwards — a rejection because the code is not there, because a
guard makes the failure unreachable, and because the defect predates the
change are three different claims about three different things, and they
degrade the same way.

M0's first `--limit 100` round measured what that costs
(`tests/eval/aacr/results/M0-2026-10-19-limit100.md`, ADR-0007
Consequences): `falseKillRate` 80.0% with `killRate` 72.0% and
`interceptPrecision` 24.3%. The rationales, read one by one, split into
recurring shapes — "a stylistic refactoring preference with no concrete
failure" (speculative), "pre-existing, not introduced" (not attributable),
"a guard already prevents it" (guarded). Those are *grounds*, and the
benchmark cannot count them because the tool never asked.

OCR's reflection prompt states the same asymmetry pir's verifier encodes
("Reviewer assertions are hypotheses, not facts") and goes one step further:
it enumerates **the only two grounds for removal** — Ground A (the code the
comment describes is not in its subject file's diff) and Ground B (a diff
line literally contradicts the claim) — and applies a **protected-subject
veto** before correctness is judged at all (memory safety, concurrency,
linkage/declaration consistency, behavior or compatibility change, unused
parameter). Its cost model is explicit: "Removing a correct comment silently
destroys a real finding. It never reaches anyone, and nobody learns that it
was dropped." B4 borrows the enumeration and the cost statement, not OCR's
diff-only evidence base: pir's verifier may read the whole pinned revision,
so its grounds are naturally richer than A/B (roadmap context §1.3).

The risk register constrains the design. R9 requires kill-family numbers to
be read jointly, so the gate must report `killRate`, `falseKillRate` and
`interceptPrecision` together. R2 warns that a prompt change measured on the
OCRed diff-only arm is not the same caliber; B4 changes only pir's verifier
arm, which is the surface M0 already isolates. R3 (3/4 AI-authored ground
truth) applies to any per-bucket reading of the result.

## Decision

1. **A fixed seven-value vocabulary.** `RejectionGround` (`src/findings/
   types.ts`) is `no-such-code` | `contradicted-by-code` | `pre-existing` |
   `guarded` | `speculative` | `not-introduced-by-change` | `other`. The
   first two are OCR's A/B adapted to a repository-aware verifier; `pre-
   existing` and `not-introduced-by-change` separate "true but old" from
   "true but not ours" (the two distinct ways a change-mode rejection can be
   correct about the code and irrelevant to the review); `guarded` covers
   unreachability; `speculative` covers a claim with no concrete failure;
   `other` is the absorbing bucket. The roadmap writes the field as
   `rejection_ground`; the tool parameter is `rejectionGround`, following the
   parameter naming every other collector tool uses (`uncertaintyReason`,
   `priorDecisionStillApplies`, `codeFeedback`).
2. **Required on reject in change mode only.** `submit_verdict` refuses a
   rejection with no ground and returns the vocabulary in the error text so
   the session can correct it in place (the tool boundary is non-terminal,
   exactly like the evidence gate). A provided but unrecognized value
   normalizes to `other` rather than failing the session: the enum is a
   reporting vocabulary, not a trap, and a rejection must never be lost to a
   spelling. Audit mode (`runVerifier({ audit: true })`) keeps its current
   contract — half the vocabulary is meaningless without change attribution,
   so requiring it there would force a wrong label. Extending grounds to
   audit verifiers is a separate decision with its own measurement.
3. **The asymmetric cost statement is stated, not implied.** The change-mode
   verifier prompt now says a false rejection destroys a real finding
   silently while a false keep costs one review pass, and that falling short
   of disproof means `uncertain`, not `rejected`. This is OCR's cost model
   applied to pir's own decision point; it does not relax the do-not-report
   contract (an unverifiable claim is still not reported), it changes which
   verdict the verifier reaches first.
4. **The protected-subject clause is textual, and only a clause.** For a
   candidate about concurrency, memory safety or security, a rejection must
   name the contradicting artifact (lock, ordering, bounds check, sanitizer,
   guard or test, at a cited path and line); "I could not find the race" is
   not disproof. It is deliberately **not** enforced in code: enforcing it
   would need a classifier of the claim's subject, which would be a second,
   unmeasured model call inside the verifier, and a wrong classifier would
   convert honest rejections into tool errors. The prompt states the
   obligation; the benchmark measures whether it changed behavior.
5. **Grounds are carried end to end.** `VerifierResult.rejectionGround` →
   `VerifiedFinding.rejectionGround` (`applyVerdict`) → `FindingView`
   (`data.findings[].rejectionGround` in the JSON envelope, and the text
   renderer's verifier line) → the `findings.rejection_ground` column
   (migration v8; nullable, so pre-B4 rows and kept rows carry null) →
   `_verify-comment`'s result and `tests/eval/aacr/run-m0.js`'s score row →
   `score.js`'s `rejectionGrounds` distribution, rendered as a per-arm table
   in the results document. Every hop is additive: no existing consumer
   changes, and a reader that ignores the new field sees exactly today's
   output.
6. **The merge gate is M0's kill family on a fixed sample.** The pre-B4 and
   post-B4 builds run the same materialized 100-comment sample (seed 42,
   digest `74f43e2f…c07d`, the Iteration 1 sample), the same model id and the
   same scoring code; only the CLI build differs. `falseKillRate` must not
   regress, and `killRate` / `interceptPrecision` are read with it (R9,
   ADR-0007 §5). The roadmap's wording "kill-rate (rejecting a label=1
   comment)" is ADR-0007's `falseKillRate`; the results file names all three
   so neither wording can be misread. The gate runs on the verifier arm only:
   B4 touches no OCR prompt or ocr-arm code, so an OCR row would be an
   unchanged control, not evidence.

## Consequences

- Rejections become countable by reason. A future false-kill cluster can be
  attributed ("`guarded` rejections of label-1 comments in Maintainability")
  instead of re-reading rationales, and M1's end-to-end runs inherit the same
  field without new plumbing.
- The verifier pays a small compliance cost: a session that rejects without a
  ground burns one non-terminal tool error and corrects it, and a session that
  never corrects it degrades to `missing-verdict` (invalid), which the M0
  scorer counts as a miss — never as a silent keep. The gate's invalid count
  is part of the evidence, not an afterthought.
- Grounds are **model-reported**, so they are a triage signal, not ground
  truth about the code: a verifier can label a wrong argument `guarded`
  confidently. That is the same trust level rationale text already had, with
  the advantage that it is now aggregatable; it must not be used as a
  correctness oracle for automated suppression.
- `other` will absorb vocabulary drift and some genuine variety. A rising
  `other` share is the signal to re-examine the enum, not a reason to widen
  it now.
- The protected-subject clause is a soft control. If M0's after-run shows
  protected-subject false kills unchanged, the next step is a targeted
  measurement (e.g. a per-category view of concurrency/security comments),
  not code enforcement inside the verifier.
- Audit verifiers keep the old contract, so `findings.rejection_ground` is
  null for audit rows by construction. A reader must not treat that null as
  "the verifier had no reason"; it is "this mode does not record one yet".
- **The gate exposed a provenance gap, fixed here.** `dist/cli/cli.js` is a
  thin dispatcher, so `run-m0.js`'s CLI `sha256` was identical for the pre-
  and post-B4 builds (both reported `2a6ce185…`) even though the verifier
  behaved differently: a build identity that cannot see a behavior change
  cannot certify a controlled comparison. `run-m0.js` now records a **build
  digest** over every built module under `dist/` (sorted path + content),
  `--resume` refuses a round recorded with a different digest, and
  `report.js` prints the digest per side and explicitly calls out two sides
  that share one instead of implying a comparison. The B4 rounds were
  re-recorded with the digest in place; the before/after numbers themselves
  are unchanged by the fix.
- **Gate result (2026-10-19, fixed 100-comment sample, one run per side).**
  Pre-B4 build `9fd6ea7` (dist digest `b6214403…`) vs this branch
  (`64734461…`), same model and material:
  `falseKillRate` 77.1% (54/70) → 78.6% (55/70),
  `killRate` 80.0% (20/25) → 80.0% (20/25),
  `interceptPrecision` 27.0% (20/74) → 26.7% (20/75). The net false-kill
  delta is **one comment**, and it is smaller than the run-to-run reshuffle:
  five label-1 comments swapped sides (three newly killed with grounds
  `speculative`, `speculative`, `contradicted-by-code`; two recovered as
  `confirmed`), while the **label-0 kill set is identical** (the same 20
  comments), so the interception side did not change at all. The strict
  "must not regress" rule is therefore not satisfied *as proof* — a
  one-comment delta is exactly this sample's resolution (1.4 pp) — and the
  gate is recorded as **not proven either way, with no evidence of a
  systematic increase in false kills**. Landing B4 rests on that reading
  plus the mechanism being additive and auditable; the post-B4 full-corpus
  round scores 2,012 comments and carries the same three kill-family numbers
  and the ground distribution, which is where a systematic shift would show.
  This is a concrete variance datapoint for M2's change protocol: a 95-row
  sample cannot gate a prompt change at the one-comment level, so a
  before/after claim of "no regression" needs repeats (or the full corpus)
  before it is treated as evidence.
