# ADR 0007: AACR benchmarks and verifier calibration

## Status

**Accepted (2026-10-19; the end-to-end benchmark amended 2026-10-20 and 2026-10-26; the field-order experiment closed
2026-10-22; consolidated 2026-10-27).** The series' measurement work, all
delivered in PR #146:

| Part | Decision | Source | Outcome |
| --- | --- | --- | --- |
| I | Verifier offline benchmark | ADR 0007 | accepted; the measurement surface that gates the rejection-grounds change |
| II | End-to-end benchmark | ADR 0009 | accepted; full corpus is the published baseline |
| III | Tool-schema field order | ADR 0015 | diagnosed, measured, not adopted |

Source numbers are the retired per-decision ADRs; the [consolidation
map](README.md) records the mapping. Part I keeps the verifier benchmark's decision numbers, so
historical results files that cite "ADR-0007 §N" mean Part I decision N.
Part II keeps the end-to-end benchmark's numbers under its own heading; Part III keeps the field-order
experiment's.

## Part I — Verifier offline benchmark

### Context

The end-to-end benchmark measures the whole `pir find` loop, but change-mode precision is decided
in exactly one place: the per-candidate verifier. A find-level score cannot
isolate it. The HF dataset `Alibaba-Aone/aacr-bench` is comment-level ground
truth: 2,145 real review comments (1,505 correct / 640 incorrect,
expert-verified) over 200 PRs in 50 repositories, each with `path`, `side`,
`from_line`/`to_line`, `note`, `category`, `context`,
`is_ai_comment` and `source_model`. Its official question — "evaluate the
extent to which a model can intercept low-quality review comments" — is what
`runVerifier` answers with confirmed / rejected / uncertain.

The comparison arm is OCR's comment reflection (surveyed at `8eb8334`,
Apache-2.0): one independent LLM call per round that may only delete comments
the diff **proves** wrong, on two exhaustive grounds (the described code is
absent from the diff; one diff line literally contradicts the claim), with a
protected-subject veto applied before correctness is judged. Its asymmetry —
"Removing a correct comment silently destroys a real finding" — is the cost
model pir's verifier already encodes ("Reviewer assertions are hypotheses,
not facts"). The verifier benchmark makes the two comparable on identical material instead of
comparing two published, differently-measured systems.

The dataset is Apache-2.0; use requires citing arXiv 2601.19494. ADR-0003's
local-only stance applies: developer machine, never CI, never a leaderboard.

### Decision

1. **`pir _verify-comment` is internal and eval-only.** Underscore prefix,
   absent from help/skills/docs, in `LOCAL_ONLY`, and refused unless
   `PIR_EVAL=1`. It is outside the stable stdout/exit-code contract and may
   change or disappear; promotion is a separate decision after the verifier benchmark. It takes
   one task file (`--task-file`), one checkout (`--cwd`), one model, and
   prints a pure JSON envelope.
2. **Fixed comment → `CandidateFinding` mapping**, no model involvement and
   no `record_candidate`: title = first sentence of `note`; claim = full
   `note`; trigger = empty; category = deterministic dataset mapping (Code
   Defect → correctness, Maintainability and Readability → maintainability,
   Performance → performance, Security Vulnerability → security, unknown →
   other); severity = P2 (not what the verifier benchmark measures); anchor = `{path,
   startLine: from_line, endLine: to_line}`; evidence = one `diff` entry
   with the driver-supplied per-comment excerpt (overlapping hunks, else
   leading hunks, size-capped). Identity uses production `buildIdentity`.
3. **The verifier arm runs production `runVerifier`** inside a
   driver-supplied `ToolContext`: `repoRoot` = the dataset head checkout,
   `changeSet` = a synthetic set from the merge-base..head diff narrowed to
   the comment's path, cold memory, no prior decisions. Every production
   guarantee applies, so the measured object is shipped code.
4. **Scoring policy: uncertain = keep is primary.** Keeping is the `label=1`
   side, so `confirmed` and `uncertain` both count as keeps and only
   `rejected` kills. This matches the verifier's bias and OCR's "when your
   evidence falls short of proof, approve". A **strict** variant is always
   reported beside it: `uncertain` earns no credit either way.
