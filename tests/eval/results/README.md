# Recorded evaluation runs

Committed artifacts from opt-in live-model runs (`PIR_EVAL=1`), kept for
audit and comparison. Each file is the unmodified `--output` report of
`tests/eval/run-eval.js`; see `tests/eval/README.md` for the report schema
and the isolation/reproducibility model.

| File | Date | Model | Baseline | Candidate | Repeats | Result (pass) |
|---|---|---|---|---|---|---|
| `2026-09-29-dev-vs-review-loop-glm-5.3-run1.json` | 2026-09-29 | `zai-coding-cn/glm-5.3` | `dev@624897d` clean build | PR #11 `feat/review-loop-efficiency` (built from `c74b661`) | 1 | baseline 9/13, candidate 13/13 |
| `2026-10-10-dev-vs-prompt-do-not-report-deepseek-v4.1-flash-run5.json` | 2026-10-10 | `opencode-go/deepseek-v4.1-flash:max` | `dev@eaf454d` clean build | PR Q1 `feat/prompt-do-not-report` (final wording, `e36075d`) | 1 | baseline 11/13 (P 0.89 / R 0.89), candidate 12/13 (P 1.00 / R 0.89) |
| `2026-10-10-dev-vs-prompt-do-not-report-deepseek-v4.1-flash-run6.json` | 2026-10-10 | `opencode-go/deepseek-v4.1-flash:max` | `dev@eaf454d` clean build | PR Q1 `feat/prompt-do-not-report` (final wording, `e36075d`) | 1 | baseline 10/13 (P 0.88 / R 0.78), candidate 12/13 (P 0.90 / R 1.00) |

Provenance notes:

- Builds were produced from clean worktrees of the referenced commits;
  the `variants[].sha256` field hashes only the `dist/cli/cli.js`
  entrypoint (unchanged between these builds), so identify builds by the
  commits above, not by that hash.
- `config.hashes` are non-secret snapshots of the pi model-settings files
  used by both variants; `config.model`/`thinking` record the snapshotted
  pi defaults, while the top-level `model` is the explicit `--model`
  override actually passed to every run.
- Baseline usage fields are `null` in the 2026-09-29 run only (that
  baseline predates usage instrumentation); the 2026-10-10 baseline
  (`dev@eaf454d`) reports usage normally, so token/cost columns are
  comparable across variants in those runs.
- Single repeat, single model, synthetic fixtures: a directional data
  point, not a general accuracy claim.
- Q1 (do-not-report blacklist) also recorded four diagnostic runs on
  intermediate prompt wordings (runs 1–4, same date/model, not committed):
  run 1 candidate 12/13 (P 0.90 / R 1.00), run 2 candidate 10/13
  (P 0.78 / R 0.78). The failure modes those runs exposed were
  attribution-addressed in the same PR: item 5 was tightened to require a
  read downstream path (after which `fixed-regression-still-fixed` stayed
  clean in run 5 but the same guard-narrowing claim recurred once in run 6
  — reduced, not eliminated, and inside the baseline's own FP range: the
  baseline recorded FPs in four of six runs); the P0 clause was made
  one-directional and the guard-check item bounded (real-bug and the
  large-diff budget deaths improved). Runs 5–6 above are the final
  wording. Across all six runs the `large-diff-*` scenarios exhausted the
  400k token budget with a pending candidate on the candidate side three
  times and on the baseline side once — a budget-edge failure mode on both
  sides, worth re-checking once the ReviewBench baseline era starts.
