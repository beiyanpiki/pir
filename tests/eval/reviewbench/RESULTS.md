# ReviewBench results

Baseline + per-PR delta rows for the local ReviewBench benchmark
(test-25, vendored at the pinned SHA in `fixtures/REVIEWBENCH_SHA`).
Protocol: subset-10 is the iteration face; full test-25 only for baseline
and release-level claims; a "no regression" claim needs both comparison
runs no worse than the baseline's worse run. Judge drift invalidates
comparisons — every row records provider/model/SHA.

## Status

**Baseline recorded (2026-10-13/14, round `baseline-dev-dsv41`).** 2× full
test-25 on dev (`50/50` runs OK, zero errors, zero truncations), pir
`opencode-go/deepseek-v4.1-flash:max`, judge `opencode-go/deepseek-v4-pro`
at RB `aec7b37`. **The baseline era is open**: behavior PRs append delta
rows here, and a "no regression" claim requires both comparison runs no
worse than the baseline's worse run — **GP ≥ 91.0%, GR ≥ 16.6%,
AP ≥ 95.2%, AR ≥ 24.3%** (macro, the worse of run1/run2 per metric).
Per-PR rows for slices merged before the baseline (Q1–M1) remain
**waived** (not isolable after the fact); their gate was the scenario
harness. Recording history and the protocol revision are in the round's
Notes below; the full trail (capped attempt → zero findings, discarded;
4-way concurrency → OOM-killed, discarded; key rotation; `--resume`
reuse of 19 completed runs) is in tracking issue #73.

**F1 subset-10 A/B: waived by maintainer decision (2026-10-14).** The
A/B round (`f1-angles-ab-dsv41`) was interrupted by the provider's weekly
usage limit after 4 of 40 runs; rather than wait out the quota, the
maintainer waived the A/B — F1 stays default-off and experimental, and a
future A/B against the recorded variance floor (GP≥91.0 GR≥16.6 AP≥95.2
AR≥24.3) is the entry condition for promoting it. The 4 completed runs
and the round harness remain in place for that future recording.

**Judge environment deviations (recorded, both inherited by all later
rows).** The pinned judge checkout (RB `aec7b37` + its own `npm ci`) ships
pi-coding-agent 0.74.2, which (a) does not send the `x-opencode-session`
routing header the current opencode-go endpoint requires — every judge
model call failed 400 and the matcher saw empty responses — and (b) has a
model catalog that predates `deepseek-v4.1-flash`. Two adaptations, both
outside the judge's prompt/parse/scoring code (which is pristine): a
process-level `fetch` preload injects a stable `x-opencode-session` id for
`opencode.ai` requests, and the judge model is `deepseek-v4-pro` — the
strongest model the pinned catalog resolves. Judge model drift between
rows remains invalidating; these two adaptations are part of the
baseline's judge identity.

## Round registry

| Round | Date | Subset | Variants | Repeats | pir model | Judge (provider / model / RB SHA) | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline-dev-dsv41 | 2026-10-13/14 | full test-25 ×2 | candidate-run1 / candidate-run2 | 2 | opencode-go/deepseek-v4.1-flash:max | opencode-go / deepseek-v4-pro / aec7b37 (+session-header fetch preload) | **run1** macro GP=95.0% GR=16.6% AP=97.2% AR=24.3% (micro 95.8/16.8/97.6/24.5; 84 candidates vs 352 golden TPs; 36 novel TPs) · **run2** macro GP=91.0% GR=21.5% AP=95.2% AR=28.7% (micro 93.8/21.0/96.0/28.4; 101 candidates; 36 novel TPs) | Revised protocol: `PIR_EVAL_MAX_TOKENS=unlimited` (the 400k-capped attempt truncated every run to zero findings and was **discarded**), `PIR_EVAL_TASK_CONCURRENCY=2` (the 4-way attempt was OOM-killed and **discarded**), no wall-clock per-run limit. 19 runs reused via `--resume` after two mid-round restarts (session interrupt, provider usage-limit key rotation). All runs after the observability change carry transcripts + stderr logs (`.cache/runs`, `.cache/logs`) and are mirrored into the local state DB for the web explorer. Round cost ≈ 378M pir tokens + judge tokens; per-run cost in `summary.json`. |
| harness-smoke | 2026-10-09 | 3 tasks (`--only`: k1LoW_gh-copilot-review_9, ardevd_jadx-collaboration_3, PierreJanineh_TechDebtMCP_135) | candidate-run1 | 1 | opencode-go/deepseek-v4.1-flash:max | opencode-go / deepseek-v4.1-flash / aec7b37 | grounded P=— R=0%, augmented P=— R=0% (0 reported findings vs 25 golden TPs) | B1 harness smoke — proves the pipeline (materialize → review → normalize → prefilter → judge), **not a baseline**. Per task: 484s/1.73M tok, 328s/0.41M tok, 446s/1.34M tok (`summary.json`). All three tasks came back clean under this model/limits — a data point about the model, not the harness. |

Row conventions:

- **Result**: grounded precision/recall from the judge scores, plus
  augmented numbers and per-task wall-clock/token cost from `summary.json`;
  link or reference the `tests/eval/rb-out/<round>/` dir (untracked).
- **Notes**: subset used (which `--limit`/`--only`), errors (tasks that
  became error rows), and the variance-rule comparison for delta rows.
