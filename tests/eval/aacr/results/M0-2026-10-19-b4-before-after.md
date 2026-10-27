# Verifier benchmark — rejection grounds: controlled before/after (2026-10-19)

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
| round | `2026-10-19-b4-after` |
| date | 2026-10-19T10:11:36.412Z → 2026-10-19T11:52:14.185Z |
| model (both arms) | `opencode-go/deepseek-v4.1-flash:medium` |
| CLI sha256 | `2a6ce18571d8a26ca89c884bfc943f974f3065897b47d201f5cfe51061171e9d` |
| build sha256 (dist digest) | `64734461199b059cf25a810b4b8390e6af724c5ec200b4a8d4efa0d135bc53ad` |
| dataset sha256 | `0804505f0a474765ce2840c832cfeaa6c4f0250dd6ccb169fe73c6758b245a86` |
| sample | limit 100, seed 42, digest `74f43e2f25442f0e62f97a9b960ae46de6f05eebfe5173298e16c9838aafc07d` |
| arms | verifier |
| concurrency / timeout | 1 / 300000 ms |
| materialization errors | 5 (excluded rows) |
| clone cache | `/home/miku/review-agents/.cache/pir-aacr` (16661 MiB) |
| config snapshot | model zai-coding-cn/glm-5.3:max, thinking low |

## Headline metrics

| arm | policy | n | label1/label0 | metrics |
| --- | --- | --- | --- | --- |
 | verifier | **uncertain=keep** | 95 | 70 / 25 | acc 36.8% | P 75.0% | R 21.4% | F1 33.3% | kill 80.0% | falseKill 78.6% | interceptP 26.7% | AUC 0.544 | 
 | verifier | uncertain=miss | 95 | 70 / 25 | acc 36.8% | P 75.0% | R 21.4% | F1 33.3% | kill 80.0% | falseKill 78.6% | interceptP 26.7% | AUC 0.544 | 
 | verifier | errors / invalid / strict-unresolved | 0 / 0 / 0 |  | 

## Before/after (controlled build comparison)

