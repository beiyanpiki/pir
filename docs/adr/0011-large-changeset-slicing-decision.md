# ADR 0011: Deterministic slicing of large changesets (D-B6) — not adopted

## Status

**Accepted (2026-10-20), outcome: rejected — the data trigger did not fire.** Decision point D-B6 of the OCR-borrow series, Iteration 4. No implementation is added by this decision; the measurement that would reopen it is recorded below.

## Context

D-B6 asked whether `pir find` should slice a large diff deterministically (hunk adjacency, one reviewer round per slice, fingerprint dedup across slices) and compared that with OCR's LLM semantic grouping. The series deliberately made it **data-triggered**: "M1 shows large PRs (>2000 lines) materially worse on findings density/cost, and B3's default budget hit frequently". The series' research also stated the fallback constraint up front: slicing must fail back to a single pass and must never act as a correctness gate (OCR's lesson).

The trigger is a conjunction of two measurements on material that M1's population can actually contain. Both were checked against the data available at Iteration 4.

## Evidence

**1. The benchmark population has no large PRs at all.** The M1 fixture is the upstream `positive_samples` split (196 PRs; sha256 `02c8561f…`, pinned in [meta.json](../../tests/eval/aacr/meta.json)). Its `change_line_count` distribution is p50 154, p75 324, p90 689, **max 971**; PRs ≥1,000 lines: **0**; ≥2,000 lines: **0**. The series' own threshold cannot be reached on AACR-Bench's positive split, so M1 cannot produce the first conjunct of the trigger — not because large PRs looked fine, but because the population does not contain one. This is now a documented limitation of the benchmark for size-related claims.

**2. The sampled size/cost relationship shows no "materially worse" regime.** The 57 completed instances of the parked M1 round (reviewer side, judge-independent data; per-PR table in [RESULTS Appendix A](../../tests/eval/aacr/results/RESULTS.md)) were bucketed into size quartiles:

| quartile | n | total changed lines | tokens / PR | findings / PR | findings / 1000 changed lines | minutes / PR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| q1 (smallest) | 14 | 409 | 1,156,055 | 0.71 | 24.45 | 12 |
| q2 | 14 | 1,220 | 984,396 | 1.21 | 13.93 | 13 |
| q3 | 14 | 2,741 | 1,491,876 | 1.71 | 8.76 | 16 |
| q4 (largest) | 15 | 9,077 | 4,681,039 | 3.60 | 5.95 | 30 |

Cost per PR and findings per PR rise with size (roughly 4× and 5× from q1 to q4), while cost per changed line and findings per changed line fall. The falling per-line density is the expected direction — larger PRs carry more context per reference comment, and the dataset's own reference-comment density falls with size — and the sample's largest row is 971 lines, so no row exercises the >2,000-line regime the trigger names. Nothing here shows a cost or density cliff that slicing would remove.

**3. Budget pressure is not observable on either available surface.** M1's driver passes `--max-tokens unlimited` by design ([ADR 0009](0009-m1-end-to-end-benchmark.md) §3/§10), so B3's default ceiling never applies inside an M1 round and budget stops cannot be measured there. On the local production surface, the 39 change-mode run manifests under `~/.local/state/pir/*/transcripts/*/run.json` (the dogfood/self-review runs of this repository's PRs) record **0 `budgetStop` entries**: 36 stopped on "reviewer signaled completion", 2 on a provider usage-limit failure, and 1 on "max rounds reached (1)". Neither surface supports "budget hit frequently", and the production sample is small-PR by construction (this repository's PRs).

**4. A cheaper attention mechanism already exists.** C1 shipped the change-mode coverage ledger and the one forced follow-up round that lists unread hunks ([ADR 0003](0003-findings-quality-roadmap.md) decision 2; [docs/for-llm.md](../../docs/for-llm.md) records the contract). Slicing would add a second, structural attention mechanism before the existing observational one shows a gap.

## Decision

**Reject D-B6 for now; do not implement slicing.** The trigger is a conjunction whose first conjunct cannot be measured on the current benchmark and whose second conjunct is contradicted by the production manifests. Implementing a large structural feature on absent evidence is exactly what the "data-triggered" designation exists to prevent.

The decision is a *reject*, not a permanent foreclosure. If reopened, the series' constraints stand unchanged: slice by hunk adjacency, one round per slice, fingerprint dedup across slices, failure falls back to the single-pass review, and slicing never becomes a correctness gate.

## Revisit conditions (must be measured before opening the ADR again)

- **Population:** a material with ≥2,000-line PRs — a production sample, a different benchmark, or an extension of this one — so the first conjunct is measurable at all.
- **Density:** findings per 1,000 changed lines and findings per PR for those large PRs, compared against the same repository's small-PR rows; "materially worse" must be defined as a pre-registered effect size before looking at the data.
- **Cost/budget:** a round with B3's **default** ceiling (not `unlimited`) showing budget stops in a material share of the large-PR subset; the M0/M1 manifests' budget fields are the source.
- **Coverage:** large PRs that still leave hunks unread after C1's forced round and produce fewer findings per line — the signal that attention, not structure, is the bottleneck.
- Reopen only when **density and budget** both hold; otherwise the answer is the cheaper C1 lever.

## Consequences

- No new code, no new configuration, no change to the reviewer contract.
- AACR-Bench's positive split is documented as unable to test PR-size hypotheses; a future large-PR claim must not cite it, and the context document's "decide with M1's large-PR buckets first" line is resolved as "the buckets cannot exist yet".
- The cost per PR and findings-per-PR scaling recorded here remain the reference for sizing a future decision or a budget experiment.

## References

- Measurement sources: [`tests/eval/aacr/results/RESULTS.md`](../../tests/eval/aacr/results/RESULTS.md); M1 fixture pin in [`tests/eval/aacr/meta.json`](../../tests/eval/aacr/meta.json); parked round per-PR data in RESULTS Appendix A; local run manifests under `~/.local/state/pir` (machine-local, not committed).
- Related ADRs: [0003](0003-findings-quality-roadmap.md) (C1 coverage ledger), [0006](0006-default-token-budget-with-grace.md) (B3 default budget), [0009](0009-m1-end-to-end-benchmark.md) (M1 and its §11 M2 amendment).

