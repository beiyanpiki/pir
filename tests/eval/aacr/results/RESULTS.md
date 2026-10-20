# AACR-Bench results — baseline, change protocol and north-star dashboard (M2)

> **Dataset:** [Alibaba-Aone/aacr-bench](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench) `dataset.json` revision `47be1d6df1e7faf222cf531587772d92f79fe6b2`, sha256 `0804505f0a474765ce2840c832cfeaa6c4f0250dd6ccb169fe73c6758b245a86` (2,145 records), Apache-2.0. **M1 fixture:** upstream `positive_samples.json` sha256 `02c8561f1c3994a26f427d479b2a3f6e6c8e6858161fbc903b45248fa2cb2097` (196 PRs, 1,506 comments), pinned in [meta.json](../meta.json). **Framework:** [alibaba/aacr-bench](https://github.com/alibaba/aacr-bench) @ `ee9d7fef70ef31acea2ff7ae316ce0a9575fe4df` (Apache-2.0), used as judging delegation. Use of AACR-Bench data requires citing **arXiv 2601.19494**; the bibtex is in `meta.json` and repeated in every generated file header.
>
> This file is the numbers surface: the locked baseline, the M2 change protocol, the round registry and the north-star dashboard. Decisions and their reasons live in [ADR-0007](../../../docs/adr/0007-aacr-verifier-offline-benchmark.md) (M0), [ADR-0009](../../../docs/adr/0009-m1-end-to-end-benchmark.md) (M1 + the M2 protocol amendment in §11) and ADR-0011–0013 (the data-triggered decision points).

## At a glance — what is locked, what is open

| surface | population | fixed comparison sample | external caliber | status |
| --- | --- | --- | --- | --- |
| M0 verifier | 2,134 head-anchorable comments (of 2,145) | `--limit 100 --seed 42`, digest `74f43e2f25442f0e62f97a9b960ae46de6f05eebfe5173298e16c9838aafc07d` | killRate / falseKillRate (labels, no judge) | **baseline locked** (2026-10-19, full-corpus numbers are the reference; the 100-comment sample is the before/after face) |
| M1 end-to-end | 196 PRs | `--limit 50 --seed 42`, digest `754ae13a0c0fd523ddbf3a9e98d321de6e23ea30fc5332b871714194401ddb8c` | `balanced_score` (upstream judge) | **baseline locked** (2026-10-20, round `2026-10-20-m1-baseline-glm`: 49/50 instances evaluated, judge `glm-5.3`, 3 rounds averaged per view; scores below) |

The M1 baseline is the locked 50-PR subset, and its one missing instance is an upstream data loss (a force-pushed head), not a review outcome: it stays in the server's `missing_instances` and out of every denominator. The earlier parked convenience sample (57/196, one un-averaged judge round) remains Appendix A — a cost reference, never a score.

## The change protocol (M2 T2)

A behavioural change is compared **before vs after on one fixed population**, with every provenance pin identical across the two sides. What counts as a behaviour change:

- **Verifier-stage changes** (verifier prompt, `submit_verdict` contract, rejection grounds, evidence gate) run the **M0** comparison: one fixed 100-comment sample, no judge (the dataset label is the dependent variable), killRate/falseKillRate read together (roadmap R9).
- **End-to-end changes** (`pir find` reviewer prompt, filter gate, location correction, budget, rule file, orchestration) run the **M1** comparison: one fixed 50-PR subset, upstream judge, `balanced_score` per view.
- **Decision points and tooling changes** (ADR 0011–0013 outcomes, evaluation scripts, docs) are not behavioural and need no comparison.

The fixed populations are defined only by `(seed, limit)` over the pinned fixture, so a reader can always rebuild them:

- M0: `materialize.js --limit 100 --seed 42` → sample digest `74f43e2f…c07d`; the full-corpus round used `--limit 2134 --seed 42` → digest `95b5b358…2a92cef`.
- M1: `run-aacr.js --limit 50 --seed 42` → **instance-set digest `754ae13a0c0fd523ddbf3a9e98d321de6e23ea30fc5332b871714194401ddb8c`** (50 PRs, 29 repositories, 333 reference comments; PR sizes p50 176 / p90 498 / max 776 lines). The driver records `limits.seed` and `fixture.instanceSetDigest`; `--resume`/`--judge-only` refuse or replay a different selection. The full 196-PR corpus is for baseline and release-level claims only (`--limit 196` selects everything; the published baseline is the 50-PR subset until a full run exists).

**One round, one provenance.** A round records model id, CLI sha256, fixture sha256, instance-set digest, view set, repeats, seed, judge model, judge round count, judge framework commit and judge timeout; `--resume` refuses to mix the model/build/fixture/subset/view/repeat pins and a real-judge round's judge identity (model, round count, framework commit), and refuses to downgrade a real-judge round to mock/off. The judge timeout is recorded, not compared. A judge-model or judge-framework change makes the numbers incomparable and forces a rerun — never a footnote.

**Variance rules, copied verbatim from [`tests/eval/reviewbench/RESULTS.md`](../../reviewbench/RESULTS.md):** "a 'no regression' claim needs both comparison runs no worse than the baseline's worse run. Judge drift invalidates comparisons — every row records provider/model/SHA." M0's round file states the same rule as "a 'no regression' claim needs both comparison runs no worse than the comparison's worse run; a model or prompt change voids comparability." One run per side is a **point comparison**, and must be labelled as one; it is not a variance floor.

**Procedure (exact commands).**

1. Check out the pre-change commit and build it; keep both `dist/cli/cli.js` paths (the driver takes `--cli`). The build is a provenance pin: record both CLI sha256 values.
2. M0 side: materialize the fixed sample **once** (`PIR_EVAL=1 node tests/eval/aacr/materialize.js --limit 100 --seed 42`) and reuse that one `dataset/materialized.jsonl` for both sides, so the sample cannot drift between them. Then `PIR_EVAL=1 node tests/eval/aacr/run-m0.js --round <date>-<change>-before --cli <before-cli> --model zai-coding-cn/glm-5.3:max --concurrency 4` and the same with the after build into `…-after`; the round's `sample` field comes from the materialized header, not from new flags. Render `node tests/eval/aacr/report.js --run out/…-after --baseline out/…-before --out results/M0-…-comparison.md`.
3. M1 side: `PIR_EVAL=1 node tests/eval/aacr/m1/run-aacr.js --round <date>-<change>-before --cli <before-cli> --limit 50 --seed 42 --model zai-coding-cn/glm-5.3:max --view both --judge real --eval-rounds 3` with the pinned `JUDGE_*` environment, then the after round identically; render both with `m1/report-m1.js`. The judge must be the same pinned model, framework commit and round count on both sides.
4. Append one row per comparison to the registry below: round ids, dates, model, both CLI shas, population digest, judge pins, before/after headline metrics, the variance statement (both runs vs the worse run, or "point comparison") and the disposition.
5. Judge drift, fixture drift, population drift or a model swap → discard the comparison and rerun; never patch a row.

**Cost.** The parked sample suggests ≈2.1M session tokens (mean; 1.32M median) and ≈18 minutes of reviewer wall time per PR at concurrency 1 (Appendix A). A 50-PR M1 side is therefore roughly a 50-review run plus 1–3 judge rounds — a manual, paid check, never a CI gate (ADR-0003 §4). Judge cost is separate and grows with `--eval-rounds`.

## Baseline lock-in (M2 T1)

### M0 baseline (locked)

Round `2026-10-19-m0-full-glm` (2026-10-19T15:14:21Z → 2026-10-20T00:05:10Z), model `zai-coding-cn/glm-5.3:max`, CLI sha256 `2a6ce185…e9d`, dataset sha256 `0804505f…a86`, sample `limit 2134 --seed 42` digest `95b5b358…cef`, 122 materialization error rows excluded, concurrency 5 (bulk at 8), timeout 20 min. Verifier arm, **uncertain = keep** policy, n = 2,012 (1,410 label-1 / 602 label-0):

| metric | verifier | OCR arm |
| --- | ---: | ---: |
| killRate (north star) | **82.7%** | 8.0% |
| falseKillRate | **72.0%** | 3.0% |
| interceptPrecision | **32.9%** | 52.7% |
| accuracy / precision / recall / F1 | 44.3% / 79.1% / 27.9% / 41.3% | 70.3% / 71.1% / 96.9% / 82.0% |
| AUC | 0.611 | 0.525 |

Full file: [`M0-2026-10-19-full.md`](M0-2026-10-19-full.md). The 100-comment comparison face is [`M0-2026-10-19-limit100.md`](M0-2026-10-19-limit100.md) (digest `74f43e2f…c07d`); [`M0-2026-10-19-b4-before-after.md`](M0-2026-10-19-b4-before-after.md) is the first controlled comparison entered under this protocol.

### M1 baseline (locked 2026-10-20)

Round `2026-10-20-m1-baseline-glm` ran the locked 50-PR subset (2026-10-20T10:35:24Z → 2026-10-20T15:35:52Z, reviewer side plus judging) on model `zai-coding-cn/glm-5.3:max`, CLI sha256 `8d7de831…`, fixture sha256 `d35d1e42…`, instance-set digest `754ae13a0c0fd523ddbf3a9e98d321de6e23ea30fc5332b871714194401ddb8c` — exactly the subset locked by M2 T1. The reviewer side completed **49 of 50 instances** with 102 findings, 129,917,141 session tokens (6,844,426 input / 2,875,211 output) and 16.0 h summed reviewer duration (mean 19.5 min, median 17.7 min per instance at concurrency 6). The single miss is `comfyanonymous__ComfyUI@4936d01`, a force-pushed upstream head that no longer fetches: it is an error row in the driver and lands in the server's `missing_instances`, outside every denominator, never scored as an empty review.

The reviewer pass first ran at the 30-minute task cap and timed out on seven large instances; the documented retry pass (`--resume --timeout 7200000`) completed all seven, which is why the round records the retry's 120-minute cap. Judging used the pinned upstream framework (`ee9d7fe`), judge model `glm-5.3` and `--eval-rounds 3` averaged per view:

| metric | reported (uncertain = keep) | confirmedOnly (strict) |
| --- | ---: | ---: |
| instances evaluated / missing | 49 / 1 | 49 / 1 |
| reference comments expected | 328 | 328 |
| generated comments | 102 | 102 |
| file-semantic precision | 32.1% | 31.7% |
| recall | 11.2% | 11.1% |
| **balanced_score** | **0.1663** | **0.1647** |

Full file: [`M1-2026-10-20-baseline-glm.md`](M1-2026-10-20-baseline-glm.md) — headline, buckets by language / PR size / reference-comment category, coverage ledger, cost and provenance. The two views coincide within one point because every finding this round reported was confirmed: the uncertain=keep margin was zero here, reported rather than averaged away.

The M2 T1 decision that produced this population is recorded in ADR-0009 §11: the seeded 50-PR subset, not the full 196 PRs and not the parked convenience sample. Reasons: the full judge-backed corpus is roughly four times the cost and parked; a paired subset cancels its bias in a delta; and the subset is reproducible from `(seed, limit)` and pinned by the instance-set digest. The full corpus remains the publishable external caliber when it exists — the subset is the locked internal baseline.

What is **explicitly not this baseline**: the parked round `2026-10-20-m1-full-glm` (57 instances, first-completed convenience subset, no `finishedAt`, one judge round without the required average, judge recorded as failed — Appendix A), the `--limit 20` smoke (mock judge, plumbing only), and any M0 number used as an M1 score (different caliber).

## North-star dashboard (M2 T4)

| metric | surface | value | source | status |
| --- | --- | ---: | --- | --- |
| `balanced_score` (primary external caliber) | M1 | **0.1663** reported / 0.1647 confirmedOnly | `2026-10-20-m1-baseline-glm` | **locked** |
| `killRate` | M0 | **82.7%** | `2026-10-19-m0-full-glm` | locked |
| `falseKillRate` (cost side) | M0 | **72.0%** | same | locked |
| `interceptPrecision` | M0 | **32.9%** | same | locked |
| per-PR token cost (mean) | M1 | **2,651,370** total tokens (139,682 input / 58,678 output) | `2026-10-20-m1-baseline-glm` | locked |
| per-PR token cost (median) | M1 | 1,748,438 total tokens | same | locked |
| per-PR reviewer wall time | M1 | 19.5 min mean / 17.7 min median (concurrency 6) | same | locked |

Read the M0 row with all three numbers together (roadmap R9): a killRate that rises by rejecting more comments is not automatically an improvement, and a falseKillRate that falls by keeping more comments is not automatically safe. Total tokens include cache reads; the input/output columns are the composition. The dashboard is updated only by a round that satisfies the change protocol — never by a partial or mock-judge round.

## Round registry

| round | date | surface | population | repeats | model | judge | result | notes |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| `2026-10-19-m0` | 2026-10-19 | M0 | limit 100, seed 42, digest `74f43e2f…` | 1 | `opencode-go/deepseek-v4.1-flash:medium` | — | sample face | [file](M0-2026-10-19-limit100.md); materialization errors 5 |
| `2026-10-19-b4-before` / `-after` | 2026-10-19 | M0 | limit 100, seed 42 | 1 | `opencode-go/deepseek-v4.1-flash:medium` | — | **first protocol comparison** (point) | [file](M0-2026-10-19-b4-before-after.md); builds `b6214403` → `64734461`; ADR-0008 |
| `2026-10-19-m0-full-glm` | 2026-10-19/20 | M0 | limit 2134, seed 42 | 1 | `zai-coding-cn/glm-5.3:max` | — | **M0 baseline locked** | [file](M0-2026-10-19-full.md); 122 unfetchable rows excluded |
| `2026-10-19-m1-smoke-glm` | 2026-10-19 | M1 | limit 20 (fixture order) | 1 | `zai-coding-cn/glm-5.3:max` | mock (upstream local similarity) | plumbing only, no score | 20/20 rows, 33 reported / 32 confirmed findings; ADR-0009 smoke note |
| `2026-10-20-m1-full-glm` | 2026-10-20 | M1 | all 196 | 1 | `zai-coding-cn/glm-5.3:max` | real `glm-5.3`, round 1 of 3 only | **parked; NOT a baseline** | 57/196 rows, 4 error rows (3 unfetchable heads + 1 judge failure); no `finishedAt`; Appendix A |
| `2026-10-20-m1-baseline-glm` | 2026-10-20 | M1 | limit 50, seed 42, digest `754ae13a…` | 1 | `zai-coding-cn/glm-5.3:max` | real `glm-5.3`, 3 rounds averaged per view | **M1 baseline locked** | [file](M1-2026-10-20-baseline-glm.md); 49/50 evaluated (1 unfetchable head); 102 findings; reviewer pass retried at a 120-min cap |

## First controlled comparison under the protocol (M2 A1)

[`M0-2026-10-19-b4-before-after.md`](M0-2026-10-19-b4-before-after.md) is entered here as the first comparison governed by this protocol. It pre-dates this file but conforms on every parameter except the variance floor, which it honestly labels as a point comparison:

- **Population:** M0 fixed 100-comment sample, `--limit 100 --seed 42`, digest `74f43e2f…c07d`; dataset sha256 `0804505f…a86`.
- **Sides:** pre-change CLI build `b6214403`, post-change build `64734461` (B4 rejection grounds, ADR-0008); model `opencode-go/deepseek-v4.1-flash:medium` on both sides; no judge (labels).
- **Result:** falseKillRate 77.1% → 78.6% (+1.4 pp), killRate 80.0% → 80.0% (±0.0 pp), interceptPrecision 27.0% → 26.7% (−0.4 pp); one label-1 comment swapped sides at this sample's one-comment resolution.
- **Disposition:** B4 merged with the gate recorded as not proven either way and no evidence of a systematic increase (ADR-0008); the comparison is a point comparison, not a variance floor.

The first **M1** comparison is the next registry row: it runs on this baseline's fixed 50-PR subset after the first behavioural change lands, and its row will carry the subset digest, both CLI shas, both judge pins and the before/after `balanced_score` per view.

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
- The 50-PR subset's absolute `balanced_score` as an external, leaderboard-style claim: it is the locked internal baseline; use deltas for change claims and wait for a full-corpus run before quoting it as the external caliber.

## Appendix A — parked sample per-PR reference (57/196, not a baseline)

Round `2026-10-20-m1-full-glm` (reviewer side), model `zai-coding-cn/glm-5.3:max`, CLI sha256 `2a6ce185…e9d`, fixture sha256 `d35d1e42…`. 57 completed instances (of the planned 196), 105 reported/confirmed findings, 121,068,158 total session tokens (7,405,927 input / 2,874,903 output), 17.2 h summed reviewer duration at concurrency 1. Three heads are unfetchable (force-pushed): `comfyanonymous__ComfyUI@4936d01`, `comfyanonymous__ComfyUI@cfc3122`, `nodejs__node@b225544`; the fourth error row is the stopped judge. The round files live outside git in the paused worktree; the numbers below are a cost/density reference, never a score.

| PR | repo | lines | reported findings | tokens (total) | in / out | duration |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| microsoft__typescript-go@b970689 | microsoft/typescript-go | 933 | 1 | 11,070,563 | 361,571 / 86,144 | 32m 28s |
| FreeCAD__FreeCAD@a050e42 | FreeCAD/FreeCAD | 862 | 0 | 9,029,931 | 262,848 / 70,699 | 34m 20s |
| opencv__opencv@79afad9 | opencv/opencv | 307 | 5 | 8,403,922 | 360,493 / 132,773 | 42m 47s |
| FreeCAD__FreeCAD@870d7f5 | FreeCAD/FreeCAD | 776 | 7 | 7,308,772 | 441,117 / 113,991 | 39m 12s |
| lvgl__lvgl@e526b2a | lvgl/lvgl | 804 | 6 | 7,129,265 | 334,437 / 94,540 | 32m 40s |
| libsdl-org__SDL@96dfef3 | libsdl-org/SDL | 161 | 4 | 5,464,214 | 359,828 / 120,002 | 39m 43s |
| comfyanonymous__ComfyUI@4dcd698 | comfyanonymous/ComfyUI | 971 | 9 | 4,864,450 | 300,991 / 139,011 | 49m 34s |
| FreeCAD__FreeCAD@eb761fd | FreeCAD/FreeCAD | 672 | 2 | 4,801,182 | 265,637 / 92,857 | 38m 56s |
| PowerShell__PowerShell@ec952ce | PowerShell/PowerShell | 23 | 1 | 3,883,683 | 158,075 / 64,104 | 27m 14s |
| gofr-dev__gofr@2c0c099 | gofr-dev/gofr | 348 | 4 | 3,668,954 | 181,864 / 74,546 | 23m 18s |
| CherryHQ__cherry-studio@5644b00 | CherryHQ/cherry-studio | 687 | 7 | 3,292,356 | 273,491 / 102,769 | 32m 48s |
| gofr-dev__gofr@49ab394 | gofr-dev/gofr | 554 | 1 | 2,963,860 | 173,757 / 66,967 | 29m 38s |
| lvgl__lvgl@4a57db3 | lvgl/lvgl | 29 | 0 | 2,920,023 | 109,774 / 57,353 | 18m 44s |
| nodejs__node@e8b6c18 | nodejs/node | 169 | 1 | 2,492,850 | 129,355 / 71,911 | 29m 56s |
| microsoft__typescript-go@100dbc5 | microsoft/typescript-go | 829 | 0 | 2,453,140 | 164,943 / 54,725 | 18m 14s |
| libsdl-org__SDL@1526727 | libsdl-org/SDL | 48 | 1 | 2,446,333 | 160,413 / 83,104 | 34m 13s |
| PowerShell__PowerShell@ea07b93 | PowerShell/PowerShell | 44 | 1 | 1,849,462 | 100,025 / 45,181 | 19m 32s |
| browser-use__browser-use@0b21e50 | browser-use/browser-use | 133 | 3 | 1,826,371 | 156,712 / 76,379 | 24m 11s |
| FreeCAD__FreeCAD@a440ff7 | FreeCAD/FreeCAD | 297 | 1 | 1,764,112 | 133,983 / 36,913 | 10m 54s |
| mrdoob__three.js@b55b9e9 | mrdoob/three.js | 210 | 4 | 1,702,088 | 150,623 / 72,489 | 29m 6s |
| CherryHQ__cherry-studio@83a2594 | CherryHQ/cherry-studio | 345 | 5 | 1,593,919 | 183,581 / 78,178 | 25m 28s |
| electron__electron@2cc5656 | electron/electron | 82 | 1 | 1,522,193 | 92,254 / 49,203 | 18m 51s |
| cline__cline@f098af0 | cline/cline | 165 | 3 | 1,510,090 | 110,774 / 42,900 | 13m 42s |
| gofr-dev__gofr@5e284ae | gofr-dev/gofr | 356 | 1 | 1,507,841 | 104,192 / 42,433 | 14m 27s |
| browser-use__browser-use@aab7b3b | browser-use/browser-use | 95 | 4 | 1,423,905 | 122,724 / 62,653 | 24m 6s |
| microsoft__typescript-go@1a84d8d | microsoft/typescript-go | 92 | 0 | 1,410,802 | 75,283 / 39,263 | 13m 42s |
| lvgl__lvgl@a0067e3 | lvgl/lvgl | 109 | 1 | 1,407,838 | 107,719 / 50,071 | 16m 1s |
| cline__cline@419534c | cline/cline | 33 | 4 | 1,400,974 | 128,808 / 52,134 | 17m 12s |
| mrdoob__three.js@7388f60 | mrdoob/three.js | 151 | 3 | 1,322,499 | 118,898 / 56,657 | 23m 14s |
| browser-use__browser-use@72f1585 | browser-use/browser-use | 324 | 2 | 1,222,034 | 82,608 / 26,722 | 10m 50s |
| microsoft__typescript-go@ae447d3 | microsoft/typescript-go | 176 | 1 | 1,094,691 | 118,617 / 23,370 | 10m 37s |
| gofr-dev__gofr@c1a26ad | gofr-dev/gofr | 217 | 1 | 1,032,705 | 75,946 / 36,311 | 15m 22s |
| FreeCAD__FreeCAD@39c5968 | FreeCAD/FreeCAD | 306 | 0 | 923,323 | 88,565 / 20,358 | 7m 5s |
| microsoft__typescript-go@892b4a3 | microsoft/typescript-go | 80 | 3 | 917,338 | 102,790 / 45,460 | 14m 1s |
| gofr-dev__gofr@dc0b3e6 | gofr-dev/gofr | 309 | 4 | 905,401 | 131,136 / 63,801 | 19m 39s |
| alibaba__spring-ai-alibaba@4bc7305 | alibaba/spring-ai-alibaba | 118 | 2 | 904,586 | 104,883 / 47,575 | 17m 16s |
| electron__electron@6084595 | electron/electron | 64 | 0 | 886,476 | 61,929 / 41,891 | 14m 24s |
| lvgl__lvgl@9cce37c | lvgl/lvgl | 67 | 0 | 879,767 | 51,635 / 19,620 | 7m 19s |
| nextcloud__server@51b5ea9 | nextcloud/server | 165 | 1 | 837,907 | 93,692 / 35,031 | 10m 39s |
| opencv__opencv@e546382 | opencv/opencv | 48 | 0 | 823,275 | 40,995 / 15,944 | 6m 9s |
| alibaba__spring-ai-alibaba@3555a95 | alibaba/spring-ai-alibaba | 140 | 1 | 776,427 | 63,481 / 25,778 | 9m 51s |
| electron__electron@c486457 | electron/electron | 190 | 0 | 772,208 | 67,045 / 35,915 | 10m 26s |
| FreeCAD__FreeCAD@290bdc7 | FreeCAD/FreeCAD | 98 | 0 | 767,280 | 41,967 / 14,593 | 5m 24s |
| cline__cline@d0a8db8 | cline/cline | 179 | 1 | 705,430 | 59,541 / 22,465 | 8m 5s |
| comfyanonymous__ComfyUI@b55c224 | comfyanonymous/ComfyUI | 15 | 1 | 631,503 | 48,979 / 22,908 | 6m 58s |
| FreeCAD__FreeCAD@82fef4a | FreeCAD/FreeCAD | 41 | 0 | 618,884 | 41,944 / 30,700 | 10m 15s |
| comfyanonymous__ComfyUI@0bb6023 | comfyanonymous/ComfyUI | 30 | 1 | 598,276 | 79,538 / 44,306 | 13m 51s |
| mrdoob__three.js@96ab072 | mrdoob/three.js | 61 | 1 | 551,057 | 80,314 / 33,175 | 10m 45s |
| FreeCAD__FreeCAD@f8cd643 | FreeCAD/FreeCAD | 85 | 0 | 527,651 | 41,090 / 14,625 | 5m 18s |
| gofr-dev__gofr@b9cdcbb | gofr-dev/gofr | 215 | 3 | 487,713 | 69,988 / 32,189 | 10m 3s |
| microsoft__typescript-go@45c0de9 | microsoft/typescript-go | 47 | 1 | 484,609 | 41,192 / 11,097 | 3m 57s |
| FreeCAD__FreeCAD@ec3da2e | FreeCAD/FreeCAD | 80 | 2 | 421,476 | 62,578 / 31,410 | 8m 56s |
| FreeCAD__FreeCAD@699b45c | FreeCAD/FreeCAD | 56 | 0 | 334,802 | 38,537 / 20,041 | 6m 54s |
| electron__electron@100ad24 | electron/electron | 6 | 0 | 288,704 | 49,427 / 15,853 | 5m 54s |
| laravel__framework@0a5238a | laravel/framework | 4 | 0 | 94,454 | 12,318 / 6,296 | 2m 33s |
| opencv__opencv@e3e45c8 | opencv/opencv | 11 | 0 | 77,708 | 23,603 / 5,081 | 1m 57s |
| valkey-io__valkey@866fa4a | valkey-io/valkey | 30 | 0 | 66,881 | 7,419 / 2,438 | 60s |
