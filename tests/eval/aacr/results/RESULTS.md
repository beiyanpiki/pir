# AACR-Bench results — full-corpus baseline, change protocol and north-star dashboard (M2)

> **Dataset:** [Alibaba-Aone/aacr-bench](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench) `dataset.json` revision `47be1d6df1e7faf222cf531587772d92f79fe6b2`, sha256 `0804505f0a474765ce2840c832cfeaa6c4f0250dd6ccb169fe73c6758b245a86` (2,145 records), Apache-2.0. **M1 fixture:** upstream `positive_samples.json` sha256 `02c8561f1c3994a26f427d479b2a3f6e6c8e6858161fbc903b45248fa2cb2097` (196 PRs, 1,506 comments), pinned in [meta.json](../meta.json). **Framework:** [alibaba/aacr-bench](https://github.com/alibaba/aacr-bench) @ `ee9d7fef70ef31acea2ff7ae316ce0a9575fe4df` (Apache-2.0), used as judging delegation. Use of AACR-Bench data requires citing **arXiv 2601.19494**; the bibtex is in `meta.json` and repeated in every generated file header.
>
> **The 2026-10-26 full-corpus re-run is the baseline.** It supersedes every earlier M0/M1 baseline row: the old 100-comment M0 sample and the 50-PR M1 subset documents were removed, while the B4 and S1 controlled comparisons remain as historical sample-face results. Decisions live in [ADR-0007](../../../docs/adr/0007-aacr-verifier-offline-benchmark.md) (M0), [ADR-0009](../../../docs/adr/0009-m1-end-to-end-benchmark.md) (M1; Decision 12 records the full-corpus baseline) and ADR-0011–0013 (data-triggered decision points).

## At a glance — what is locked, what is open

| surface | population | fixed comparison sample | external caliber | status |
| --- | --- | --- | --- | --- |
| M0 verifier | 2,134 head-anchorable comments → **2,012 usable** (122 materialization errors excluded) | full corpus, digest `95b5b358…2a92cef`; the retired 100-comment face was `74f43e2f…c07d` | killRate / falseKillRate (labels, no judge) | **baseline locked 2026-10-26** |
| M1 end-to-end | 196 PRs → **185 evaluated**, 11 force-push missing | full corpus, instance-set digest `84191263…`; the retired 50-PR face was `754ae13a…` | `balanced_score` (upstream judge, 3 rounds averaged per view) | **baseline locked 2026-10-26** |

The M1 baseline is the full 196-PR corpus. The 11 missing instances are upstream data loss (force-pushed or deleted heads), not review outcomes: they stay in the server's `missing_instances` and out of every denominator. The one incomplete row (`ollama__ollama@0b52f18`) is a real review that stopped on its own; it is judged normally.

## The change protocol (M2 T2)

A behavioural change is compared **before vs after on one fixed population**, with every provenance pin identical across the two sides. The **full-corpus baseline is the external caliber**; the 100-comment M0 sample and the 50-PR M1 subset remain available as cheap internal change-comparison faces.

What counts as a behaviour change:

- **Verifier-stage changes** (verifier prompt, `submit_verdict` contract, rejection grounds, evidence gate) run the **M0** comparison: one fixed 100-comment sample for a cheap point comparison, no judge (the dataset label is the dependent variable), killRate/falseKillRate read together (roadmap R9). A release-level claim is stated against the full-corpus baseline.
- **End-to-end changes** (`pir find` reviewer prompt, filter gate, location correction, budget, rule file, orchestration) run the **M1** comparison: one fixed 50-PR subset for a cheap point comparison, upstream judge, `balanced_score` per view. A release-level claim is stated against the full 196-PR baseline.
- **Decision points and tooling changes** (ADR 0011–0013 outcomes, evaluation scripts, docs) are not behavioural and need no comparison.

The fixed populations are defined only by `(seed, limit)` over the pinned fixture, so a reader can always rebuild them:

- M0: full baseline `materialize.js --limit 2134 --seed 42` → digest `95b5b358…2a92cef`; the retired 100-comment face was `--limit 100 --seed 42` → `74f43e2f…c07d`.
- M1: full baseline is `run-aacr.js --limit 196` (everything) → **instance-set digest `84191263b3ce4f7db884398b…`**; the retired 50-PR face was `--limit 50 --seed 42` → `754ae13a0c0fd523ddbf3a9e98d321de6e23ea30fc5332b871714194401ddb8c` (50 PRs, 29 repositories, 333 reference comments; PR sizes p50 176 / p90 498 / max 776 lines). The driver records `limits.seed` and `fixture.instanceSetDigest`; `--resume`/`--judge-only` refuse or replay a different selection.

**One round, one provenance.** A round records model id, CLI sha256, fixture sha256, instance-set digest, view set, repeats, seed, judge model, judge round count, judge framework commit and judge timeout; `--resume` refuses to mix the model/build/fixture/subset/view/repeat pins and a real-judge round's judge identity (model, round count, framework commit), and refuses to downgrade a real-judge round to mock/off. The judge timeout is recorded, not compared. A judge-model or judge-framework change makes the numbers incomparable and forces a rerun — never a footnote.

**Variance rules, copied verbatim from [`tests/eval/reviewbench/RESULTS.md`](../../reviewbench/RESULTS.md):** "a 'no regression' claim needs both comparison runs no worse than the baseline's worse run. Judge drift invalidates comparisons — every row records provider/model/SHA." M0's round file states the same rule as "a 'no regression' claim needs both comparison runs no worse than the comparison's worse run; a model or prompt change voids comparability." One run per side is a **point comparison**, and must be labelled as one; it is not a variance floor.

**Procedure (exact commands).**

1. Check out the pre-change commit and build it; keep both `dist/cli/cli.js` paths (the driver takes `--cli`). The build is a provenance pin: record both CLI sha256 values.
2. M0 side: materialize the fixed sample **once** (`PIR_EVAL=1 node tests/eval/aacr/materialize.js --limit 100 --seed 42`) and reuse that one `dataset/materialized.jsonl` for both sides, so the sample cannot drift between them. Then `PIR_EVAL=1 node tests/eval/aacr/run-m0.js --round <date>-<change>-before --cli <before-cli> --model zai-coding-cn/glm-5.3:max --concurrency 4` and the same with the after build into `…-after`; the round's `sample` field comes from the materialized header, not from new flags. Render `node tests/eval/aacr/report.js --run out/…-after --baseline out/…-before --out results/M0-…-comparison.md`.
3. M1 side: `PIR_EVAL=1 node tests/eval/aacr/m1/run-aacr.js --round <date>-<change>-before --cli <before-cli> --limit 50 --seed 42 --model zai-coding-cn/glm-5.3:max --view both --judge real --eval-rounds 3` with the pinned `JUDGE_*` environment, then the after round identically; render both with `m1/report-m1.js`. The judge must be the same pinned model, framework commit and round count on both sides.
4. Append one row per comparison to the registry below: round ids, dates, model, both CLI shas, population digest, judge pins, before/after headline metrics, the variance statement (both runs vs the worse run, or "point comparison") and the disposition.
5. Judge drift, fixture drift, population drift or a model swap → discard the comparison and rerun; never patch a row.

**Cost.** The full-corpus baseline cost 491,874,862 M1 session tokens (2,658,783 per produced row) and 60.34 h of reviewer wall time at concurrency 6; M0 cost 237,731,968 verifier tokens plus 9,496,031 OCR tokens. A 50-PR M1 side is roughly a 50-review run plus 1–3 judge rounds — a manual, paid check, never a CI gate (ADR-0003 §4). Judge cost is separate and grows with `--eval-rounds`.

## Baseline lock-in (M2 T1)

### M0 baseline (locked 2026-10-26)

Round `2026-10-26-m0-full-roadmap` (2026-10-26T15:28:22Z → 2026-10-27T01:09:17Z), model `zai-coding-cn/glm-5.3:max`, CLI sha256 `b7c1eb0f…64b`, build sha256 `1a60f16e…97af`, dataset sha256 `0804505f…a86`, sample `limit 2134 --seed 42` digest `95b5b358…cef`, 122 materialization error rows excluded, concurrency 8, timeout 20 min. Verifier arm, **uncertain = keep** policy, n = 2,012 (1,410 label-1 / 602 label-0):

| metric | verifier | OCR arm |
| --- | ---: | ---: |
| killRate (north star) | **81.6%** | 8.1% |
| falseKillRate | **71.3%** | 3.7% |
| interceptPrecision | **32.8%** | 48.5% |
| accuracy / precision / recall / F1 | 44.5% / 78.5% / 28.7% / 42.1% | 69.9% / 71.1% / 96.3% / 81.8% |
| AUC | 0.611 | 0.522 |
| session tokens (total / output) | 237,731,968 / 13,554,226 | 9,496,031 / 1,984,174 |

Full file: [`M0-2026-10-26-full-roadmap.md`](M0-2026-10-26-full-roadmap.md). [`M0-2026-10-19-b4-before-after.md`](M0-2026-10-19-b4-before-after.md) is the first controlled comparison entered under this protocol (100-comment face, historical); the S1 field-order rounds remain historical too. One fixture row with an inverted `to_line` was clamped to its `from_line` in the task builder, so it stays in the 2,012 denominator (comment text and scoring untouched).

### M1 baseline (locked 2026-10-26)

Round `2026-10-26-m1-full-roadmap` ran **all 196 PRs** (2026-10-25T17:48:14Z → 2026-10-26T15:28:18Z, reviewer side plus judging) on model `zai-coding-cn/glm-5.3:max`, CLI sha256 `b7c1eb0f…64b`, fixture sha256 `d35d1e42…`, instance-set digest `84191263b3ce4f7db884398b…`. The reviewer side completed **185 of 196 instances** with 345 reported / 340 confirmed findings, 491,874,862 session tokens and 60.34 h summed reviewer duration (mean 19.6 min per produced row at concurrency 6). The 11 misses are force-pushed or deleted upstream heads that no longer fetch; they are error rows in the driver and land in the server's `missing_instances`, outside every denominator, never scored as empty reviews.

Judging used the pinned upstream framework (`ee9d7fe`), judge model `glm-5.3` and `--eval-rounds 3` averaged per view:

| metric | reported (uncertain = keep) | confirmedOnly (strict) |
| --- | ---: | ---: |
| instances evaluated / missing | 185 / 11 | 185 / 11 |
| reference comments expected | 1,419 | 1,419 |
| generated comments | 345 | 340 |
| file-semantic precision | 36.2% | 35.7% |
| recall | 10.0% | 9.7% |
| **balanced_score** | **0.1560** | **0.1523** |

Full file: [`M1-2026-10-26-full-roadmap.md`](M1-2026-10-26-full-roadmap.md) — headline, buckets by language / PR size / reference-comment category, coverage ledger, cost and provenance. The two views differ by 0.4 points: most reported findings were confirmed; the gap is reported rather than averaged away.

The full corpus replaced the 50-PR subset as the baseline because the user requested a complete fresh re-test and the corpus is now fully judged. The 50-PR subset remains the cheap internal change-comparison face; it is no longer the locked baseline.

### Harness deviations (recorded, scoring untouched)

- **M0 fixture normalization:** a few upstream comments carry an inverted line range (`to_line < from_line`); `run-m0.js` clamps `to_line` to `from_line` when writing the verifier task. The comment text, buckets and scoring are unchanged, and the row stays in the 2,012 denominator.
- **Judge error propagation:** the local judge clone raises on persistent provider 429/quota errors instead of swallowing them as no-match, so a quota-hit round fails visibly and is retried rather than scored as zero.
- **Judge semaphore lifecycle:** the module-level `asyncio.Semaphore` is recreated when the running event loop changes; upstream `pipeline.py` calls `asyncio.run` per evaluation round, so the pristine semaphore is bound to round 1's closed loop and round 2 raises "bound to a different event loop". The patch fixes only that lifecycle bug.

The judge framework pin (`ee9d7fe`), judge model (`glm-5.3`), 3-round averaging, prompts and scoring code are unchanged; the patches are environment/lifecycle fixes only.

## North-star dashboard (M2 T4)

| metric | surface | value | source | status |
| --- | --- | ---: | --- | --- |
| `balanced_score` (primary external caliber) | M1 | **0.1560** reported / 0.1523 confirmedOnly | `2026-10-26-m1-full-roadmap` | **locked** |
| `killRate` | M0 | **81.6%** | `2026-10-26-m0-full-roadmap` | locked |
| `falseKillRate` (cost side) | M0 | **71.3%** | same | locked |
| `interceptPrecision` | M0 | **32.8%** | same | locked |
| per-PR token cost (mean) | M1 | **2,658,783** total tokens | `2026-10-26-m1-full-roadmap` | locked |
| per-PR reviewer wall time | M1 | 1,174 s mean (concurrency 6) | same | locked |

Read the M0 row with all three numbers together (roadmap R9): a killRate that rises by rejecting more comments is not automatically an improvement, and a falseKillRate that falls by keeping more comments is not automatically safe. Total tokens include cache reads. The dashboard is updated only by a round that satisfies the change protocol — never by a partial or mock-judge round.

## Round registry

| round | date | surface | population | repeats | model | judge | result | notes |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| `2026-10-19-b4-before` / `-after` | 2026-10-19 | M0 | limit 100, seed 42 | 1 | `opencode-go/deepseek-v4.1-flash:medium` | — | **first protocol comparison** (point) | [file](M0-2026-10-19-b4-before-after.md); builds `b6214403` → `64734461`; ADR-0008; historical sample face |
| `2026-10-22-s1-order-before-r1/-r2` / `-after-r1/-r2` | 2026-10-22 | M0 | limit 100, seed 42, digest `74f43e2f…` | **2 per side** | `zai-coding-cn/glm-5.3:max` | — | field-order point comparison; **not adopted** | [r1](M0-2026-10-22-s1-field-order-r1.md) / [r2](M0-2026-10-22-s1-field-order-r2.md); builds `47e77911` → `09fb3ae9`; ADR 0015; historical sample face |
| `2026-10-19-m1-smoke-glm` | 2026-10-19 | M1 | limit 20 (fixture order) | 1 | `zai-coding-cn/glm-5.3:max` | mock (upstream local similarity) | plumbing only, no score | 20/20 rows, 33 reported / 32 confirmed findings; ADR-0009 smoke note |
| `2026-10-26-m0-full-roadmap` | 2026-10-26/27 | M0 | limit 2134, seed 42, digest `95b5b358…` | 1 | `zai-coding-cn/glm-5.3:max` | — | **M0 baseline locked** | [file](M0-2026-10-26-full-roadmap.md); 2,012/2,012 both arms; 122 materialization rows excluded; one inverted-range row normalized |
| `2026-10-26-m1-full-roadmap` | 2026-10-25/26 | M1 | all 196, digest `84191263…` | 1 | `zai-coding-cn/glm-5.3:max` | real `glm-5.3`, 3 rounds averaged per view | **M1 baseline locked** | [file](M1-2026-10-26-full-roadmap.md); 185/196 evaluated (11 force-pushed heads); 345 findings |

## First controlled comparison under the protocol (M2 A1)

[`M0-2026-10-19-b4-before-after.md`](M0-2026-10-19-b4-before-after.md) is entered here as the first comparison governed by this protocol. It predates the full-corpus baseline but conforms on every parameter except the variance floor, which it honestly labels as a point comparison:

- **Population:** M0 fixed 100-comment sample, `--limit 100 --seed 42`, digest `74f43e2f…c07d`; dataset sha256 `0804505f…a86`.
- **Sides:** pre-change CLI build `b6214403`, post-change build `64734461` (B4 rejection grounds, ADR-0008); model `opencode-go/deepseek-v4.1-flash:medium` on both sides; no judge (labels).
- **Result:** falseKillRate 77.1% → 78.6% (+1.4 pp), killRate 80.0% → 80.0% (±0.0 pp), interceptPrecision 27.0% → 26.7% (−0.4 pp); one label-1 comment swapped sides at this sample's one-comment resolution.
- **Disposition:** B4 merged with the gate recorded as not proven either way and no evidence of a systematic increase (ADR-0008); the comparison is a point comparison, not a variance floor.

The S1 field-order comparison (`2026-10-22-s1-order-before-r1/-r2` against `…-after-r1/-r2`) is the first entry with **two repeats per side**. It ran the fixed 100-comment sample four times — one build per field order, two rounds per build, same model, same materialized file — and is recorded as two point comparisons, not a variance floor ([r1](M0-2026-10-22-s1-field-order-r1.md) / [r2](M0-2026-10-22-s1-field-order-r2.md); [ADR 0015](../../../../docs/adr/0015-tool-schema-field-order-diagnostic.md)). The result was a no-adoption: `falseKillRate` moved +2.9 pp in repeat 1 and −2.9 pp in repeat 2 (two label-1 comments either way), while the unchanged builds' repeat pairs flipped 9–10 of 95 decisions — so the between-build deltas are inside the same-build noise, and the production field order was left alone.

The first **M1** comparison under the full baseline is the next registry row: it runs on the fixed 50-PR subset (cheap) or all 196 PRs (release claim), and its row carries the subset digest, both CLI shas, both judge pins and the before/after `balanced_score` per view.

## Smoke (M2 T3)

The `--limit 20` smoke is a **manual or nightly paid check, never a regular CI gate** (ADR-0003 §4 cost stance). It proves the pipeline end to end — clone cache, checkout, `pir find`, normalization, judge wiring — at the cost of 20 model runs:

```sh
npm run build:cli && PIR_EVAL=1 node tests/eval/aacr/m1/run-aacr.js \
  --round "$(date +%F)-m1-smoke" --limit 20 --concurrency 4 \
  --model zai-coding-cn/glm-5.3:max --view both --judge mock
```

Use `--judge mock` for the smoke (zero judge cost; its `balanced_score` is a lexical placeholder and never a result). `--judge real` with the pinned `JUDGE_*` environment is for a comparison round, not the smoke. A smoke failure is data: the previous smoke found that exit 3 with a valid envelope is an incomplete row, not an error (ADR-0009). `npm test` stays model-free and does not run this command.

## What is not comparable

- M0 killRate and M1 `balanced_score` — different populations, metrics and material; never substitute one for the other.
- A mock-judge score, a partial round, a convenience sample, or a round without `finishedAt` — none of these is a result.
- Any row whose model, CLI build, fixture sha256, instance-set digest, view set, repeats, judge model or judge framework commit differs from the other side.
- The retired 100-comment M0 sample and 50-PR M1 subset absolute numbers: they are historical change-comparison faces, not the baseline; the full-corpus numbers are the external caliber.
- A full-corpus number from a different CLI build or judge environment: the 2026-10-26 baseline is pinned by CLI sha256 `b7c1eb0f…`, dataset/fixture pins above and judge framework `ee9d7fe`.
