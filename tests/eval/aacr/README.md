# AACR-Bench benchmarks (M0 verifier + M1 end-to-end)

Two measurement surfaces against [AACR-Bench](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench):

- **M0 — verifier offline benchmark.** Comment-level measurement of the **verifier stage**: 2,145 real PR review comments (1,505 expert-verified correct / 640 incorrect) over 200 PRs in 50 repositories, each with a binary label. It asks how well `runVerifier`'s defect verdict lines up with the dataset's "is this comment correct" label, and compares it against the open-code-review reflection prompt on identical material; the two questions are deliberately not identical, and ADR-0007's Consequences section records the measured consequence.
- **M1 — end-to-end benchmark (skeleton).** Whole-`pir find` runs over the upstream `positive_samples` split: 196 PRs, 1,506 known-correct reference comments, 50 repositories. Findings are judged by the **pinned upstream judge** and reported as file-level semantic precision/recall plus **`balanced_score`** — the caliber published OCR / Claude Code / Codex rows use. M1 never builds a judge of its own.

Protocols, decisions and their reasons live in [ADR 0007](../../../docs/adr/0007-aacr-verifier-offline-benchmark.md) (M0) and [ADR 0009](../../../docs/adr/0009-m1-end-to-end-benchmark.md) (M1); the numbers, the locked baseline and the M2 change protocol live in [RESULTS](results/RESULTS.md). Both surfaces **extend** `tests/eval/reviewbench/` (same opt-in gate, isolation conventions and variance rules); they do not replace it. Local evaluation only (ADR 0003 §4): no leaderboard, no CI gate, no publishing pipeline. The M1 `--limit 20` smoke costs 20 model runs: it is a manual check, never a CI gate.

## Layout

```text
tests/eval/aacr/
  meta.json               dataset, M1 fixture, upstream framework and OCR prompt pins (URL, revision, sha256, license, citation)
  fetch-dataset.js        T1: download the pinned dataset.json, verify sha256, write the citation sidecar
  sample.js               pure seeded sampling + comment ids (shared by the materializer and the driver)
  materialize.js          T2: shared clone cache (depth 1) -> per-comment diff + head file -> intermediate JSONL
  run-m0.js               T4: spawn `pir _verify-comment` per comment per arm with rb-grade isolation
  score.js                T5: pure scoring (policies, accuracy/P/R/F1, AUC, kill-rate, buckets, rejection grounds)
  report.js               A1: results document renderer (protocol, per-bucket tables, citation, optional before/after baseline)
  fixtures/
    build-fixture.js      M1 T1: pin-verified positive_samples.json -> fixtures/test-set.json
    test-set.json         gitignored: derived fixture body (one row per PR)
    positive_samples.json gitignored: verified upstream download cache
  m1/
    normalize-aacr.js     M1 T3: envelope -> reported / confirmedOnly upstream comment views
    run-aacr.js           M1 T2: per-PR `pir find` driver (same-repo serial / cross-repo concurrent)
    judge.js              M1 T4: pinned upstream judge delegation (data/results/pipeline eval)
    report-m1.js          M1 A1: results-document renderer (headline, buckets, coverage, cost)
    git-async.js          non-blocking fetch / worktree / synthetic-head plumbing
  results/                committed results files (M0-*.md, M1-*.md) + RESULTS.md (baseline, change protocol, dashboard)
  dataset/                gitignored: downloaded + materialized rows (auto-rebuilt)
  out/                    gitignored: run outputs (per-arm score rows + summary.json; M1 rounds)
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

Resume an interrupted round with `--resume` (both the materializer and the driver reuse completed rows); pick a fresh `--round` name otherwise, so two runs never mix silently. A sampled round that was deliberately stopped can be judged without re-running reviewers: `--resume --judge-only --judge real --eval-rounds 3` reads the completed result files, keeps the round's recorded selection so unrun instances stay in upstream's `missing_instances`, and writes the judge metrics into the same round. This is how the first Iteration-3 report was produced (57 completed instances of the planned 196).

## M1 · End-to-end benchmark

### What is measured, and by whom

`positive_samples.json` is the upstream **label=1** split: every reference comment is a known-correct review comment. An M1 task is one PR (`instance_id = owner__name@<target_commit[:7]>`, dots preserved). The driver runs the shipped CLI over the PR's diff, normalizes the findings into upstream's OCR-shaped result files, and hands the whole population to the **pinned upstream framework** (`evaluation/judge.py` / `evaluate.py`, commit in `meta.json`'s `framework` block). The upstream file-level semantic metric reports precision (generated comments that hit a previously uncovered reference comment), recall (reference comments covered) and `balanced_score` (their harmonic mean). **`balanced_score` is the external comparison caliber**; missing result files stay in `missing_instances` and out of the denominators. M1 has no self-built judge and no self-invented metric.

Two views are written from one run:

- **reported** = confirmed + uncertain (the uncertain=keep policy ADR-0007 fixed for M0);
- **confirmedOnly** = confirmed only (the strict precision view).

The same run is judged twice, once per view, so the calibration difference is visible instead of hidden in one number. Reference-comment buckets for the later A1 report (language, comment category, PR size) are carried in the fixture; `comment_meta` stays index-aligned with `reference_comments`.

### Build the fixture (body gitignored)

```sh
# downloads the pinned upstream positive_samples.json, verifies sha256/size/record
# count against meta.json's fixtures pin, and writes fixtures/test-set.json
PIR_EVAL=1 node tests/eval/aacr/fixtures/build-fixture.js

