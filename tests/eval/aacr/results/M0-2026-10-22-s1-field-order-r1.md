# Verifier benchmark — field-order experiment, repeat 1 of 2 (2026-10-22)

> Dataset: [Alibaba-Aone/aacr-bench](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench) `dataset.json` revision `47be1d6df1e7faf222cf531587772d92f79fe6b2`, sha256 `0804505f0a474765ce2840c832cfeaa6c4f0250dd6ccb169fe73c6758b245a86` (2145 records), Apache-2.0.
 The OCR comparison arm ports `review_filter_task_system.md` / `review_filter_task_user.md` from [alibaba/open-code-review](https://github.com/alibaba/open-code-review) @ `8eb83340a487b1150af00701b94f01af97e4b4d6` (Apache-2.0), strictly as evaluation apparatus.
>

## Protocol

Comment-level binary classification: label 1 = the comment is correct (should survive), label 0 = incorrect (should be intercepted).
 The pir arm runs the shipped verifier (`pir _verify-comment --arm verifier`, production `runVerifier` with the full repository checkout at the comment's capture-time head commit); the OCR arm runs the ported open-code-review reflection prompt on the same material (diff only, no tools), same model id, same scoring code. Per ADR-0007:

**This round ran the pir verifier arm only** (the arms row in Run configuration names it): no OCR row was scored, so the comparison sentences below describe the two-arm protocol and not a second arm of this run.

- Primary policy **uncertain = keep**: `confirmed` and `uncertain` both count as keeps, only `rejected` kills. The strict policy **uncertain = miss** is reported beside it: an uncertain verdict earns no credit in either direction (neither a keep nor a kill).
- **killRate** = share of label-0 comments intercepted (north-star metric; higher is better). **falseKillRate** = share of label-1 comments destroyed (cost side, and the rejection grounds merge gate; lower is better).
 **interceptPrecision** = share of kills that were label 0. ADR-0007 §5 explains why the three are always read together; the rejection-grounds acceptance text uses "kill-rate" for what this file calls falseKillRate, so this file names all three explicitly and none can be misread.
- Accuracy/precision/recall/F1 are over the keep decision (positives = label 1).
 AUC ranks rows by the verifier's keep-score: confirmed = 0.5 + c/2, rejected = 0.5 − c/2, uncertain = 0.5 (OCR arm: approve = 1, remove = 0).
 Rows with no decision (error, invalid, or strict-policy uncertain) count as misses, never as silent exclusions.
- Sample variance rules copied from `tests/eval/reviewbench/RESULTS.md`: a "no regression" claim needs both comparison runs no worse than the comparison's worse run; a model or prompt change voids comparability.
 Every verifier-benchmark round publishes one run per arm — these are one sample's numbers, not a variance floor; repeats are a separate round's job.
- No judge is involved (ADR-0007 §9): the dependent variable is the dataset's expert label, so these numbers are judge-drift-free by construction and are **not** comparable to the end-to-end benchmark's `balanced_score`.

## Run configuration

| field | value |
| --- | --- |
| round | `2026-10-22-s1-order-after-r1` |
| date | 2026-10-22T11:04:11.076Z → 2026-10-22T12:02:01.934Z |
| model (both arms) | `zai-coding-cn/glm-5.3:max` |
| CLI sha256 | `8d7de831b184d055141f1f8de711232dd78fe2803e2038b293a8aed3ae1e28b9` |
| build sha256 (dist digest) | `09fb3ae9c6b688a0817ef5486ea5e89ba1e8ae3b30a2994ce8139ff9a60eab65` |
| dataset sha256 | `0804505f0a474765ce2840c832cfeaa6c4f0250dd6ccb169fe73c6758b245a86` |
| sample | limit 100, seed 42, digest `74f43e2f25442f0e62f97a9b960ae46de6f05eebfe5173298e16c9838aafc07d` |
| arms | verifier |
| concurrency / timeout | 4 / 1200000 ms |
| materialization errors | 5 (excluded rows) |
| clone cache | `/home/miku/review-agents/.cache/pir-aacr` (16716 MiB) |
| config snapshot | model zai-coding-cn/glm-5.3:max, thinking low |

## Headline metrics

| arm | policy | n | label1/label0 | metrics |
| --- | --- | --- | --- | --- |
 | verifier | **uncertain=keep** | 95 | 70 / 25 | acc 42.1% | P 77.8% | R 30.0% | F1 43.3% | kill 76.0% | falseKill 70.0% | interceptP 27.9% | AUC 0.511 | 
 | verifier | uncertain=miss | 95 | 70 / 25 | acc 42.1% | P 77.8% | R 30.0% | F1 43.3% | kill 76.0% | falseKill 70.0% | interceptP 27.9% | AUC 0.511 | 
 | verifier | errors / invalid / strict-unresolved | 0 / 0 / 0 |  | 

## Session usage

Tokens as reported by each run's CLI result, summed over the rows that reported usage. `total tokens` includes cache reads and the CLI result does not itemise them, so the three columns do not compose: read `output tokens` as the generated-token cost and `total tokens` as session volume, never as input + output. `output / row` is the cost side, read beside killRate and falseKillRate as one group and never instead of them. Rows without usage (errors, older builds) are excluded from the sums and stay visible in the `rows with usage` column.

| arm | rows with usage | input tokens | output tokens | total tokens | output / row | total / row |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
 | verifier | 95 | 1,637,462 | 735,142 | 14,534,652 | 7,738 | 152,996 | 

## Before/after (controlled build comparison)

Same dataset, sample, model and arms; only the CLI build differs (− = the pre-change build, + = the build under test). This is a point comparison: the rb variance rule (a "no regression" claim needs both runs no worse than the comparison's worse run) cannot be satisfied by one run per side, and repeats remain a separate round.

| side | arm | n | label1/label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | invalid/errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | − `47e77911` | verifier | 95 | 70 / 25 | 43.2% | 76.7% | 32.9% | 46.0% | 72.0% | 67.1% | 27.7% | 0 / 0 | 
 | + `09fb3ae9` | verifier | 95 | 70 / 25 | 42.1% | 77.8% | 30.0% | 43.3% | 76.0% | 70.0% | 27.9% | 0 / 0 | 

- **verifier — rejection-grounds gate**: falseKillRate 67.1% → 70.0% (+2.9 pp) ⇒ **REGRESSION**; killRate 72.0% → 76.0% (+4.0 pp); interceptPrecision 27.7% → 27.9% (+0.2 pp). The three are read together (roadmap R9): a falseKillRate that fell by rejecting fewer comments overall is not automatically an improvement.

**Session usage (both sides).** Tokens as reported by each run's CLI result; `output / row` is the cost side of the comparison, read beside the other metrics and never instead of them. `total tokens` includes cache reads the CLI result does not itemise, so it does not equal input + output.

| side | arm | rows with usage | input tokens | output tokens | total tokens | output / row |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
 | − `47e77911` | verifier | 95 | 1,548,085 | 722,711 | 13,901,324 | 7,607 | 
 | + `09fb3ae9` | verifier | 95 | 1,637,462 | 735,142 | 14,534,652 | 7,738 | 

## verifier — per-bucket metrics

### uncertain = keep (primary)

**source_model**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | human | 27 | 23 | 4 | 33.3% | 72.7% | 34.8% | 47.1% | 25.0% | 65.2% | 6.3% | 0.212 | 
 | GPT-5.2 | 23 | 19 | 4 | 30.4% | 100.0% | 15.8% | 27.3% | 100.0% | 84.2% | 20.0% | 0.487 | 
 | GLM-4.7 | 12 | 7 | 5 | 41.7% | 50.0% | 28.6% | 36.4% | 60.0% | 71.4% | 37.5% | 0.429 | 
 | Qwen-Coder-480B | 11 | 8 | 3 | 27.3% | — | 0.0% | 0.0% | 100.0% | 100.0% | 27.3% | 0.375 | 
 | Gemini-3-Pro | 9 | 5 | 4 | 66.7% | 75.0% | 60.0% | 66.7% | 75.0% | 40.0% | 60.0% | 0.775 | 
 | Claude-Code/Claude-4.5-Sonnet | 8 | 5 | 3 | 87.5% | 100.0% | 80.0% | 88.9% | 100.0% | 20.0% | 75.0% | 1.000 | 
 | Deepseek-V3.2 | 5 | 3 | 2 | 60.0% | 100.0% | 33.3% | 50.0% | 100.0% | 66.7% | 50.0% | 0.833 | 

**category**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | Code Defect | 43 | 31 | 12 | 37.2% | 66.7% | 25.8% | 37.2% | 66.7% | 74.2% | 25.8% | 0.364 | 
 | Maintainability and Readability | 39 | 28 | 11 | 48.7% | 83.3% | 35.7% | 50.0% | 81.8% | 64.3% | 33.3% | 0.653 | 
 | Performance | 7 | 6 | 1 | 42.9% | 100.0% | 33.3% | 50.0% | 100.0% | 66.7% | 20.0% | 0.667 | 
 | Security Vulnerability | 6 | 5 | 1 | 33.3% | 100.0% | 20.0% | 33.3% | 100.0% | 80.0% | 20.0% | 0.700 | 

**context**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | Diff Level | 46 | 38 | 8 | 37.0% | 90.9% | 26.3% | 40.8% | 87.5% | 73.7% | 20.0% | 0.563 | 
 | File Level | 34 | 23 | 11 | 47.1% | 72.7% | 34.8% | 47.1% | 72.7% | 65.2% | 34.8% | 0.484 | 
 | Repo Level | 15 | 9 | 6 | 46.7% | 60.0% | 33.3% | 42.9% | 66.7% | 66.7% | 40.0% | 0.519 | 

**is_ai_comment**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | true | 68 | 47 | 21 | 45.6% | 81.3% | 27.7% | 41.3% | 85.7% | 72.3% | 34.6% | 0.565 | 
 | false | 27 | 23 | 4 | 33.3% | 72.7% | 34.8% | 47.1% | 25.0% | 65.2% | 6.3% | 0.212 | 

### uncertain = miss (strict)

**source_model**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | human | 27 | 23 | 4 | 33.3% | 72.7% | 34.8% | 47.1% | 25.0% | 65.2% | 6.3% | 0.212 | 
 | GPT-5.2 | 23 | 19 | 4 | 30.4% | 100.0% | 15.8% | 27.3% | 100.0% | 84.2% | 20.0% | 0.487 | 
 | GLM-4.7 | 12 | 7 | 5 | 41.7% | 50.0% | 28.6% | 36.4% | 60.0% | 71.4% | 37.5% | 0.429 | 
 | Qwen-Coder-480B | 11 | 8 | 3 | 27.3% | — | 0.0% | 0.0% | 100.0% | 100.0% | 27.3% | 0.375 | 
 | Gemini-3-Pro | 9 | 5 | 4 | 66.7% | 75.0% | 60.0% | 66.7% | 75.0% | 40.0% | 60.0% | 0.775 | 
 | Claude-Code/Claude-4.5-Sonnet | 8 | 5 | 3 | 87.5% | 100.0% | 80.0% | 88.9% | 100.0% | 20.0% | 75.0% | 1.000 | 
 | Deepseek-V3.2 | 5 | 3 | 2 | 60.0% | 100.0% | 33.3% | 50.0% | 100.0% | 66.7% | 50.0% | 0.833 | 

**category**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | Code Defect | 43 | 31 | 12 | 37.2% | 66.7% | 25.8% | 37.2% | 66.7% | 74.2% | 25.8% | 0.364 | 
 | Maintainability and Readability | 39 | 28 | 11 | 48.7% | 83.3% | 35.7% | 50.0% | 81.8% | 64.3% | 33.3% | 0.653 | 
 | Performance | 7 | 6 | 1 | 42.9% | 100.0% | 33.3% | 50.0% | 100.0% | 66.7% | 20.0% | 0.667 | 
 | Security Vulnerability | 6 | 5 | 1 | 33.3% | 100.0% | 20.0% | 33.3% | 100.0% | 80.0% | 20.0% | 0.700 | 

**context**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | Diff Level | 46 | 38 | 8 | 37.0% | 90.9% | 26.3% | 40.8% | 87.5% | 73.7% | 20.0% | 0.563 | 
 | File Level | 34 | 23 | 11 | 47.1% | 72.7% | 34.8% | 47.1% | 72.7% | 65.2% | 34.8% | 0.484 | 
 | Repo Level | 15 | 9 | 6 | 46.7% | 60.0% | 33.3% | 42.9% | 66.7% | 66.7% | 40.0% | 0.519 | 

**is_ai_comment**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | true | 68 | 47 | 21 | 45.6% | 81.3% | 27.7% | 41.3% | 85.7% | 72.3% | 34.6% | 0.565 | 
 | false | 27 | 23 | 4 | 33.3% | 72.7% | 34.8% | 47.1% | 25.0% | 65.2% | 6.3% | 0.212 | 

### Rejection grounds

| ground | kills | label0 | label1 | false-kill share of ground |
| --- | --- | --- | --- | --- |
 | speculative | 26 | 8 | 18 | 69.2% | 
 | contradicted-by-code | 25 | 7 | 18 | 72.0% | 
 | pre-existing | 13 | 4 | 9 | 69.2% | 
 | guarded | 4 | 0 | 4 | 100.0% | 

A ground is the reason a rejected verdict named (ADR-0008). The distribution is over kills under both policies — a rejected verdict is a kill either way — so it reads as the audit trail of the arm's kill decisions. Rows without a ground pre-date the rejection grounds or belong to the OCR arm, which has no ground vocabulary; they are counted as `unknown` rather than dropped.

## Notes and limits

- Intervention: the + build declares rationale before verdict in submit_verdict, the − build is the shipped order (verdict first). The only source difference is one line in src/tools/collector-tools.ts, quoted in [ADR 0007 Part III](../../../../docs/adr/0007-aacr-benchmarks-and-verifier-calibration.md); the two dist digests differ by exactly that line.
- Repeat 1 of 2 per side on the fixed sample; the other pair is [M0-2026-10-22-s1-field-order-r2.md](M0-2026-10-22-s1-field-order-r2.md). This document is one point comparison, not a variance floor: both repeats are read together in ADR 0007 Part III, where the adoption decision is recorded.
- Caliber: the pir arm is repository-aware (pinned reads, search, structural queries) while the OCR arm is diff-only, which is the OCR prompt's native material. A diff-only pir ablation is deliberately out of scope for the verifier benchmark.
- Diff base: every scored row used the GitHub merge base (ADR-0007 §7); no degraded base-tip rows.
- **Target question (measured limitation, ADR-0007 Consequences):** the dataset's label asks whether the comment is *correct review feedback*; `runVerifier` answers whether a *concrete, change-attributable defect* exists. The first run's rationales show valid comments rejected precisely because they are a style preference or a pre-existing observation, which the shipped do-not-report contract requires. `falseKillRate` is therefore still `rejected(label=1)/label=1` operationally, but it must not be read as "the verifier destroys real findings", and it is not the same quantity as the OCR arm's false-kill. Read `killRate` (label-0 interception) and the per-category table jointly; Maintainability concentrates the mismatch.
- Ground truth is 3/4 AI-authored comments verified by domain experts (roadmap R3); read the `is_ai_comment` and `source_model` buckets before extrapolating to human-review taste.
 The dataset's 1,505/640 split makes label-0 the smaller population, so every kill-family number carries a wide interval at this sample size.
- Dataset `pr_source_commit`/`pr_target_commit` are a capture-time base/head pair; the per-comment diff is `merge-base..head` using the merge base GitHub reports for that pair, narrowed to the comment's path (ADR-0007 §7).
 Comments whose path is not in the PR diff are materialized as `pathInDiff=false` with an empty diff rather than dropped.
- The git clone cache is shared and out of tree (`$PIR_AACR_CACHE`); `tests/eval/aacr/dataset/` and `tests/eval/aacr/out/` are gitignored, so every number below is rebuildable from the pin in `tests/eval/aacr/meta.json`.

Citation (required when using AACR-Bench data):

```bibtex
@misc{zhang2026aacrbenchevaluatingautomaticcode,
  title={AACR-Bench: Evaluating Automatic Code Review with Holistic Repository-Level Context},
  author={Lei Zhang and Yongda Yu and Minghui Yu and others},
  year={2026}, eprint={2601.19494}, archivePrefix={arXiv}, primaryClass={cs.SE}
}
```
