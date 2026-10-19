# ADR 0009: AACR-Bench end-to-end benchmark (M1)

## Status

**Proposed (2026-10-19).** Roadmap item M1 (End-to-end benchmark) of
`docs/roadmap-ocr-borrow-and-aacr-benchmark.md`, Iteration 2. This skeleton
lands the fixture, driver, normalization, judge delegation and the
materialization decision; the `--limit 20` smoke, the full 196-PR run, the
`--eval-rounds 3` averaging and the first `results/M1-*.md` are subsequent
execution. M1 is consistent with, and reuses, [ADR-0007](0007-aacr-verifier-offline-benchmark.md)
(M0): same opt-in surface, same isolation conventions, same provenance
guards, same unredistributed-data stance.

## Context

M0 measures the verifier in isolation on supplied comments with a binary
label. M1 asks the product-level question instead: **what does the shipped
`pir find` loop find when it reviews a real PR end to end, and how does that
compare with the published systems?** The only external caliber available for
that question is the upstream AACR-Bench evaluation framework: its
file-level semantic precision/recall and `balanced_score` are the numbers the
published OCR / Claude Code / Codex rows report. A home-grown judge would add
drift, cost and an unaccountable layer (roadmap risk R4) and would not be
comparable to anything.

### The reference population

`dataset/positive_samples.json` (pinned in `meta.json`'s `fixtures` block,
upstream commit `ee9d7fe`) is the **label=1** split: 196 PRs, 1,506
expert-reviewed, known-correct comments (1,498 right-side / 8 left-side),
50 repositories, 10 languages. It is not the 2,145-comment M0 corpus: there
are no label-0 comments here, so M1 cannot measure interception or kill-rate.
What it measures is coverage of known-correct feedback (recall), precision of
the findings the tool chose to report (a generated comment that hits no
uncovered reference comment is unmatched and lowers precision), and
`balanced_score` as their harmonic mean. This is the end-to-end analogue of
the published review benchmarks, not a verifier confusion matrix.

### The upstream framework

The pinned framework (`evaluation/`) is a three-stage pipeline: convert a
benchmark to a standard JSONL (`schema.py`), run a reviewer into
`results/<benchmark>/<reviewer>/<run_id>/<safe_id>.json`, then evaluate that
directory (`evaluate.py` + `judge.py`). For an unknown reviewer, evaluation
falls back to the OCR result shape:

```json
{"review": {"comments": [{"content": "...", "path": "...",
                          "start_line": 1, "end_line": 2}]},
 "duration_seconds": 1.5, "token_usage": {"input_tokens": 1, "output_tokens": 1}}
```

Only comments with non-empty `content` count; missing result files are
reported in `missing_instances` and excluded from denominators. `judge.py`
groups reference and generated comments by normalized path and judges
semantic coverage one-to-many; `side` and line numbers contextualize the
judge prompt but do not gate the file-level match. `JUDGE_USE_MOCK=true` (or a
missing `JUDGE_API_KEY`) selects a local similarity judge; a real judge uses
`JUDGE_BASE_URL` / `JUDGE_API_KEY` / `JUDGE_MODEL` and is imported with those
variables already set.

### The materialization problem M0 exposed

M0's ADR §7 establishes the shared, out-of-tree, depth-1 cache and the
GitHub-reported merge base, because the dataset's `source_commit` /
`target_commit` are a capture-time base/head pair and a naive two-SHA diff
folds base-branch drift in reverse. M1 reuses that cache and that merge-base
resolution (the merge-base cache file is shared), but `pir find` is not M0's
internal command: it calls `buildChangeSet`, which computes
`git diff <base>...<head>`. In a depth-1 cache the two trees are present but
their ancestry is not, so git reports **"no merge base"** and the review
fails before a model is ever called. This was verified on a local depth-1
fixture, not inferred. The M1 materialization decision below exists because
of that measurement.

## Decision

1. **Reference set = `positive_samples.json`, label=1 only.** Every M1
   reference comment is known-correct. M1 therefore reports semantic
   precision/recall/`balanced_score`, not M0's accuracy / kill-rate /
   false-kill. The fixture keeps all 1,506 comments, including the 8
   left-side ones: the upstream file-level judge matches by path and text, so
   a left-side reference remains evaluable even though `pir find` only
   reports right-side anchors. (M0's sampler excludes left-side comments for
   a different reason — its head-anchored `_verify-comment` mapping cannot
   express old-file lines.)

