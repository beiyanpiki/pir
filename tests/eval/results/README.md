# Recorded evaluation runs

Committed artifacts from opt-in live-model runs (`PIR_EVAL=1`), kept for
audit and comparison. Each file is the unmodified `--output` report of
`tests/eval/run-eval.js`; see `tests/eval/README.md` for the report schema
and the isolation/reproducibility model.

| File | Date | Model | Baseline | Candidate | Repeats | Result (pass) |
|---|---|---|---|---|---|---|
| `2026-09-29-dev-vs-review-loop-glm-5.3-run1.json` | 2026-09-29 | `zai-coding-cn/glm-5.3` | `dev@624897d` clean build | PR #11 `feat/review-loop-efficiency` (built from `c74b661`) | 1 | baseline 9/13, candidate 13/13 |

Provenance notes:

- Builds were produced from clean worktrees of the referenced commits;
  the `variants[].sha256` field hashes only the `dist/cli/cli.js`
  entrypoint (unchanged between these builds), so identify builds by the
  commits above, not by that hash.
- `config.hashes` are non-secret snapshots of the pi model-settings files
  used by both variants; `config.model`/`thinking` record the snapshotted
  pi defaults, while the top-level `model` is the explicit `--model`
  override actually passed to every run.
- Baseline usage fields are `null` (`dev` has no usage instrumentation),
  never zero. Baseline and candidate token/cost columns are therefore not
  comparable across variants in this run.
- Single repeat, single model, synthetic fixtures: a directional data
  point, not a general accuracy claim.