# offline / tests: convert an existing pinned download instead
PIR_EVAL=1 node tests/eval/aacr/fixtures/build-fixture.js \
  --from /path/to/positive_samples.json
```

`fixtures/test-set.json` (and the verified download cache `fixtures/positive_samples.json`) are **gitignored**: the fixture body is derived upstream data. The committed artifacts are the builder, the pin in `meta.json` (URL + sha256 + bytes + records + comment counts + instance-id convention) and the arXiv citation echoed into every fixture header. A tampered or changed upstream file fails the pin before anything is written. `--help` and the `PIR_EVAL` gate are model-free.

### Smoke run (`--limit 20`, manual — not CI)

```sh
npm run build:cli

# fixture once (above), then 20 model runs:
PIR_EVAL=1 node tests/eval/aacr/m1/run-aacr.js \
  --round 2026-10-19-m1-smoke \
  --limit 20 --concurrency 4 \
  --model "opencode-go/deepseek-v4.1-flash:medium" \
  --view both --judge mock
```

Why these flags: `--limit 20` is the documented smoke size (ADR-0009; the full 196-PR run plus `--eval-rounds 3` averaging is a separate, later round); `--concurrency 4` runs up to four **different repositories** at once while instances of the same repository stay serial (they share one cache directory); `--judge mock` uses upstream's local similarity judge, so the smoke validates the pipeline at zero judge cost. Use `--judge real` only with `JUDGE_BASE_URL` / `JUDGE_API_KEY` / `JUDGE_MODEL`; missing credentials fail before any model run. `--judge off` skips judging. For the full comparison, `--eval-rounds 3` asks the upstream judge for three independent rounds and averages them (the count is recorded in `summary.json`).

### M2 change protocol: the fixed 50-PR subset

Behavioural before/after comparisons run on one **fixed subset**, never on whatever rows happen to complete: `--limit 50 --seed 42` selects the first 50 fixture rows in a seeded Fisher-Yates order (the same `mulberry32` PRNG and loop the M0 comment sample uses). The order is reproducible from `(seed, limit)`, and the round records it as `limits.seed` plus `fixture.instanceSetDigest` (sha256 of the selected `instance_id` list, in selection order). The fixture's 196 rows currently yield **subset digest `754ae13a0c0fd523ddbf3a9e98d321de6e23ea30fc5332b871714194401ddb8c`** (50 instances, 29 repositories, 333 reference comments) — cite that digest beside any comparison row so a reader can rebuild the exact population.

`--resume` and `--judge-only` refuse to mix a different model, CLI build, fixture, view set, repeat count, seed or selected instance set into one round; `--judge-only` replays the round's recorded `(only, limit, seed)` instead of taking new selection flags. The full protocol (populations, judge pins, variance rules, recording format) is in [RESULTS](results/RESULTS.md).

Artifacts of the smoke:

```text
tests/eval/aacr/out/<round>/
  summary.json                         provenance: round, model, CLI sha256, fixture sha256,
                                       instance-set digest, views/repeats/limits, per-repo counts,
                                       incompleteInstances, errors
  reported/<safe_id>.json              upstream-shaped results (reported view)
  confirmedOnly/<safe_id>.json         upstream-shaped results (confirmed-only view)
  rows/<safe_id>.json                  our normalized data: both views, dropped counts,
                                       usage, duration, exit status, errors