5. **Kill-rate is the north star, with its cost side named.** `killRate` =
   rejected(label=0)/label=0 (higher is better). `falseKillRate` =
   rejected(label=1)/label=1 (lower is better). `interceptPrecision` =
   rejected(label=0)/all rejected. All three are read together. The
   rejection-grounds acceptance text uses "kill-rate" for what this protocol calls
   `falseKillRate`; its gate is therefore `falseKillRate` must not regress
   while the other two are read jointly. Results files carry all three per
   bucket.
6. **Buckets are the dataset's strata**, each with sample size and metrics:
   `source_model`, `category`, `context`, `is_ai_comment`. Headlines are
   macro-averaged where meaningful; micro counts sit next to them.
7. **Materialization: shared, resumable, out-of-tree cache; depth-1 fetches;
   reconstructed diff base.** Per repository: `git init` + `git fetch
   --depth 1 origin <sha>` (a ClickHouse depth-1 fetch measured ~70 MB / ~7
   s). `diffBase` is the merge base GitHub's compare API reports for the
   dataset's two commits, also fetched at depth 1: the dataset's
   `pr_source_commit`/`pr_target_commit` are a *capture-time* pair, and a
   naive two-SHA diff folds base-branch drift in reverse (FreeCAD PR 19411:
   366 commits). The per-comment diff is `git diff -U3 <diffBase> <head> --
   <path>`, exactly the PR hunk GitHub rendered. Every failure becomes an
   error row; the run never aborts. Cache lives under `$PIR_AACR_CACHE`
   (default `~/.cache/pir-aacr`), never in the worktree; generated JSONL and
   checkout scratch are gitignored and rebuildable.
8. **The OCR reflection prompt is ported verbatim as the second arm, with
   attribution.** `src/agents/ocr-reflection-prompt.ts` carries the upstream
   Apache-2.0 notice and revision; `--arm ocr` serves it with no tools and no
   repository access, the file diff as `<review_files>`, the comment as the
   review comment. Both arms run the same sample, model id and scoring code,
   so the rows share one caliber. The notice is repeated in the results
   header.
9. **Judge delegation: the verifier benchmark needs none; the end-to-end benchmark delegates.** The verifier benchmark's dependent variable
   is a supplied binary label, so a judge would add drift, cost and an
   unaccountable layer. The end-to-end benchmark's findings are judged by the pinned upstream
   `judge.py`/`evaluate.py`, never a home-grown judge, so pir's numbers land
   on the published caliber.
10. **Cost and citation obligations.** The surface stays behind
    `PIR_EVAL=1`, never runs a model in `npm test`, records model id,
    thinking level, CLI sha256, dataset sha256 and per-task token/wall-clock
    cost in the manifest, and states its sample limit in every results file.
    Committed artifacts carry the arXiv 2601.19494 BibTeX; downloaded data and
    run outputs carry it in the JSONL header and results header. Dataset and
    framework are Apache-2.0 and unredistributed: only the pin (URL + sha256)
    is committed.
11. **Caliber is stated, not assumed.** The pir arm is a repository-aware
    verifier that may read any pinned revision; the OCR arm is a diff-only
    reflection call. The verifier benchmark measures each with its designed tool access. A
    diff-only pir ablation, or a repository-aware OCR extension, is out of
    scope and recorded as an end-to-end-benchmark open question.

### Consequences

- The verifier benchmark produces the first verifier-level numbers on real comments, attributable
  to the verifier alone; the rejection-grounds change gets a quantitative gate (`falseKillRate`)
  instead of an argument. The population is comment-level,
  single-expert-labelled and mostly AI-authored; per-bucket
  `is_ai_comment`/`source_model` rows guard against extrapolating to human
  taste. Results are not comparable to the end-to-end benchmark's `balanced_score`.
- Iteration 1 ships `--limit 100` sampled numbers; the full corpus plus
  repeats is Iteration 2. The results file states limit, seed, model and the
  zero-error subset; a partial run is published as partial, never
  extrapolated. Materialization writes tens of gigabytes at full scale; the
  script reports cache usage, is resumable per row, and never treats a fetch
  failure as fatal.
