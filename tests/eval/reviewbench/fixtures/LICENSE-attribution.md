# Vendored ReviewBench fixtures — attribution

The files in this directory are derived from
[ReviewBench](https://github.com/review-bench/ReviewBench), © GitHub, Inc.,
released under the MIT License (see the upstream repository for the full
license text).

- Pinned upstream commit: `aec7b37ac99d2324cb85d9c6d34274a8d079b620`
  (recorded in `REVIEWBENCH_SHA`; the same SHA is used for the vendored data
  and for the judge clone driven by `bench:judge`).
- `test-set.json` is derived from `corpus/test/test.json` (the test-25 task
  manifest) at that commit.
- `golden/*.json` are derived from `golden/<pr_key>.json` for the 25 tasks at
  that commit (re-serialized with 2-space indentation; content unchanged).

Used locally for evaluation only (ADR 0003 §4): no leaderboard submission,
no upstream docker agent contract. Re-vendoring at a newer upstream SHA is an
explicit PR that updates `REVIEWBENCH_SHA` together with the derived files.