```

`--repeats N` repeats each task N times; repeat 1 keeps the paths above and repeats 2…N nest under `repeat-<n>/`. `--resume` reuses completed rows and refuses to mix a different model, CLI build, fixture, view set, repeat count, seed or selected instance set into one round (the same provenance guard M0 established, extended to the M1 inputs).

### Incomplete runs are data, not errors

`pir find` exits 3 when a review is incomplete (budget/round stop) while still printing a valid envelope. The driver keeps that as a normal row with `incomplete: true`, the envelope's `stoppedBecause` and pending count, counts it in `summary.incompleteInstances`, logs an `INCOMPLETE` line, and writes result files that the judge scores normally. Exit 3 with unparseable stdout, any other exit status, or a signal kill (timeout) remains an error row. A round's exit code reflects real errors only; a purely incomplete round exits 0 and its partial nature is visible in the summary and rows.

### Materialization and the synthetic head, honestly stated

M1 reuses the M0 shared cache (`$PIR_AACR_CACHE`, default `~/.cache/pir-aacr`, never inside the worktree) with **depth-1 fetches** of the PR head and the **GitHub-reported merge base** for the dataset's base/head pair; there is no full clone on the normal path. The checkout is the real head tree.

`pir find` computes its diff with `git diff <base>...<head>`, which needs a real ancestry relation. Two depth-1 fetches supply both trees but no ancestry, so merge-base fails in a shallow cache. When (and only when) the cache has no ancestry, the driver creates a **deterministic synthetic head commit** with the head's exact tree and the merge base as parent (fixed identity/date/message, content-addressed), passes it as `--head`, and records both `headCommit` (dataset sha) and `reviewHead`/`syntheticHead` in the row and summary. The reviewer still sees the real head tree and exactly the PR diff; the judge never sees commit shas. If a repository cannot be fetched at depth 1 at all, the instance becomes an error row (and the documented fallback is a blobless partial clone, `--filter=blob:none`); the round never aborts.

### Judge delegation

`m1/judge.js` resolves the pinned upstream clone at `$PIR_AACR_JUDGE_DIR` (default `$PIR_AACR_CACHE/aacr-bench@<commit>`, fetched depth 1 when absent), writes the selected fixture rows as upstream's `evaluation/data/aacr_bench.jsonl`, copies the per-view result files into `evaluation/results/aacr_bench/<reviewer>/<run_id>/`, and runs `python3 -m pipeline run --stage eval` from `evaluation/`, which writes its metrics under `evaluation/metrics/aacr_bench/<reviewer>/<run_id>/`. The judge model id is recorded in the round summary (`limits.judgeModel`); an `--eval-rounds N` run must produce the `_average.json` metrics file or the judge is recorded as failed (never silently published from one round). One judge invocation's default 30-minute ceiling can be raised for a full-corpus run with `PIR_AACR_JUDGE_TIMEOUT_MS` (recorded as `limits.judgeTimeoutMs`). Only those generated, gitignored upstream directories are written; the clone is never modified and an existing clone at a different commit fails loudly (judge drift invalidates comparisons). Upstream's CLI only accepts `ocr|claude|codex`; M1 writes OCR-shaped files, so the delegation uses `--reviewer ocr`, whose `evaluate.py` builder is exactly that shape. The metrics JSON path and the upstream summary lines are relayed into `summary.json` and the console.

### Rendering the results document

```sh
node tests/eval/aacr/m1/report-m1.js \
  --round tests/eval/aacr/out/<round> \
  --out tests/eval/aacr/results/M1-<round>.md
