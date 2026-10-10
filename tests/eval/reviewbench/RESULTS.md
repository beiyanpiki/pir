# ReviewBench results

Baseline + per-PR delta rows for the local ReviewBench benchmark
(test-25, vendored at the pinned SHA in `fixtures/REVIEWBENCH_SHA`).
Protocol: subset-10 is the iteration face; full test-25 only for baseline
and release-level claims; a "no regression" claim needs both comparison
runs no worse than the baseline's worse run. Judge drift invalidates
comparisons — every row records provider/model/SHA.

## Status

**No baseline yet — deferred by maintainer decision** (tracking issue #73;
see the "B1-baseline deferral" note in
[docs/plans/findings-quality-roadmap.md](../../../docs/plans/findings-quality-roadmap.md)).
The 2× full test-25 baseline runs on dev are recorded before F1's gate —
from then on, behavior PRs append delta rows here. Per-PR rows for slices
merged before the baseline (Q1–M1) are **waived**: the baseline's dev
build already contains them, so their individual effect is not isolable
after the fact; their gate was the scenario harness.

## Round registry

| Round | Date | Subset | Variants | Repeats | pir model | Judge (provider / model / RB SHA) | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| harness-smoke | 2026-10-09 | 3 tasks (`--only`: k1LoW_gh-copilot-review_9, ardevd_jadx-collaboration_3, PierreJanineh_TechDebtMCP_135) | candidate-run1 | 1 | opencode-go/deepseek-v4.1-flash:max | opencode-go / deepseek-v4.1-flash / aec7b37 | grounded P=— R=0%, augmented P=— R=0% (0 reported findings vs 25 golden TPs) | B1 harness smoke — proves the pipeline (materialize → review → normalize → prefilter → judge), **not a baseline**. Per task: 484s/1.73M tok, 328s/0.41M tok, 446s/1.34M tok (`summary.json`). All three tasks came back clean under this model/limits — a data point about the model, not the harness. |

Row conventions:

- **Result**: grounded precision/recall from the judge scores, plus
  augmented numbers and per-task wall-clock/token cost from `summary.json`;
  link or reference the `tests/eval/rb-out/<round>/` dir (untracked).
- **Notes**: subset used (which `--limit`/`--only`), errors (tasks that
  became error rows), and the variance-rule comparison for delta rows.