- The internal command's blast radius is bounded by `PIR_EVAL=1`,
  `LOCAL_ONLY` and absence from help/skills/docs. The alternative — an
  untracked script re-implementing the verifier — was rejected because it
  would measure a copy, not the product.
- The OCR prompt is now a vendored Apache-2.0 artifact; upstream changes must
  be re-ported deliberately with the pinned revision bumped in the same
  commit. If the host, compare API or commits change, the benchmark degrades
  to error rows and an explicitly partial report; `meta.json`'s sha256 pin
  fails acquisition loudly.
- **Measured limitation (first `--limit 100` run, 2026-10-19): the dataset's
  label and `runVerifier`'s question are not the same question.** Label 1
  means "this comment is correct review feedback"; the verifier answers "does
  a concrete, change-attributable defect exist here". Valid comments are
  rejected as "a stylistic refactoring preference with no concrete failure",
  "pre-existing, not introduced", or "subjective wording" — all required by
  the shipped do-not-report contract. `falseKillRate` still counts
  rejected(label=1)/label=1, but must **not** be read as "the verifier
  destroys real findings" nor compared with OCR's false-kill as the same
  question. The comparable signals are `killRate` and the per-category view
  (Maintainability concentrates the mismatch). A later iteration should
  separate "not a defect" from "defect not attributable" (audit-mode
  `runVerifier` is the candidate) and report both rows.
- **Two provenance guards (dogfood F-185/F-187).** `--resume` refuses to mix
  a different model id or CLI build into a round already on disk. The sampler
  excludes the 11 `side: "left"` comments (0.5%): their lines refer to the
  deleted old file, which the head-anchored mapping cannot express, so they
  are counted out (`sample.sideExcluded`) rather than mis-mapped;
  `validateRecords` rejects unknown sides and `parseTask` refuses a non-right
  task loudly.

## Part II — End-to-end benchmark

### Context

The verifier benchmark measures the verifier in isolation. The end-to-end benchmark asks: **what does the shipped
`pir find` loop find on a real PR end to end, and how does that compare with
published systems?** The only external caliber is the upstream AACR-Bench
framework: its file-level semantic precision/recall and `balanced_score` are
what the published OCR / Claude Code / Codex rows report. A home-grown judge
would add drift and comparison risk.

**Population.** `dataset/positive_samples.json` (pinned at upstream
`ee9d7fe`) is the **label=1** split: 196 PRs, 1,506 expert-reviewed correct
comments (1,498 right-side / 8 left-side), 50 repositories, 10 languages. It
has no label-0 comments, so the end-to-end benchmark measures recall of known-correct feedback,
precision of reported findings (an unmatched generated comment lowers it) and
`balanced_score` — not interception or kill-rate.

**Framework.** The pinned `evaluation/` pipeline converts a benchmark to
JSONL (`schema.py`), runs a reviewer into
`results/<benchmark>/<reviewer>/<run_id>/<safe_id>.json`, then evaluates with
`evaluate.py` + `judge.py`. For an unknown reviewer it falls back to the OCR
shape:

```json
{"review": {"comments": [{"content": "...", "path": "...",
                          "start_line": 1, "end_line": 2}]},
 "duration_seconds": 1.5, "token_usage": {"input_tokens": 1, "output_tokens": 1}}
```

Only non-empty `content` counts; missing files are reported in
`missing_instances` and excluded from denominators. `judge.py` groups by
normalized path and judges semantic coverage one-to-many; `side` and lines
contextualize the prompt but do not gate the match. `JUDGE_USE_MOCK=true`
(or a missing key) selects a local similarity judge; a real judge uses
`JUDGE_BASE_URL` / `JUDGE_API_KEY` / `JUDGE_MODEL`.

**The materialization problem.** Part I decision 7's depth-1 cache has the
two trees but no ancestry, so `git diff <base>...<head>` reports **"no merge
base"** and the review fails before a model is called (verified on a local
fixture). Decision 7 below exists because of that measurement.

### Decision

1. **Reference set = `positive_samples.json`, label=1 only.** The end-to-end benchmark reports
   semantic precision/recall/`balanced_score`, not the verifier benchmark's accuracy/kill-rate.
   The fixture keeps all 1,506 comments, including the 8 left-side ones: the
   upstream file-level judge matches by path and text, so a left-side
   reference stays evaluable even though `pir find` reports right-side anchors
   only.