```

Model-free: it reads the round's `summary.json` and the upstream `eval_res` of each judge round, then writes the committed document — headline file-level semantic precision/recall/`balanced_score` per view, buckets by language, PR size and reference-comment category (micro per judge round, averaged across rounds), the coverage/error ledger, token and duration accounting, and the full provenance pins (model, CLI sha256, fixture sha256, instance-set digest, judge model, arXiv citation). A round without `finishedAt` is refused unless `--allow-partial` is passed, and it then says PARTIAL at the top; a missing result file stays in `missing_instances` and out of every denominator.

### What is gitignored

`tests/eval/aacr/dataset/`, `tests/eval/aacr/out/`, `tests/eval/aacr/fixtures/test-set.json` and `tests/eval/aacr/fixtures/positive_samples.json`. The shared clone cache and the judge clone live under `$PIR_AACR_CACHE` outside the worktree. Everything gitignored is rebuildable from `meta.json`'s pins; nothing downloaded or generated is committed.

## Scoring in one paragraph

Label 1 = the comment is correct (should survive), label 0 = incorrect (should be intercepted). Primary policy **uncertain = keep**: `confirmed` and `uncertain` count as keeps, only `rejected` kills; the strict policy **uncertain = miss** is reported beside it and credits an uncertain verdict in neither direction. **killRate** (label-0 comments intercepted) is the north-star metric, **falseKillRate** (label-1 comments destroyed) is its cost side and B4's merge gate, **interceptPrecision** says how much of what was killed was actually noise. Accuracy/precision/recall/F1 are over keeps; AUC ranks the verifier's confidence. Buckets: `source_model`, `category`, `context`, `is_ai_comment`. Error rows and unresolved verdicts count as misses — never as silent exclusions.

## Data materialization, honestly stated

The dataset carries commit SHAs but no diff bodies. Per repository the materializer does `git init` + `git fetch --depth 1 origin <sha>` for the capture-time head and for the merge base GitHub reports for the dataset's base/head pair (a naive two-SHA diff would fold hundreds of commits of base-branch drift in reverse). The per-comment diff is that merge-base..head diff narrowed to the comment's path. Unreachable commits (force-pushed PRs whose head was garbage-collected) become error rows: the run reports them and scores the rest — it never substitutes a different commit for the captured one. Two limits are counted rather than hidden: the dataset's 11 `side: "left"` comments are excluded from the sample (their line numbers refer to the deleted old file, which the head-anchored mapping cannot express; `sample.sideExcluded` records the count), and `--resume` refuses to mix a different model or CLI build into a round already on disk, so one round always carries one provenance.

## Attribution and citation

The dataset, the M1 `positive_samples` fixture and the evaluation framework are Apache-2.0 and are **not** redistributed here: M0 commits only the HF dataset pin, M1 commits only the raw-GitHub pin in `meta.json`, and both bodies are re-downloaded on demand. Using AACR-Bench data requires citing arXiv 2601.19494:

```bibtex
@misc{zhang2026aacrbenchevaluatingautomaticcode,
  title={AACR-Bench: Evaluating Automatic Code Review with Holistic Repository-Level Context},
  author={Lei Zhang and Yongda Yu and Minghui Yu and others},
  year={2026}, eprint={2601.19494}, archivePrefix={arXiv}, primaryClass={cs.SE}
}
```

The OCR comparison arm ports the reflection prompt from [alibaba/open-code-review](https://github.com/alibaba/open-code-review) @ `8eb83340a487b1150af00701b94f01af97e4b4d6` (Apache-2.0) into `src/agents/ocr-reflection-prompt.ts`. See [LICENSE-attribution.md](LICENSE-attribution.md); every generated JSONL header and every results file repeats both notices.