2. **Fixture conversion mirrors the upstream converter, and the body is not
   redistributed.** `tests/eval/aacr/fixtures/build-fixture.js` maps
   `repo = owner/name`, `base_commit = source_commit`,
   `head_commit = target_commit`, `instance_id =
   owner__name@<target_commit[:7]>` (dots preserved), `comments[]` to
   `reference_comments[]` (`text = note`, `start_line = from_line`,
   `end_line = to_line`, `side`) and to an index-aligned `comment_meta[]`
   (`category`, `context`, `is_ai_comment`, `source_model`), plus PR-level
   `change_line_count`, `project_main_language` and `pr_category` for the A1
   buckets. `meta.json` pins the raw file by URL, sha256, byte size, record
   count and comment count; the generated `fixtures/test-set.json` and the
   verified download cache are **gitignored**. Only the builder, the pin and
   the arXiv 2601.19494 citation are committed (ADR-0007 §10's
   unredistributed-data stance). A tampered or changed upstream file fails
   the pin before anything is written.

3. **One driver, rb-grade isolation, same-repo serial / cross-repo
   concurrent.** `tests/eval/aacr/m1/run-aacr.js` is the ReviewBench runner's
   clone: shared clone cache, detached head worktree, redirected
   `HOME`/XDG, per-instance cold `PIR_MEMORY_DB`, ephemeral credential
   snapshot, `PIR_NO_WIZARD=1`, `PIR_TRANSCRIPTS=0`, `PIR_MODE=local`,
   `PIR_EVAL=1`, `--local`, `--plugins none`, a 30-minute default timeout,
   and an explicit `--max-tokens unlimited --max-findings unlimited`
   (omitting the token flag would measure B3's default ceiling instead of
   the run). Instances of one repository are processed serially because they
   share one cache directory; different repositories run concurrently up to
   `--concurrency`. Every failure — fetch, merge-base resolution,
   materialization, timeout, CLI error, malformed JSON — becomes an error row
   and a round never aborts. The CLI under test is the built artifact
   (`dist/cli/cli.js`), never an import of `dist`.

4. **Two views, both judged.** `normalize-aacr.js` turns one envelope into
   `reported` (status confirmed + uncertain) and `confirmedOnly` (confirmed).
   The reported view is the uncertain=keep calibration ADR-0007 fixed for
   M0; the confirmed-only view is the strict precision arm. Each is written
   as upstream-shaped result files and judged separately, so the calibration
   cost is visible rather than averaged away. Findings with no usable anchor
   (a path plus an integer start line) are dropped and counted
   (`dropped.anchorless` / `dropped.total`), never silently mapped to another
   file or line. Text is the deterministic join of title, claim and trigger
   with one blank line between parts.

5. **Judging is delegated, never rebuilt.** `m1/judge.js` resolves the
   pinned upstream clone at `$PIR_AACR_JUDGE_DIR` (default
   `$PIR_AACR_CACHE/aacr-bench@<commit>`), fetches depth 1 of the pinned
   commit when absent, verifies an existing clone is at that exact commit
   (judge drift invalidates comparisons), writes the selected rows as
   `evaluation/data/aacr_bench.jsonl`, copies the per-view result files into
   `evaluation/results/aacr_bench/<reviewer>/<run_id>/`, and runs
   `python3 -m pipeline run --stage eval` from `evaluation/`, which writes
   `evaluation/metrics/aacr_bench/<reviewer>/<run_id>/`. Only those three
   generated upstream directories (all gitignored there) are written; no
   tracked upstream file is modified and no patch is carried. Upstream's CLI accepts
   only `ocr|claude|codex`; M1's files are OCR-shaped, so the delegation uses
   `--reviewer ocr`, whose `evaluate.py` builder is exactly that shape. The
   metrics JSON path and summary lines are relayed into our summary. This is
   a deliberate implementation of ADR-0007 §9 ("M1 delegates") and M0's
   non-goal: no home-grown judge, no re-scored proxy.

6. **`balanced_score` is the external caliber; missing is not zero.** The
   headline is upstream's `balanced_score` with its precision and recall
   components, per view. Instances whose result files are missing (errors,
   timeouts, unreachable commits) are counted in `missing_instances` and
   excluded from denominators, exactly as upstream does; they are never
   scored as empty reviews. A round with errors is published as a partial
   round with the error count, never extrapolated. M1 buckets (language,
   comment category, PR size) come from the fixture's own fields; the later
   A1 report renders them, this skeleton records the raw provenance. Bucket
   rows are descriptive, not causal.

