# ReviewBench local benchmark

Extends the synthetic scenario harness in `../` with real-world measurement:
25 real PRs with human-labeled golden findings from
[ReviewBench](https://github.com/review-bench/ReviewBench), run locally
against frozen repo mirrors and judged with the upstream judge CLI. Local
evaluation only (ADR 0003 §4): no leaderboard submission, no docker agent
contract, no portal onboarding.

This surface **extends** `tests/eval/` — same opt-in gate, isolation
conventions, and baseline/candidate pairing semantics; it does not replace
the synthetic harness (that stays the cheap regression gate).

## Layout

```
tests/eval/reviewbench/
  run-rb.js     task runner: materialize → run pir → normalize → prefilter
  normalize.js  CLI --json envelope → judging-input JSON (pure)
  prefilter.js  deterministic advisory golden × pir matcher (pure)
  judge.js      bench:judge delegation to the pinned upstream judge
  fixtures/
    REVIEWBENCH_SHA      pinned upstream commit (data + judge share it)
    test-set.json        vendored test-25 task manifest
    golden/*.json        vendored golden findings, stems = pr keys
    LICENSE-attribution.md
  RESULTS.md    baseline + per-PR delta rows (tracked)
```

`tests/eval/rb-out/` (round outputs) and `.cache/` (mirror object caches,
worktrees, per-task run sandboxes, judge clone) are gitignored.

## Opt-in gate

Same contract as the scenario runner: without `PIR_EVAL=1`, `run-rb.js` and
`judge.js` exit 0 with a parseable skip notice, with no network, model, or
database access; importing their modules has no side effects; `--help` is
model-free.

## Running a round

```sh
npm run build   # the runner drives dist/cli/cli.js

# iterate on a subset (the protocol's default iteration face)
PIR_EVAL=1 node tests/eval/reviewbench/run-rb.js \
  --round my-experiment --limit 10 --model 'zai-coding-cn/glm-5.3:max'

# specific tasks (smoke tests, debugging one PR)
PIR_EVAL=1 node tests/eval/reviewbench/run-rb.js \
  --round smoke --only PierreJanineh_TechDebtMCP_135-16a54f0f --only <pr_key>…

# A/B comparison, alternating order, repeated (same semantics as run-eval.js)
PIR_EVAL=1 node tests/eval/reviewbench/run-rb.js \
  --round ab --baseline-cli dist/cli/cli.js --candidate-cli <other>/dist/cli/cli.js --repeats 2
```

Each task: fetch base+head from the frozen mirror only when missing
(`--filter=blob:none`, mirror → upstream → `pull/<n>/head` fallback), check
out head as a detached worktree, run pir with the scenario runner's env
isolation and a **fresh memory DB per task** (cold memory, deliberately:
the benchmark measures the review engine, not accumulated decisions), and
normalize the outcome. Failed or timed-out tasks (default 30 min,
`--task-timeout`) become error rows and the run continues.

### Output layout

```
tests/eval/rb-out/<round>/
  <variant>-run<k>/<pr_key>.json            judging input (reported = confirmed+uncertain)
  <variant>-run<k>-confirmed-only/…         stricter precision view (separate dir:
                                            the judge merges same-PR files in one dir)
  <variant>-run<k>.PREFILTER.md             advisory prefilter (outside judge inputs)
  summary.json                              per-task rows: status, wall-clock, tokens
```

## Prefilter

`prefilter.js` scores golden × pir pairs per task with the token-Jaccard
`claimSimilarity` (from `src/findings/identity.ts`) plus a 0.2 bonus when
anchor paths intersect; pairs ≥ 0.5 are probable matches. PREFILTER.md gives
crude recall/precision bounds and unmatched lists on both sides. Advisory
only — official numbers always come from the judge.

## Judging

```sh
PIR_EVAL=1 RB_JUDGE_PROVIDER=<provider> RB_JUDGE_MODEL=<model> \
  npm run bench:judge -- --candidate <abs path to rb-out/<round>/<variant>-run<k>>
```

`judge.js` clones `review-bench/ReviewBench` at the SHA pinned in
`fixtures/REVIEWBENCH_SHA` into `.cache/reviewbench/`, runs `npm ci` there
once (marker-file guarded), and forwards to the upstream judge CLI with the
vendored manifest and golden files. Credentials pass through the provider's
documented env vars. Scores land beside the candidate dir as
`<variant>-run<k>.scores.json` (never inside it — the judge's directory
loader would reject the foreign file).

## Protocol

- **Subset-10 is the iteration face** for behavior-change PRs; the full
  test-25 is reserved for the baseline and release-level claims.
- **Baseline**: after this harness lands, record 2× full test-25 runs on
  current dev. Every behavior PR afterwards appends a delta row to
  `RESULTS.md`.
- **Variance rule**: a "no regression" claim requires *both* comparison runs
  to be no worse than the baseline's *worse* run.
- **Judge drift invalidates comparisons**: every RESULTS.md row records the
  judge provider/model and the pinned ReviewBench SHA alongside the numbers.

## Vendoring & attribution

Fixtures are extracted from ReviewBench (MIT, © GitHub, Inc.) at the pinned
SHA — see `fixtures/LICENSE-attribution.md`. Re-vendoring at a newer SHA is
an explicit PR that updates `REVIEWBENCH_SHA` together with the derived
files.