2. **Fixture conversion mirrors upstream, and the body is not redistributed.**
   `tests/eval/aacr/fixtures/build-fixture.js` maps `repo`, `base_commit`,
   `head_commit`, `instance_id` (dots preserved), `comments[]` →
   `reference_comments[]` and an index-aligned `comment_meta[]`, plus
   PR-level `change_line_count`, `project_main_language`, `pr_category` for
   buckets. `meta.json` pins the raw file by URL, sha256, byte size, record
   and comment count; generated `test-set.json` and the download cache are
   gitignored. Only the builder, the pin and the citation are committed
   (Part I decision 10). A changed upstream file fails the pin before anything
   is written.
3. **One driver, rb-grade isolation, same-repo serial / cross-repo
   concurrent.** `tests/eval/aacr/m1/run-aacr.js` clones the ReviewBench
   runner: shared clone cache, detached worktree, redirected `HOME`/XDG,
   per-instance cold `PIR_MEMORY_DB`, ephemeral credentials,
   `PIR_NO_WIZARD=1`, `PIR_TRANSCRIPTS=0`, `PIR_MODE=local`, `PIR_EVAL=1`,
   `--local`, `--plugins none`, a 30-minute default timeout, and explicit
   `--max-tokens unlimited --max-findings unlimited` (otherwise the run
   measures the default token ceiling). One repository's instances run serially over the
   shared cache; different repositories run concurrently up to
   `--concurrency`. Every failure becomes an error row; a round never aborts.
   Exit 3 with a valid envelope is **not** a failure: it is an incomplete
   review kept as a normal row with `incomplete: true`, `stoppedBecause` and
   its result files; `summary.incompleteInstances` counts it and the console
   logs `INCOMPLETE`. Only exit 3 without a usable envelope (or another
   status, or a signal kill) is an error row. The CLI under test is
   `dist/cli/cli.js`, never an import of `dist`.
4. **Two views, both judged.** `normalize-aacr.js` produces `reported`
   (confirmed + uncertain) and `confirmedOnly` (confirmed). The reported view
   is the verifier benchmark's uncertain=keep calibration; confirmed-only is the strict arm. Each
   is written as upstream-shaped results and judged separately, so the
   calibration cost is visible. Findings without a usable anchor are dropped
   and counted (`dropped.anchorless`/`dropped.total`), never mapped to
   another file. Text is title + claim + trigger joined deterministically.
5. **Judging is delegated, never rebuilt.** `m1/judge.js` resolves the pinned
   upstream clone at `$PIR_AACR_JUDGE_DIR` (default
   `$PIR_AACR_CACHE/aacr-bench@<commit>`), fetches depth 1 when absent,
   verifies the exact commit (judge drift invalidates comparisons), writes
   rows as `evaluation/data/aacr_bench.jsonl`, copies per-view results into
   `evaluation/results/aacr_bench/<reviewer>/<run_id>/`, and runs
   `python3 -m pipeline run --stage eval`. Only generated, gitignored
   upstream directories are written; no tracked file is modified and no patch
   is carried. The CLI accepts only `ocr|claude|codex`, so the OCR-shaped
   files use `--reviewer ocr`; metrics paths and summary lines are relayed
   into our summary. This implements Part I decision 9 — no home-grown judge.
6. **`balanced_score` is the external caliber; missing is not zero.** The
   headline is upstream's `balanced_score` with precision and recall per
   view. Missing result files are counted in `missing_instances` and excluded
   from denominators, never scored as empty. A round with errors is published
   as partial with the error count. Buckets (language, category, PR size) come
   from fixture fields; bucket rows are descriptive, not causal.