Same dataset, sample, model and arms; only the CLI build differs (− = the pre-change build, + = the build under test). This is a point comparison: the rb variance rule (a "no regression" claim needs both runs no worse than the comparison's worse run) cannot be satisfied by one run per side, and repeats remain a separate round.

| side | arm | n | label1/label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | invalid/errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | − `b6214403` | verifier | 95 | 70 / 25 | 37.9% | 76.2% | 22.9% | 35.2% | 80.0% | 77.1% | 27.0% | 0 / 0 | 
 | + `64734461` | verifier | 95 | 70 / 25 | 36.8% | 75.0% | 21.4% | 33.3% | 80.0% | 78.6% | 26.7% | 0 / 0 | 

- **verifier — rejection-grounds gate**: falseKillRate 77.1% → 78.6% (+1.4 pp) ⇒ **REGRESSION**; killRate 80.0% → 80.0% (±0.0 pp); interceptPrecision 27.0% → 26.7% (−0.4 pp). The three are read together (roadmap R9): a falseKillRate that fell by rejecting fewer comments overall is not automatically an improvement.

## verifier — per-bucket metrics

### uncertain = keep (primary)

**source_model**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | human | 27 | 23 | 4 | 25.9% | 71.4% | 21.7% | 33.3% | 50.0% | 78.3% | 10.0% | 0.288 | 
 | GPT-5.2 | 23 | 19 | 4 | 26.1% | 100.0% | 10.5% | 19.0% | 100.0% | 89.5% | 19.0% | 0.447 | 
 | GLM-4.7 | 12 | 7 | 5 | 33.3% | 33.3% | 14.3% | 20.0% | 60.0% | 85.7% | 33.3% | 0.443 | 
 | Qwen-Coder-480B | 11 | 8 | 3 | 27.3% | — | 0.0% | 0.0% | 100.0% | 100.0% | 27.3% | 0.292 | 
 | Gemini-3-Pro | 9 | 5 | 4 | 77.8% | 80.0% | 80.0% | 80.0% | 75.0% | 20.0% | 75.0% | 0.800 | 
 | Claude-Code/Claude-4.5-Sonnet | 8 | 5 | 3 | 62.5% | 100.0% | 40.0% | 57.1% | 100.0% | 60.0% | 50.0% | 0.833 | 
 | Deepseek-V3.2 | 5 | 3 | 2 | 60.0% | 100.0% | 33.3% | 50.0% | 100.0% | 66.7% | 50.0% | 0.667 | 

**category**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | Code Defect | 43 | 31 | 12 | 37.2% | 66.7% | 25.8% | 37.2% | 66.7% | 74.2% | 25.8% | 0.446 | 
 | Maintainability and Readability | 39 | 28 | 11 | 35.9% | 80.0% | 14.3% | 24.2% | 90.9% | 85.7% | 29.4% | 0.669 | 
 | Performance | 7 | 6 | 1 | 42.9% | 100.0% | 33.3% | 50.0% | 100.0% | 66.7% | 20.0% | 0.833 | 
 | Security Vulnerability | 6 | 5 | 1 | 33.3% | 100.0% | 20.0% | 33.3% | 100.0% | 80.0% | 20.0% | 0.200 | 

**context**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | Diff Level | 46 | 38 | 8 | 37.0% | 100.0% | 23.7% | 38.3% | 100.0% | 76.3% | 21.6% | 0.592 | 
 | File Level | 34 | 23 | 11 | 32.4% | 50.0% | 17.4% | 25.8% | 63.6% | 82.6% | 26.9% | 0.528 | 
 | Repo Level | 15 | 9 | 6 | 46.7% | 66.7% | 22.2% | 33.3% | 83.3% | 77.8% | 41.7% | 0.463 | 

**is_ai_comment**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | true | 68 | 47 | 21 | 41.2% | 76.9% | 21.3% | 33.3% | 85.7% | 78.7% | 32.7% | 0.562 | 
 | false | 27 | 23 | 4 | 25.9% | 71.4% | 21.7% | 33.3% | 50.0% | 78.3% | 10.0% | 0.288 | 

### uncertain = miss (strict)

**source_model**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | human | 27 | 23 | 4 | 25.9% | 71.4% | 21.7% | 33.3% | 50.0% | 78.3% | 10.0% | 0.288 | 
 | GPT-5.2 | 23 | 19 | 4 | 26.1% | 100.0% | 10.5% | 19.0% | 100.0% | 89.5% | 19.0% | 0.447 | 
 | GLM-4.7 | 12 | 7 | 5 | 33.3% | 33.3% | 14.3% | 20.0% | 60.0% | 85.7% | 33.3% | 0.443 | 
 | Qwen-Coder-480B | 11 | 8 | 3 | 27.3% | — | 0.0% | 0.0% | 100.0% | 100.0% | 27.3% | 0.292 | 
 | Gemini-3-Pro | 9 | 5 | 4 | 77.8% | 80.0% | 80.0% | 80.0% | 75.0% | 20.0% | 75.0% | 0.800 | 
 | Claude-Code/Claude-4.5-Sonnet | 8 | 5 | 3 | 62.5% | 100.0% | 40.0% | 57.1% | 100.0% | 60.0% | 50.0% | 0.833 | 
 | Deepseek-V3.2 | 5 | 3 | 2 | 60.0% | 100.0% | 33.3% | 50.0% | 100.0% | 66.7% | 50.0% | 0.667 | 

**category**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | Code Defect | 43 | 31 | 12 | 37.2% | 66.7% | 25.8% | 37.2% | 66.7% | 74.2% | 25.8% | 0.446 | 
 | Maintainability and Readability | 39 | 28 | 11 | 35.9% | 80.0% | 14.3% | 24.2% | 90.9% | 85.7% | 29.4% | 0.669 | 
 | Performance | 7 | 6 | 1 | 42.9% | 100.0% | 33.3% | 50.0% | 100.0% | 66.7% | 20.0% | 0.833 | 
 | Security Vulnerability | 6 | 5 | 1 | 33.3% | 100.0% | 20.0% | 33.3% | 100.0% | 80.0% | 20.0% | 0.200 | 

**context**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | Diff Level | 46 | 38 | 8 | 37.0% | 100.0% | 23.7% | 38.3% | 100.0% | 76.3% | 21.6% | 0.592 | 
 | File Level | 34 | 23 | 11 | 32.4% | 50.0% | 17.4% | 25.8% | 63.6% | 82.6% | 26.9% | 0.528 | 
 | Repo Level | 15 | 9 | 6 | 46.7% | 66.7% | 22.2% | 33.3% | 83.3% | 77.8% | 41.7% | 0.463 | 

**is_ai_comment**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | true | 68 | 47 | 21 | 41.2% | 76.9% | 21.3% | 33.3% | 85.7% | 78.7% | 32.7% | 0.562 | 
 | false | 27 | 23 | 4 | 25.9% | 71.4% | 21.7% | 33.3% | 50.0% | 78.3% | 10.0% | 0.288 | 

### Rejection grounds

| ground | kills | label0 | label1 | false-kill share of ground |
| --- | --- | --- | --- | --- |
 | speculative | 36 | 9 | 27 | 75.0% | 
 | contradicted-by-code | 23 | 7 | 16 | 69.6% | 
 | pre-existing | 8 | 3 | 5 | 62.5% | 
 | guarded | 5 | 0 | 5 | 100.0% | 
 | not-introduced-by-change | 3 | 1 | 2 | 66.7% | 

A ground is the reason a rejected verdict named (ADR-0008). The distribution is over kills under both policies — a rejected verdict is a kill either way — so it reads as the audit trail of the arm's kill decisions. Rows without a ground pre-date the rejection grounds or belong to the OCR arm, which has no ground vocabulary; they are counted as `unknown` rather than dropped.

## Notes and limits

- Verifier arm only: the rejection-grounds change modifies the change-mode verifier prompt and submit_verdict's contract, while the OCR arm and its prompt are untouched — an OCR row would be an unchanged control, not evidence (ADR-0008 §6).
- Both sides ran the fixed Iteration 1 sample (100 comments, seed 42, digest 74f43e2f…c07d; 95 usable rows after 5 materialization errors), the same model id, one run per side. Builds: − a clean checkout of the pre-the rejection grounds branch tip 9fd6ea7 built with npm run build:cli (dist digest b6214403…); + this branch (dist digest 64734461…). Only the build differs. The earlier 100-sample round is a different single run (that sample face is retired in favour of the full-corpus baseline) — its numbers differ from this before side by ordinary model variance, which is why the gate re-ran its own before side.
- Gate reading: the net falseKillRate delta is one label-1 comment (54/70 → 55/70) while five label-1 comments swapped sides (three newly killed with grounds speculative, speculative, contradicted-by-code; two recovered as confirmed), and the label-0 kill count is identical (20) — so killRate's 3.3 pp rise is a denominator effect (25 → 24 negative rows), not more interception. A one-comment delta is this sample's resolution, so the strict 'must not regress' rule is not satisfied as proof; the gate is recorded as not proven either way, with no evidence of a systematic increase in false kills (ADR-0008, gate result).
- One after-side row (c2080) produced no verdict: its verifier session hung on the provider twice and the task timeout recorded a counted error row. An error counts as a miss for killRate and is never a silent exclusion; both sides keep all 70 label-1 comments, so the false-kill comparison is unaffected.
- Grounds are the audit trail: contradicted-by-code is a claim the code refutes, speculative a claim with no concrete failure, guarded an unreachable one, and pre-existing / not-introduced-by-change are ADR-0007's measured-limitation class (correct review feedback that the shipped do-not-report contract still rejects). Read the distribution with killRate and interceptPrecision, never instead of them.
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
