# ReviewBench results

Baseline + per-PR delta rows for the local ReviewBench benchmark
(test-25, vendored at the pinned SHA in `fixtures/REVIEWBENCH_SHA`).
Protocol: subset-10 is the iteration face; full test-25 only for baseline
and release-level claims; a "no regression" claim needs both comparison
runs no worse than the baseline's worse run. Judge drift invalidates
comparisons — every row records provider/model/SHA.

## Status

**No baseline yet.** After this harness lands on dev, record 2× full
test-25 runs on current dev as the baseline rows; behavior PRs (Q1–Q5, C1,
M1, F1) then append delta rows here.

## Round registry

| Round | Date | Subset | Variants | Repeats | pir model | Judge (provider / model / RB SHA) | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| harness-smoke | 2026-10-09 (pending live QA) | 3 tasks (`--only`) | candidate | 1 | (pending) | (pending) | pending | B1 harness smoke — proves the pipeline; **not a baseline** |

Row conventions:

- **Result**: grounded precision/recall from the judge scores, plus
  augmented numbers and per-task wall-clock/token cost from `summary.json`;
  link or reference the `tests/eval/rb-out/<round>/` dir (untracked).
- **Notes**: subset used (which `--limit`/`--only`), errors (tasks that
  became error rows), and the variance-rule comparison for delta rows.