7. **Materialization: shared depth-1 cache + GitHub merge base + synthetic
   head only when needed.** The driver reuses `ensureRepoCache`, fetches
   `target_commit` and the merge base at `--depth 1`, and checks out the
   head tree in a detached worktree. Merge-base resolution shares the verifier benchmark's
   `resolveMergeBase` / `cachedMergeBase` / `rememberMergeBase` and
   `merge-bases.json`; a failure is not cached and degrades to the dataset's
   `source_commit` base tip (`diffBaseKind: "base-tip"`). Because depth-1
   has no ancestry, the driver checks it and, only when absent, creates a
   content-addressed synthetic head commit with the head tree and the merge
   base as parent (fixed identity), passes it as `--head`, and records the
   dataset head plus `reviewHead`/`syntheticHead`. The reviewer sees the
   real tree and exactly the PR diff; the original sha remains the identity
   and the judge never sees shas. If a repository cannot be fetched at depth 1
   (or synthetic creation fails), the documented fallback is a blobless
   partial clone or a full-history fetch; the current skeleton records such
   instances as error rows rather than switching silently.
8. **Cost and variance.** `--limit 20` is a documented manual command
   (README and this ADR), never a CI gate (ADR-0003 §4). `--repeats`
   exists; the full comparison uses upstream's `--eval-rounds 3` averaging,
   and the smoke reports one judge round. One judge invocation must finish all
   three rounds: the 30-minute ceiling is overridable with
   `PIR_AACR_JUDGE_TIMEOUT_MS` and recorded as `limits.judgeTimeoutMs`. A
   missing `_average.json` is a judge failure, never a silent fallback to one
   round. Every row records token usage, duration, exit status,
   `incomplete`/`stoppedBecause`, degraded base and synthetic head; the
   model id, CLI sha256, fixture sha256 and instance-set digest are in
   `summary.json`. Sampling is not controlled locally; repeats expose
   variance, not determinism.
