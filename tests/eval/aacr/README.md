# AACR-Bench verifier offline benchmark (M0)

Comment-level measurement of the **verifier stage** against [AACR-Bench](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench): 2,145 real PR review comments (1,505 expert-verified correct / 640 incorrect) over 200 PRs in 50 repositories, each with a binary label. The benchmark asks one question — how well does `runVerifier`'s defect verdict line up with the dataset's "is this comment correct" label — and compares it against the open-code-review reflection prompt on identical material; the two questions are deliberately not identical, and ADR-0007's Consequences section records the measured consequence.

Protocol, decisions and their reasons live in [ADR 0007](../../../docs/adr/0007-aacr-verifier-offline-benchmark.md); the numbers live in [RESULTS](results/). This surface **extends** `tests/eval/reviewbench/` (same opt-in gate, isolation conventions and variance rules); it does not replace it. Local evaluation only (ADR 0003 §4): no leaderboard, no CI gate, no publishing pipeline.

## Layout

```text
tests/eval/aacr/
  meta.json               dataset + upstream prompt pins (URL, revision, sha256, license, citation)
  fetch-dataset.js        T1: download the pinned dataset.json, verify sha256, write the citation sidecar
  sample.js               pure seeded sampling + comment ids (shared by the materializer and the driver)
  materialize.js          T2: shared clone cache (depth 1) -> per-comment diff + head file -> intermediate JSONL
  run-m0.js               T4: spawn `pir _verify-comment` per comment per arm with rb-grade isolation
  score.js                T5: pure scoring (policies, accuracy/P/R/F1, AUC, kill-rate, buckets, rejection grounds)
  report.js               A1: results document renderer (protocol, per-bucket tables, citation, optional before/after baseline)
  results/                committed results files (M0-*.md)
  dataset/                gitignored: downloaded + materialized rows (auto-rebuilt)
  out/                    gitignored: run outputs (per-arm score rows + summary.json)
```

The clone cache lives **outside** the worktree at `$PIR_AACR_CACHE` (default `~/.cache/pir-aacr`); nothing under `tests/eval/aacr/dataset/` or `tests/eval/aacr/out/` is committed — every number is rebuildable from the pin in `meta.json`.

## Opt-in gate

Same contract as the other eval entry points: without `PIR_EVAL=1` every script exits 0 with a parseable skip notice and touches nothing. Importing their modules has no side effects; `--help` is model-free; `npm test` never runs a model. The internal CLI command is additionally local-only and refuses to run without `PIR_EVAL=1`.

## Running a round

```sh
npm run build   # the driver drives dist/cli/cli.js

# 1. acquire + verify the dataset (cached afterwards; sha256 pin enforced)
PIR_EVAL=1 node tests/eval/aacr/fetch-dataset.js

# 2. materialize the sample (resumable; failures become error rows, never aborts)
PIR_EVAL=1 node tests/eval/aacr/materialize.js --limit 100 --seed 42

# 3. run both arms on that sample (same model id, same material)
PIR_EVAL=1 node tests/eval/aacr/run-m0.js --round 2026-10-19-m0 \
  --model "opencode-go/deepseek-v4.1-flash:medium" --concurrency 4

# 4. score + render the results document
node tests/eval/aacr/score.js --run tests/eval/aacr/out/2026-10-19-m0 --json
node tests/eval/aacr/report.js --run tests/eval/aacr/out/2026-10-19-m0 \
  --out tests/eval/aacr/results/M0-2026-10-19-limit100.md
```

A controlled before/after (B4's merge gate, ADR-0008) runs the same sample twice — once with the pre-change build (`--cli` pointing at its `dist/cli/cli.js`), once with the build under test — into two round directories, then renders the comparison from the after-round with the before-round as baseline:

```sh
node tests/eval/aacr/report.js --run tests/eval/aacr/out/<after> --baseline tests/eval/aacr/out/<before> \
  --out tests/eval/aacr/results/<comparison>.md
```

The two rounds must share the dataset, sample digest, model id and arm set — `report.js` refuses to compare otherwise — and only the CLI build may differ. A round's rejection grounds (`rejectionGrounds` in `score.js`, "Rejection grounds (B4)" in the results file) come from the verifier's required `rejectionGround` on a rejected verdict; rows recorded before B4 or by the OCR arm count as `unknown` rather than disappearing.

Resume an interrupted round with `--resume` (both the materializer and the driver reuse completed rows); pick a fresh `--round` name otherwise, so two runs never mix silently.

## Scoring in one paragraph

Label 1 = the comment is correct (should survive), label 0 = incorrect (should be intercepted). Primary policy **uncertain = keep**: `confirmed` and `uncertain` count as keeps, only `rejected` kills; the strict policy **uncertain = miss** is reported beside it and credits an uncertain verdict in neither direction. **killRate** (label-0 comments intercepted) is the north-star metric, **falseKillRate** (label-1 comments destroyed) is its cost side and B4's merge gate, **interceptPrecision** says how much of what was killed was actually noise. Accuracy/precision/recall/F1 are over keeps; AUC ranks the verifier's confidence. Buckets: `source_model`, `category`, `context`, `is_ai_comment`. Error rows and unresolved verdicts count as misses — never as silent exclusions.

## Data materialization, honestly stated

The dataset carries commit SHAs but no diff bodies. Per repository the materializer does `git init` + `git fetch --depth 1 origin <sha>` for the capture-time head and for the merge base GitHub reports for the dataset's base/head pair (a naive two-SHA diff would fold hundreds of commits of base-branch drift in reverse). The per-comment diff is that merge-base..head diff narrowed to the comment's path. Unreachable commits (force-pushed PRs whose head was garbage-collected) become error rows: the run reports them and scores the rest — it never substitutes a different commit for the captured one. Two limits are counted rather than hidden: the dataset's 11 `side: "left"` comments are excluded from the sample (their line numbers refer to the deleted old file, which the head-anchored mapping cannot express; `sample.sideExcluded` records the count), and `--resume` refuses to mix a different model or CLI build into a round already on disk, so one round always carries one provenance.

## Attribution and citation

The dataset and framework are Apache-2.0 and are **not** redistributed here. Using AACR-Bench data requires citing arXiv 2601.19494:

```bibtex
@misc{zhang2026aacrbenchevaluatingautomaticcode,
  title={AACR-Bench: Evaluating Automatic Code Review with Holistic Repository-Level Context},
  author={Lei Zhang and Yongda Yu and Minghui Yu and others},
  year={2026}, eprint={2601.19494}, archivePrefix={arXiv}, primaryClass={cs.SE}
}
```

The OCR comparison arm ports the reflection prompt from [alibaba/open-code-review](https://github.com/alibaba/open-code-review) @ `8eb83340a487b1150af00701b94f01af97e4b4d6` (Apache-2.0) into `src/agents/ocr-reflection-prompt.ts`. See [LICENSE-attribution.md](LICENSE-attribution.md); every generated JSONL header and every results file repeats both notices.