7. **Materialization: shared depth-1 cache + GitHub-reported merge base +
   deterministic synthetic head only when needed.** Per repository the driver
   reuses `ensureRepoCache`; it fetches `target_commit` (the head) and the
   GitHub-reported merge base with `--depth 1`, and checks out the head tree
   in a detached worktree. The merge base is resolved through the same
   `resolveMergeBase` / `cachedMergeBase` / `rememberMergeBase` path as M0
   and shares `merge-bases.json`; a failed resolution is not cached and
   degrades that instance to the dataset's `source_commit` base tip, recorded
   as `diffBaseKind: "base-tip"`. Because a depth-1 cache has no ancestry,
   `pir find`'s internal `git diff <diffBase>...<head>` would fail; the
   driver therefore checks ancestry and, only when it is absent, creates a
   content-addressed synthetic head commit with the head's exact tree and the
   merge base as parent (fixed identity, dates and message), passes it as
   `--head`, and records both the dataset head and `reviewHead` /
   `syntheticHead` in the row and summary. The reviewer sees the real head
   tree and exactly the PR diff; the original head sha remains the recorded
   identity, and the judge never sees commit shas. The fallback, if a
   repository cannot be fetched at depth 1 at all (or synthetic commit
   creation fails), is a blobless partial clone
   (`git fetch --filter=blob:none`) or a full-history fetch for that one
   repository, re-run with the same provenance fields; the current skeleton
   records such instances as error rows rather than silently switching
   materialization.

8. **Cost and variance stance.** The `--limit 20` smoke is a documented
   manual command (README and this ADR), never a CI gate (roadmap M2 T3,
   ADR-0003 §4). `--repeats` exists for repeated runs; the full comparison
   uses upstream's `--eval-rounds 3` averaging later, and the smoke reports a
   single judge round. Every row records per-PR token usage, duration, exit
   status, `incomplete`/`stoppedBecause`, and whether the diff base was
   degraded or the head synthetic. The exact model id (e.g.
   `opencode-go/deepseek-v4.1-flash:medium`), the CLI sha256, the fixture
   sha256 and the selected instance-set digest are in `summary.json`. Model
   sampling is not controlled locally; repeats expose variance, not
   determinism.

9. **Provenance and resume guards are extended, not weakened.** `--resume`
   refuses to mix a different model, CLI build, fixture sha256, view set or
   repeat count into one round (M0's `assertResumeCompatible` plus the M1
   inputs). A round directory without `--resume` is a hard error, and
   `finishedAt` is absent while a round is running. Result files and rows are
   written incrementally, so an interrupted round keeps its completed work
   and `summary.json` never claims a finished round that did not finish.

10. **Scope boundaries.** M1 does not modify upstream, does not add a
    `reviewers/pir.py` (roadmap A2 is an optional later contribution), does
    not re-run the full 196 PRs in this skeleton, and does not change `src/`.
    The judge mock mode is a pipeline check, not a publishable score; only a
    real-judge run with the exact judge model recorded qualifies for
    comparison. The M1 numbers are not comparable to M0's kill-rate and must
    not be quoted as such.

## Consequences

- M1 measures the whole loop on the same material and with the same judge as
  the published rows, which is the only honest route to an external
  comparison. The cost is that the comparison inherits the upstream judge's
  behavior and any future upstream change: the commit pin is load-bearing,
  judge drift is a hard error, and re-running the judge on fixed results is a
  separate, recorded step.
- The positive-only population means precision can be lowered by legitimate
  findings that no reference comment covers. That is the upstream metric's
  own definition (an unmatched generated comment is not credited), not a
  pir-specific penalty; results must state it.
- The synthetic head is an identity substitution, not a content
  substitution: tree, diff and paths are the dataset's. The visible cost is
  that `--head` in the CLI envelope is a synthetic sha; the row/summary pair
  keeps both and the judge is unaffected. If a future `pir` release can
  consume a pre-resolved diff base without recomputing merge-base, the
  synthetic commit can be deleted without changing any stored result.
- The depth-1 path is cheap but not universal: a repository whose head or
  merge base cannot be fetched at depth 1 becomes an error row and a partial
  result. The blobless partial-clone fallback is the documented next step,
  not a hidden behavior.
- The `--limit 20` smoke is a manual, paid check. It is intentionally absent
  from `npm test`; the model-free suite covers the builder, normalizer,
  options, resume guards, result/row writing against a fake CLI and the judge
  invocation builder without network, credentials or a model.
- Fixture and framework are Apache-2.0 and unredistributed: the repository
  commits pins and the arXiv 2601.19494 citation, never the bodies. Every
  generated fixture header, round summary and later results file repeats the
  citation.

## References

- Roadmap: [`docs/roadmap-ocr-borrow-and-aacr-benchmark.md`](../roadmap-ocr-borrow-and-aacr-benchmark.md), §2 M1; companion context §4.2–4.3.
- M0 protocol and conventions: [ADR-0007](0007-aacr-verifier-offline-benchmark.md).
- Upstream: [alibaba/aacr-bench](https://github.com/alibaba/aacr-bench) @ `ee9d7fef70ef31acea2ff7ae316ce0a9575fe4df` (Apache-2.0), `evaluation/pipeline.py`, `evaluation/evaluate.py`, `evaluation/judge.py`, `evaluation/config.py`.
- Citation: arXiv 2601.19494, `AACR-Bench: Evaluating Automatic Code Review with Holistic Repository-Level Context`.