9. **Provenance and resume guards are extended.** `--resume` refuses a
   different model, CLI build, fixture sha256, view set or repeat count
   (the verifier benchmark's `assertResumeCompatible` plus the end-to-end-benchmark inputs). A round directory without
   `--resume` is a hard error; `finishedAt` is absent while running. Results
   are written incrementally, so an interrupted round keeps completed work and
   `summary.json` never claims a finished round.
10. **Scope boundaries.** The end-to-end benchmark does not modify upstream, does not re-run the full
    196 PRs in the skeleton, and does not change `src/`. Mock-judge mode is a
    pipeline check, not a publishable score; only a real-judge run with the
    exact judge model qualifies. the end-to-end-benchmark numbers are not comparable to the verifier benchmark's
    kill-rate.
11. **Change-protocol amendment (2026-10-20): baseline population.**
    The locked comparison population is the **fixed 50-PR subset** from
    `--limit 50 --seed 42` (digest
    `754ae13a0c0fd523ddbf3a9e98d321de6e23ea30fc5332b871714194401ddb8c`), not the convenience
    sample and not the full 196. The full corpus is reserved for publishable
    and release-level claims; the subset is the before/after face because it
    is four times cheaper and, being paired, its bias cancels in a delta. It is
    reproducible from `(seed, limit)`: the verifier benchmark's `mulberry32` PRNG and backwards
    Fisher-Yates order the rows, `--limit` applies afterwards,
    `limits.seed` and `fixture.instanceSetDigest` are recorded, and
    `--resume`/`--judge-only` refuse or replay a different selection. Verifier
    changes use the verifier benchmark's fixed 100-comment sample; end-to-end changes use the end-to-end benchmark. The
    rb variance rules are copied verbatim (both runs no worse than the worse
    of the comparison; judge drift forces a rerun); one run per side is a
    point comparison; the end-to-end benchmark stays manual and paid, with the smoke as its only
    pipeline gate. The operational record is
    [`RESULTS.md`](../../tests/eval/aacr/results/RESULTS.md).
12. **Full-corpus baseline (2026-10-26).** The full 196-PR corpus is the
    published the end-to-end-benchmark baseline. The 11 unfetchable force-pushed heads are upstream
    data loss and stay outside every denominator; the round is published as
    185/196 evaluated, never extrapolated. The verifier benchmark was re-run on the same build
    (`M0-2026-10-26-full-roadmap.md`). The 50-PR subset remains a cheaper
    face, but a subset comparison must re-baseline both sides on the current
    build. This does not change the judge pin, two-view reporting,
    missing-is-not-zero or the variance rules.

### Consequences

- The end-to-end benchmark measures the whole loop on the same material and judge as the published
  rows. The cost is inheriting the upstream judge: the commit pin is
  load-bearing, judge drift is a hard error, and re-judging fixed results is a
  separate recorded step.
- The positive-only population means precision can be lowered by legitimate
  findings no reference comment covers — the upstream metric's definition,
  not a pir penalty. Results must state it.
- The synthetic head is an identity substitution: tree, diff and paths are the
  dataset's. The CLI envelope's `--head` is therefore a synthetic sha; the
  row/summary pair keeps both and the judge is unaffected. If a future release
  can consume a pre-resolved diff base, the synthetic commit can be deleted
  without changing stored results.
- The depth-1 path is cheap but not universal: an unfetchable head or merge
  base becomes an error row and a partial result. The blobless partial-clone
  fallback is documented, not hidden.
- The `--limit 20` smoke is manual and paid, intentionally absent from
  `npm test`; the model-free suite covers the builder, normalizer, options,
  resume guards, result/row writing against a fake CLI, and the judge
  invocation builder.
- Fixture and framework are Apache-2.0 and unredistributed: pins and the
  citation are committed, never the bodies; every generated header and results
  file repeats the citation.

### Smoke result (2026-10-19)

Round `2026-10-19-m1-smoke-glm`, model `zai-coding-cn/glm-5.3:max`,
concurrency 1, 60-minute cap for the two largest repositories:
**20/20 instances produced rows**, 0 error, 0 incomplete. The `reported` view
carried 33 findings and `confirmedOnly` 32; `dropped.anchorless = 0`. The
mock judge consumed both view directories with `evaluated_instances: 20` and
`missing_instances: 0`; its `balanced_score` (0) is a lexical placeholder and
**not** a result. One instance (`FreeCAD__FreeCAD@e596925`) hit the 60-minute
cap, produced a counted error row, then completed at 120 minutes and replaced
the error — visible in the round log. The smoke also produced the first
driver finding: exit 3 with a valid envelope is an incomplete review, not a
failure; exits 0/1/3 with a parseable envelope are now normal rows, and only
signal kills, other statuses and unparseable output are errors.

## Part III — Tool-schema field order (the field-order experiment)

### Context

OCR declares `analysis` before `comment_ids` in its filter tools
(`internal/agent/agent.go:1572-1597`, pinned `375f64c`) after replays showed
the model committing to ids before reasoning. The question is whether the
same applies to `submit_verdict`, which declares `verdict` before
`rationale` (`src/tools/collector-tools.ts:343-358`). The OCR evidence is
for a different tool on a different task.

**Hypothesis.** A rationale-before-verdict schema would make the model reason
before committing, lowering `falseKillRate` (72.0% on the locked verifier-benchmark
baseline) without collapsing `killRate` (82.7%) or `interceptPrecision`
(32.9%). The baseline lives in `RESULTS.md` and Part I.

**Provider caveat.** Schema order is only a hypothesis about generation
order. `adaptTool` forwards `tool.parameters` with no
`constrainedSampling`, so the SDK treats `submit_verdict` as an ordinary
JSON-schema tool. "The provider sees the order" and "the model follows it"
are separate claims.

### Evidence

**1. Declared order.** `createSubmitVerdictTool({})` declares, in insertion
order, `verdict, rationale, confidence, priorDecisionStillApplies,
decisionAssessments, codeFeedback, rejectionGround, uncertaintyReason`, with
`required: ["verdict", "rationale"]`. TypeBox preserves insertion order, and
the session-options test asserts the same order on
`customTools[0].parameters`.

**2. Captured wire order.**
`tests/unit/tool-schema-order.test.js` builds an isolated session whose only
custom tool is the real one, points the synthetic model at a closed loopback
`baseUrl`, installs a payload tap that throws before the request, prompts
once, and asserts: `function.strict === false`; property keys equal the
declared order and `required` equals `["verdict", "rationale"]`;
`function.parameters` deep-equals the tool schema. The wire order is
identical to the declared order.

**3. Why they agree.** `adaptTool` passes `parameters` through and sets no
`constrainedSampling`. In pi-ai 0.87.1,
`resolveJsonSchemaStrictSampling` returns `undefined` without that config,
so `convertTools` emits `getJsonSchemaToolParameters(tool, strict)`, which
returns `tool.parameters` unchanged unless `strict === true`. The explicit
`strict: false` is the production branch; even the strict path's
`makeStrictJsonSchema` walks `Object.entries(properties)` and preserves
order. The tap is a real seam: `openai-completions.stream` calls
`options.onPayload?.(params, model)` before the request, and the agent
forwards it. The test supplies that stream function from pi-ai's own pinned
module, so the captured payload is what the SDK would send.

**4. The limit.** This proves order visibility, not generation order, not a
verdict change and not cost. Those are empirical questions for the comparison
below; the test would still pass if the reorder had no behavioural effect.

### Decision

1. **Diagnose first; no production reorder before the verifier-benchmark comparison.**
   `submit_verdict` keeps its order, names and semantics. The diagnostic test
   is the regression guard for the wire order. No `record_candidate` reorder
   rides along.
2. **The Iteration 2 experiment is pre-registered here.** Population: the
   fixed verifier-benchmark 100-comment sample (`--limit 100 --seed 42`, digest
   `74f43e2f25442f0e62f97a9b960ae46de6f05eebfe5173298e16c9838aafc07d`), one
   side per field order. Repeats: at least two runs per
   side, same model id and thinking level, same fixture and provenance pins,
   both sides rebuilt from one tree except the field order, with CLI sha256
   **and** the `dist/` build digest per side (ADR 0008's lesson). Metrics:
   `killRate`, `falseKillRate`, accuracy and **output tokens**, read as a
   group. Reporting: one run per side is a point comparison; two repeats give
   a spread, not a confidence interval.
3. **Adoption rule.** Adopt only if `falseKillRate` falls without a
   comparable `killRate` collapse **and** the direction replicates across
   repeats. Otherwise record "no effect" and close as **not adopted**; never
   escalate to a bigger sample to rescue it.

### Iteration 2 — the comparison and the decision (2026-10-22)

**Intervention.** The `+` side changes one line of
`src/tools/collector-tools.ts`: `submit_verdict` declares `rationale`
before `verdict`, so TypeBox also puts `rationale` first in `required`.
Every other field, name and semantic is unchanged; the two `dist/` digests
differ by exactly that line.

```diff
     parameters: Type.Object({
-      verdict: enumSchema(VERDICTS), rationale: nonemptySchema(),
+      rationale: nonemptySchema(), verdict: enumSchema(VERDICTS),
       confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
```

**What ran.** The pre-registered comparison: the fixed sample (95 scored rows
after the same 5 materialization errors; 70 label-1 / 25 label-0), verifier
arm only, model `zai-coding-cn/glm-5.3:max`, two rounds per side, one build
per side reused across repeats, same materialized file, concurrency 4 and a
20-minute timeout. No row was re-run or dropped by verdict; one after-side row
was re-run because concurrent rounds raced on the clone cache — a harness
failure before any verifier call, recorded in that round. In the tables, `−`
is shipped (verdict first), `+` is the candidate.

#### Builds and population

| repeat | side | round | CLI sha256 | build sha256 (dist) | n | label1 / label0 |
| --- | --- | --- | --- | --- | ---: | --- |
| 1 | − | `2026-10-22-s1-order-before-r1` | `8d7de831b184d055…` | `47e77911f41dcdef…` | 95 | 70 / 25 |
| 1 | + | `2026-10-22-s1-order-after-r1` | `8d7de831b184d055…` | `09fb3ae9c6b688a0…` | 95 | 70 / 25 |
| 2 | − | `2026-10-22-s1-order-before-r2` | `8d7de831b184d055…` | `47e77911f41dcdef…` | 95 | 70 / 25 |
| 2 | + | `2026-10-22-s1-order-after-r2` | `8d7de831b184d055…` | `09fb3ae9c6b688a0…` | 95 | 70 / 25 |

The entry file `dist/cli/cli.js` is byte-identical on both sides, as ADR 0008
predicted; the build identity that sees the reorder is the `dist/` digest,
and the two differ by the one changed module.

#### Headline (uncertain = keep)

| repeat | side | killRate | falseKillRate | interceptPrecision | accuracy | output tokens | output / row |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | − | 72.0% | 67.1% | 27.7% | 43.2% | 722,711 | 7,607 |
| 1 | + | 76.0% | 70.0% | 27.9% | 42.1% | 735,142 | 7,738 |
| 2 | − | 68.0% | 68.6% | 26.2% | 41.1% | 689,473 | 7,258 |
| 2 | + | 68.0% | 65.7% | 27.0% | 43.2% | 698,073 | 7,348 |

#### Per-comment decision changes

| pair | common rows | decision changed | verdict changed | false-kill added | false-kill recovered | kills added | kills recovered |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| repeat 1 (− vs +) | 95 | 11 | 11 | 5 | 3 | 2 | 1 |
| repeat 2 (− vs +) | 95 | 10 | 10 | 2 | 4 | 2 | 2 |
| −, repeat 1 vs 2 (same build) | 95 | 10 | 10 | 4 | 3 | 1 | 2 |
| +, repeat 1 vs 2 (same build) | 95 | 9 | 9 | 2 | 5 | 0 | 2 |

**Reading it.** One comment moves `falseKillRate` by 1.4 pp (1/70) and
`killRate` by 4.0 pp (1/25), so this sample's resolution is one comment. The
same-build repeat pair is the noise reference: it measures how far one
identical build moves between runs, which any build effect must beat.

**Decision: not adopted.** Repeat 1 moved `falseKillRate` the wrong way
(67.1% → 70.0%) while `killRate` rose (72.0% → 76.0%); repeat 2 moved it the
expected way (68.6% → 65.7%) with `killRate` unchanged (68.0%). The sign
depends on the repeat, and every cross-build delta is inside what one build
does on its own: the unchanged `−` build moved 10 of 95 decisions between its
runs for a net +1 false kill, and the unchanged `+` build moved 9 for a net
−3. Output tokens tell the same story: `+` used 1.7% and 1.2% more than its
paired `−`, both smaller than the same-build spread of 4.6%–5.0% per row.
(`totalTokens` is not used: it adds cache reads the CLI result does not
itemise.) Per Decision 3, a small and inconsistent effect is a stop: the field
order stays as shipped, `submit_verdict` keeps `verdict` before
`rationale`, and the field-order experiment closes as **✗**.

### Consequences

- The order pir intends and the order the provider receives are both asserted
  by model-free tests, so "does the reorder reach the model?" costs no model
  call.
- The wire assertion is coupled to the pinned SDK (pi-coding-agent 0.87.1 /
  pi-ai 0.87.1 module paths); an upgrade that changes `convertTools` fails
  the test loudly rather than letting the evidence go stale.
- Nothing user-facing changes: no finding, verdict, envelope field, exit code
  or prompt rendering. `npm run typecheck && npm test` is the whole gate.
- No replicated effect was recorded; a future proposal needs new evidence and
  a fresh pre-registration, not a rerun. Two repeats on 95 rows can see a
  large effect and cannot certify a small one — exactly why the
  pre-registration forbade chasing the point with a bigger sample.

## References

- Data/framework: `Alibaba-Aone/aacr-bench` (Apache-2.0), upstream
  `ee9d7fef70ef31acea2ff7ae316ce0a9575fe4df`; citation arXiv 2601.19494,
  *AACR-Bench: Evaluating Automatic Code Review with Holistic
  Repository-Level Context*.
- OCR: `alibaba/open-code-review` @ `8eb8334` (the verifier-benchmark arms) and `375f64c`
  (the field-order hypothesis), Apache-2.0.
- Results: `tests/eval/aacr/README.md`, `tests/eval/aacr/results/RESULTS.md`,
  `M1-2026-10-26-full-roadmap.md`, `M0-2026-10-22-s1-field-order-r1.md` and
  `…-r2.md`.
- Related: [ADR 0003](0003-findings-quality-roadmap.md) (local-only stance and change protocol), [ADR 0008](0008-structured-verifier-rejection-grounds.md)
  (rejection grounds and build-digest provenance),
  [ADR 0011](0011-deferred-and-rejected-directions.md) (the slicing decision, which
  consumes these numbers).
- Implementation: `src/app/verify-comment.ts`,
  `src/agents/ocr-reflection-prompt.ts`, `src/agents/verifier.ts`,
  `src/tools/collector-tools.ts`, `tests/eval/aacr/`.
