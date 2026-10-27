# M0 — AACR-Bench verifier offline benchmark (2026-10-27)

> Dataset: [Alibaba-Aone/aacr-bench](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench) `dataset.json` revision `47be1d6df1e7faf222cf531587772d92f79fe6b2`, sha256 `0804505f0a474765ce2840c832cfeaa6c4f0250dd6ccb169fe73c6758b245a86` (2145 records), Apache-2.0.
 The OCR comparison arm ports `review_filter_task_system.md` / `review_filter_task_user.md` from [alibaba/open-code-review](https://github.com/alibaba/open-code-review) @ `8eb83340a487b1150af00701b94f01af97e4b4d6` (Apache-2.0), strictly as evaluation apparatus.
>

## Protocol

Comment-level binary classification: label 1 = the comment is correct (should survive), label 0 = incorrect (should be intercepted).
 The pir arm runs the shipped verifier (`pir _verify-comment --arm verifier`, production `runVerifier` with the full repository checkout at the comment's capture-time head commit); the OCR arm runs the ported open-code-review reflection prompt on the same material (diff only, no tools), same model id, same scoring code. Per ADR-0007:

- Primary policy **uncertain = keep**: `confirmed` and `uncertain` both count as keeps, only `rejected` kills. The strict policy **uncertain = miss** is reported beside it: an uncertain verdict earns no credit in either direction (neither a keep nor a kill).
- **killRate** = share of label-0 comments intercepted (north-star metric; higher is better). **falseKillRate** = share of label-1 comments destroyed (cost side, and the B4 merge gate; lower is better).
 **interceptPrecision** = share of kills that were label 0. ADR-0007 §5 explains why the three are always read together; the roadmap's B4 acceptance text uses "kill-rate" for what this file calls falseKillRate, so this file names all three explicitly and none can be misread.
- Accuracy/precision/recall/F1 are over the keep decision (positives = label 1).
 AUC ranks rows by the verifier's keep-score: confirmed = 0.5 + c/2, rejected = 0.5 − c/2, uncertain = 0.5 (OCR arm: approve = 1, remove = 0).
 Rows with no decision (error, invalid, or strict-policy uncertain) count as misses, never as silent exclusions.
- Sample variance rules copied from `tests/eval/reviewbench/RESULTS.md`: a "no regression" claim needs both comparison runs no worse than the comparison's worse run; a model or prompt change voids comparability.
 Every M0 round publishes one run per arm — these are one sample's numbers, not a variance floor; repeats are a separate round's job.
- No judge is involved (ADR-0007 §9): the dependent variable is the dataset's expert label, so these numbers are judge-drift-free by construction and are **not** comparable to M1's `balanced_score`.

## Run configuration

| field | value |
| --- | --- |
| round | `2026-10-26-m0-full-roadmap` |
| date | 2026-10-26T15:28:22.003Z → 2026-10-27T01:09:17.936Z |
| model (both arms) | `zai-coding-cn/glm-5.3:max` |
| CLI sha256 | `b7c1eb0f13f839bf9cc612df321b307c155d49ebe3428ae59d56bda40727164b` |
| build sha256 (dist digest) | `1a60f16e872ad9361ae340dfe5d89cf3b1906fa610917005e538a0f028bc97af` |
| dataset sha256 | `0804505f0a474765ce2840c832cfeaa6c4f0250dd6ccb169fe73c6758b245a86` |
| sample | limit 2134, seed 42, digest `95b5b358e545bda24afb29e596db953dd26c411e878a7f41296d8e1042a92cef` |
| arms | verifier, ocr |
| concurrency / timeout | 8 / 1200000 ms |
| materialization errors | 122 (excluded rows) |
| clone cache | `/home/miku/review-agents/.cache/pir-aacr` (16717 MiB) |
| config snapshot | model zai-coding-cn/glm-5.3:max, thinking low |

## Headline metrics

| arm | policy | n | label1/label0 | metrics |
| --- | --- | --- | --- | --- |
 | ocr | **uncertain=keep** | 2012 | 1410 / 602 | acc 69.9% | P 71.1% | R 96.3% | F1 81.8% | kill 8.1% | falseKill 3.7% | interceptP 48.5% | AUC 0.522 | 
 | ocr | uncertain=miss | 2012 | 1410 / 602 | acc 69.9% | P 71.1% | R 96.3% | F1 81.8% | kill 8.1% | falseKill 3.7% | interceptP 48.5% | AUC 0.522 | 
 | ocr | macro (bucket mean) | 2012 | 1410 / 602 | acc 71.1% | P 72.3% | R 96.3% | F1 82.5% | kill 8.3% | falseKill 3.7% | interceptP 49.7% | AUC — | 
 | ocr | errors / invalid / strict-unresolved | 0 / 0 / 0 |  | 
 | verifier | **uncertain=keep** | 2012 | 1410 / 602 | acc 44.5% | P 78.5% | R 28.7% | F1 42.1% | kill 81.6% | falseKill 71.3% | interceptP 32.8% | AUC 0.611 | 
 | verifier | uncertain=miss | 2012 | 1410 / 602 | acc 44.4% | P 78.5% | R 28.5% | F1 41.8% | kill 81.6% | falseKill 71.3% | interceptP 32.8% | AUC 0.611 | 
 | verifier | macro (bucket mean) | 2012 | 1410 / 602 | acc 44.9% | P 79.1% | R 29.9% | F1 42.7% | kill 80.8% | falseKill 70.1% | interceptP 31.7% | AUC — | 
 | verifier | errors / invalid / strict-unresolved | 0 / 0 / 4 |  | 

The macro row is the unweighted mean of each metric over every bucket cell below (the four dataset strata of ADR-0007 §6); the `n` and `label1/label0` beside it are the micro overall counts. A metric undefined in a bucket (for example `killRate` with no label-0 rows) is left out of the mean rather than counted as zero, and the `strict-unresolved` counter is read from the strict (uncertain = miss) bucket while `errors`/`invalid` stay policy-independent.

## Session usage

Tokens as reported by each run's CLI result, summed over the rows that reported usage. `total tokens` includes cache reads and the CLI result does not itemise them, so the three columns do not compose: read `output tokens` as the generated-token cost and `total tokens` as session volume, never as input + output. `output / row` is the cost side, read beside killRate and falseKillRate as one group and never instead of them. Rows without usage (errors, older builds) are excluded from the sums and stay visible in the `rows with usage` column.

| arm | rows with usage | input tokens | output tokens | total tokens | output / row | total / row |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
 | ocr | 2012 | 7,126,129 | 1,984,174 | 9,496,031 | 986 | 4,720 | 
 | verifier | 2012 | 29,632,398 | 13,554,226 | 237,731,968 | 6,737 | 118,157 | 

## ocr — per-bucket metrics

### uncertain = keep (primary)

**source_model**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | GPT-5.2 | 542 | 357 | 185 | 65.9% | 66.3% | 98.0% | 79.1% | 3.8% | 2.0% | 50.0% | 0.509 | 
 | human | 497 | 353 | 144 | 71.0% | 72.7% | 94.9% | 82.3% | 12.5% | 5.1% | 50.0% | 0.537 | 
 | Claude-Code/Claude-4.5-Sonnet | 264 | 180 | 84 | 70.5% | 70.7% | 96.7% | 81.7% | 14.3% | 3.3% | 66.7% | 0.555 | 
 | Qwen-Coder-480B | 245 | 157 | 88 | 62.4% | 63.9% | 94.9% | 76.4% | 4.5% | 5.1% | 33.3% | 0.497 | 
 | GLM-4.7 | 217 | 173 | 44 | 77.9% | 80.8% | 94.8% | 87.2% | 11.4% | 5.2% | 35.7% | 0.531 | 
 | Deepseek-V3.2 | 127 | 93 | 34 | 71.7% | 73.6% | 95.7% | 83.2% | 5.9% | 4.3% | 33.3% | 0.508 | 
 | Gemini-3-Pro | 120 | 97 | 23 | 81.7% | 81.5% | 100.0% | 89.8% | 4.3% | 0.0% | 100.0% | 0.522 | 

**category**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | Code Defect | 958 | 665 | 293 | 69.2% | 70.3% | 96.2% | 81.3% | 7.8% | 3.8% | 47.9% | 0.520 | 
 | Maintainability and Readability | 849 | 584 | 265 | 68.9% | 69.9% | 96.4% | 81.0% | 8.3% | 3.6% | 51.2% | 0.524 | 
 | Performance | 133 | 108 | 25 | 79.7% | 82.4% | 95.4% | 88.4% | 12.0% | 4.6% | 37.5% | 0.537 | 
 | Security Vulnerability | 72 | 53 | 19 | 73.6% | 74.3% | 98.1% | 84.6% | 5.3% | 1.9% | 50.0% | 0.517 | 

**context**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | Diff Level | 964 | 714 | 250 | 73.5% | 74.7% | 97.2% | 84.5% | 6.0% | 2.8% | 42.9% | 0.516 | 
 | File Level | 689 | 477 | 212 | 69.7% | 71.0% | 95.0% | 81.3% | 12.7% | 5.0% | 52.9% | 0.539 | 
 | Repo Level | 359 | 219 | 140 | 60.7% | 61.3% | 96.3% | 75.0% | 5.0% | 3.7% | 46.7% | 0.507 | 

**is_ai_comment**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | true | 1515 | 1057 | 458 | 69.6% | 70.6% | 96.8% | 81.6% | 6.8% | 3.2% | 47.7% | 0.518 | 
 | false | 497 | 353 | 144 | 71.0% | 72.7% | 94.9% | 82.3% | 12.5% | 5.1% | 50.0% | 0.537 | 

### uncertain = miss (strict)

**source_model**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | GPT-5.2 | 542 | 357 | 185 | 65.9% | 66.3% | 98.0% | 79.1% | 3.8% | 2.0% | 50.0% | 0.509 | 
 | human | 497 | 353 | 144 | 71.0% | 72.7% | 94.9% | 82.3% | 12.5% | 5.1% | 50.0% | 0.537 | 
 | Claude-Code/Claude-4.5-Sonnet | 264 | 180 | 84 | 70.5% | 70.7% | 96.7% | 81.7% | 14.3% | 3.3% | 66.7% | 0.555 | 
 | Qwen-Coder-480B | 245 | 157 | 88 | 62.4% | 63.9% | 94.9% | 76.4% | 4.5% | 5.1% | 33.3% | 0.497 | 
 | GLM-4.7 | 217 | 173 | 44 | 77.9% | 80.8% | 94.8% | 87.2% | 11.4% | 5.2% | 35.7% | 0.531 | 
 | Deepseek-V3.2 | 127 | 93 | 34 | 71.7% | 73.6% | 95.7% | 83.2% | 5.9% | 4.3% | 33.3% | 0.508 | 
 | Gemini-3-Pro | 120 | 97 | 23 | 81.7% | 81.5% | 100.0% | 89.8% | 4.3% | 0.0% | 100.0% | 0.522 | 

**category**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | Code Defect | 958 | 665 | 293 | 69.2% | 70.3% | 96.2% | 81.3% | 7.8% | 3.8% | 47.9% | 0.520 | 
 | Maintainability and Readability | 849 | 584 | 265 | 68.9% | 69.9% | 96.4% | 81.0% | 8.3% | 3.6% | 51.2% | 0.524 | 
 | Performance | 133 | 108 | 25 | 79.7% | 82.4% | 95.4% | 88.4% | 12.0% | 4.6% | 37.5% | 0.537 | 
 | Security Vulnerability | 72 | 53 | 19 | 73.6% | 74.3% | 98.1% | 84.6% | 5.3% | 1.9% | 50.0% | 0.517 | 

**context**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | Diff Level | 964 | 714 | 250 | 73.5% | 74.7% | 97.2% | 84.5% | 6.0% | 2.8% | 42.9% | 0.516 | 
 | File Level | 689 | 477 | 212 | 69.7% | 71.0% | 95.0% | 81.3% | 12.7% | 5.0% | 52.9% | 0.539 | 
 | Repo Level | 359 | 219 | 140 | 60.7% | 61.3% | 96.3% | 75.0% | 5.0% | 3.7% | 46.7% | 0.507 | 

**is_ai_comment**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | true | 1515 | 1057 | 458 | 69.6% | 70.6% | 96.8% | 81.6% | 6.8% | 3.2% | 47.7% | 0.518 | 
 | false | 497 | 353 | 144 | 71.0% | 72.7% | 94.9% | 82.3% | 12.5% | 5.1% | 50.0% | 0.537 | 

## verifier — per-bucket metrics

### uncertain = keep (primary)

**source_model**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | GPT-5.2 | 542 | 357 | 185 | 37.5% | 63.2% | 12.0% | 20.2% | 86.5% | 88.0% | 33.8% | 0.571 | 
 | human | 497 | 353 | 144 | 46.7% | 79.7% | 33.4% | 47.1% | 79.2% | 66.6% | 32.7% | 0.614 | 
 | Claude-Code/Claude-4.5-Sonnet | 264 | 180 | 84 | 51.5% | 81.7% | 37.2% | 51.1% | 82.1% | 62.8% | 37.9% | 0.673 | 
 | Qwen-Coder-480B | 245 | 157 | 88 | 44.5% | 71.4% | 22.3% | 34.0% | 84.1% | 77.7% | 37.8% | 0.562 | 
 | GLM-4.7 | 217 | 173 | 44 | 45.6% | 83.1% | 39.9% | 53.9% | 68.2% | 60.1% | 22.4% | 0.607 | 
 | Deepseek-V3.2 | 127 | 93 | 34 | 40.9% | 84.6% | 23.7% | 37.0% | 88.2% | 76.3% | 29.7% | 0.610 | 
 | Gemini-3-Pro | 120 | 97 | 23 | 54.2% | 85.0% | 52.6% | 65.0% | 60.9% | 47.4% | 23.3% | 0.615 | 

**category**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | Code Defect | 958 | 665 | 293 | 40.0% | 76.5% | 19.5% | 31.1% | 86.3% | 80.5% | 32.1% | 0.603 | 
 | Maintainability and Readability | 849 | 584 | 265 | 51.2% | 78.1% | 40.4% | 53.3% | 75.1% | 59.6% | 36.4% | 0.624 | 
 | Performance | 133 | 108 | 25 | 33.1% | 88.0% | 20.4% | 33.1% | 88.0% | 79.6% | 20.4% | 0.608 | 
 | Security Vulnerability | 72 | 53 | 19 | 47.2% | 89.5% | 32.1% | 47.2% | 89.5% | 67.9% | 32.1% | 0.681 | 

**context**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | Diff Level | 964 | 714 | 250 | 42.9% | 83.6% | 28.6% | 42.6% | 84.0% | 71.4% | 29.2% | 0.638 | 
 | File Level | 689 | 477 | 212 | 46.0% | 77.5% | 31.0% | 44.3% | 79.7% | 69.0% | 33.9% | 0.602 | 
 | Repo Level | 359 | 219 | 140 | 46.0% | 65.4% | 24.2% | 35.3% | 80.0% | 75.8% | 40.3% | 0.562 | 

**is_ai_comment**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | true | 1515 | 1057 | 458 | 43.8% | 78.0% | 27.2% | 40.3% | 82.3% | 72.8% | 32.9% | 0.610 | 
 | false | 497 | 353 | 144 | 46.7% | 79.7% | 33.4% | 47.1% | 79.2% | 66.6% | 32.7% | 0.614 | 

### uncertain = miss (strict)

**source_model**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | GPT-5.2 | 542 | 357 | 185 | 37.5% | 63.2% | 12.0% | 20.2% | 86.5% | 88.0% | 33.8% | 0.571 | 
 | human | 497 | 353 | 144 | 46.3% | 79.5% | 32.9% | 46.5% | 79.2% | 66.6% | 32.7% | 0.614 | 
 | Claude-Code/Claude-4.5-Sonnet | 264 | 180 | 84 | 51.1% | 81.5% | 36.7% | 50.6% | 82.1% | 62.8% | 37.9% | 0.673 | 
 | Qwen-Coder-480B | 245 | 157 | 88 | 44.5% | 71.4% | 22.3% | 34.0% | 84.1% | 77.7% | 37.8% | 0.562 | 
 | GLM-4.7 | 217 | 173 | 44 | 45.6% | 84.1% | 39.9% | 54.1% | 68.2% | 60.1% | 22.4% | 0.607 | 
 | Deepseek-V3.2 | 127 | 93 | 34 | 40.9% | 84.6% | 23.7% | 37.0% | 88.2% | 76.3% | 29.7% | 0.610 | 
 | Gemini-3-Pro | 120 | 97 | 23 | 54.2% | 85.0% | 52.6% | 65.0% | 60.9% | 47.4% | 23.3% | 0.615 | 

**category**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | Code Defect | 958 | 665 | 293 | 39.7% | 76.0% | 19.1% | 30.5% | 86.3% | 80.5% | 32.1% | 0.603 | 
 | Maintainability and Readability | 849 | 584 | 265 | 51.2% | 78.4% | 40.4% | 53.3% | 75.1% | 59.6% | 36.4% | 0.624 | 
 | Performance | 133 | 108 | 25 | 33.1% | 88.0% | 20.4% | 33.1% | 88.0% | 79.6% | 20.4% | 0.608 | 
 | Security Vulnerability | 72 | 53 | 19 | 47.2% | 89.5% | 32.1% | 47.2% | 89.5% | 67.9% | 32.1% | 0.681 | 

**context**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | Diff Level | 964 | 714 | 250 | 42.8% | 83.5% | 28.4% | 42.4% | 84.0% | 71.4% | 29.2% | 0.638 | 
 | File Level | 689 | 477 | 212 | 45.7% | 77.2% | 30.6% | 43.8% | 79.7% | 69.0% | 33.9% | 0.602 | 
 | Repo Level | 359 | 219 | 140 | 46.0% | 66.3% | 24.2% | 35.5% | 80.0% | 75.8% | 40.3% | 0.562 | 

**is_ai_comment**

| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | true | 1515 | 1057 | 458 | 43.8% | 78.1% | 27.1% | 40.2% | 82.3% | 72.8% | 32.9% | 0.610 | 
 | false | 497 | 353 | 144 | 46.3% | 79.5% | 32.9% | 46.5% | 79.2% | 66.6% | 32.7% | 0.614 | 

### Rejection grounds (B4)

| ground | kills | label0 | label1 | false-kill share of ground |
| --- | --- | --- | --- | --- |
 | contradicted-by-code | 696 | 257 | 439 | 63.1% | 
 | speculative | 480 | 155 | 325 | 67.7% | 
 | pre-existing | 196 | 51 | 145 | 74.0% | 
 | guarded | 107 | 19 | 88 | 82.2% | 
 | no-such-code | 14 | 7 | 7 | 50.0% | 
 | not-introduced-by-change | 3 | 2 | 1 | 33.3% | 

A ground is the reason a rejected verdict named (ADR-0008). The distribution is over kills under both policies — a rejected verdict is a kill either way — so it reads as the audit trail of the arm's kill decisions. Rows without a ground pre-date B4 or belong to the OCR arm, which has no ground vocabulary; they are counted as `unknown` rather than dropped.

## Notes and limits

- Full corpus: 2,134 selected comment rows; 122 upstream materialization errors excluded; 2,012 usable comments scored per arm.
- Provider-rate handling: rows with no decision (status error, decision invalid, provider-error, missing-verdict) were removed and re-run on resume; the committed round contains zero provider-error rows.
- Review model and OCR comparison arm both use zai-coding-cn/glm-5.3:max; no judge is involved in M0.
- Caliber (roadmap R2): the pir arm is repository-aware (pinned reads, search, structural queries) while the OCR arm is diff-only, which is the OCR prompt's native material. A diff-only pir ablation is deliberately out of scope for M0.
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
