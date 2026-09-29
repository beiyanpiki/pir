# Review-loop evaluation

This is an **opt-in, live-model** benchmark, not part of the normal model-free test suite. Importing the runner has no side effects. Without `PIR_EVAL=1`, it exits successfully without opening a database, loading a CLI/configuration, or contacting a model. No live evaluation was used to implement this harness.

## Offline tests

```sh
node --test tests/unit/eval-scoring.test.js
node tests/eval/run-eval.js --json
```

The unit tests use only Node, local Git, temporary files and a fake local CLI. They do not require `dist`, credentials, a model, network access, or a build. They cover scoring, malformed labels, uncertainty, missing/partial metrics, argument validation, the opt-in gate, clone isolation, diagnostics, and deterministic fixture histories.

## Live runs (explicit opt-in only)

Prepare the CLI builds separately. This runner never builds or installs anything. CLI paths must point to Node-compatible `dist/cli/cli.js` entrypoints with their adjacent compiled memory modules/dependencies available. Supply a concrete model ID for the most reproducible comparison.

```sh
PIR_EVAL=1 PIR_MODEL=provider/model node tests/eval/run-eval.js \
  --repeats 3 \
  --baseline-cli /absolute/baseline/dist/cli/cli.js \
  --candidate-cli /absolute/candidate/dist/cli/cli.js \
  --json --output /absolute/results/new-eval.json
```

Omit `--baseline-cli` for candidate-only evaluation. Candidate defaults to this checkout's `dist/cli/cli.js`, independent of the caller's working directory. CLI flags take precedence over environment values.

| CLI flag | Environment equivalent | Default |
| --- | --- | --- |
| `--repeats N` | `PIR_EVAL_REPEATS` | `1` |
| `--baseline-cli PATH` | `PIR_EVAL_BASELINE_CLI` | none |
| `--candidate-cli PATH` | `PIR_EVAL_CANDIDATE_CLI` | local dist CLI |
| `--model ID` | `PIR_MODEL` | copied pir config, then pi default |
| `--max-rounds N` | `PIR_EVAL_MAX_ROUNDS` | `2` |
| `--max-tokens N` | `PIR_EVAL_MAX_TOKENS` | `400000` |
| `--max-findings N` | `PIR_EVAL_MAX_FINDINGS` | `10` |
| `--timeout-ms N` | `PIR_EVAL_TIMEOUT_MS` | `900000` per CLI process |
| `--json` | `PIR_EVAL_JSON=1` | summary stdout |
| `--output PATH` | `PIR_EVAL_OUTPUT` | no saved artifact |

All numeric options must be positive safe integers. `--help` is model-free. `PIR_EVAL_AGENT_DIR` overrides the configuration source directory; otherwise it is `PI_CODING_AGENT_DIR` or `~/.pi/agent`. The pir configuration source is `PIR_CONFIG_DIR` or `~/.pir`.

## Paired isolation and reproducibility

- Each scenario has one canonical Git snapshot with fixed commit dates, identities and neutral commit messages. Base/head/tree SHAs and a diff hash are recorded. Labels are **not** written into the reviewed checkout.
- One SQLite state is initialized per scenario, using the baseline's compiled memory modules when paired (candidate modules otherwise). Historical feedback/fix/feature knowledge is seeded at a concrete pre-change commit; the final change is applied afterwards. The database is closed before copying. Both versions must support the baseline schema or migrate their own copy.
- Every variant of every repeat receives a fresh filesystem copy of that same repository and seed database. No Git worktrees, hardlinks, shared database, or previous-run results are reused. The database stays outside the reviewed repository. Seed database SHA-256 is recorded for auditing equal inputs **within** an invocation; SQLite timestamps/UUIDs mean the seed hash is not promised to repeat between invocations.
- Pi `settings.json`, `models.json`, `models-store.json`, `auth.json` and pir `config.json` are snapshotted once, then independently copied into each run. HOME, pi/pir configuration paths, state and cache locations are isolated. CLI execution is forced local, first-run setup and transcripts are disabled. Credentials/configuration are never exported; temporary copies are deleted, including on errors. Non-secret model-settings hashes, effective model and thinking setting are recorded.
- Both variants receive the same explicit model, base/head and limits. Baseline-first/candidate-first order alternates across scenarios/repeats. Each subprocess is independent, and all temporary fixture/configuration/state directories are removed afterwards.
- Model sampling, provider caches, provider changes and external credential helpers are not controlled by a local filesystem snapshot. Provider-side state cannot be cloned; repeats expose variance, not mathematical determinism. CLI entrypoint hashes do not hash every imported dependency. Use fixed builds/dependencies and a fixed provider/model configuration for comparisons.

## Labels and scoring

There are 13 deterministic cases: introduced counter bug, unchanged preexisting bug, guarded division negative, clean internal rename/refactor, multi-file units contract, large replacement diffs with a bug at each end, relevant expected-behavior suppression, returning fixed regression, still-fixed regression, renamed feature memory, outdated internal-only decision scope, and two independent defects. Large diffs contain both old and new replacement content, with defects placed near opposite truncation boundaries.

Expectations have globally stable IDs, `shouldReport`, a case-insensitive `claimLike` regex over title/claim, allowed `categories`, labelled `locations` (repository-relative path and inclusive line interval), and optional severity bounds. All match constraints apply together. Any listed location may match an overlapping finding anchor. P0 is most severe: `minSeverity: P2` allows P0–P2, while `maxSeverity: P1` excludes P0. Current positive labels accept P1–P2. Invalid severities never earn credit.

- **TP:** a confirmed finding matched to one positive label by maximum-cardinality, one-to-one matching. A report cannot satisfy two labels; overlapping regexes do not force greedy undercounting.
- **FP:** every unmatched confirmed report, including duplicates, unexpected/unlabelled issues, negative-labelled reports, wrong locations/categories, and severity mismatches. Matching a vague regex alone is insufficient.
- **FN:** every positive label without a matching confirmed report. Rejected/suppressed/candidate records cannot satisfy it.
- **Uncertain:** scored separately, with one-to-one matches only against labels still missed by confirmed reports. An uncertain match remains an FN, not a TP or confirmed success. Classifications distinguish expected-unconfirmed, duplicate, negative-label, severity-mismatch and unexpected reports. The CLI's own uncertainty reason counts are also retained independently.
- Precision = TP/(TP+FP); recall = TP/(TP+FN); F1 = 2TP/(2TP+FP+FN). Undefined ratios are `null`, not perfect scores. There is no inferred true-negative count. Aggregate quality metrics are micro-averages over scored runs, and labelled-negative report rate uses negative labels as its denominator.
- Strict pass requires no FP, FN, uncertain finding, known pending work, or verification error. An explicit `data.incomplete: true` also prevents a pass, including otherwise clean negative scenarios. If an older baseline omits `incomplete`, it remains `null`, not `false`. Unknown baseline diagnostics remain `null`, not zero. Execution failures are failed runs and are reported separately from scored runs; they are not silently scored as empty successful reviews. An empty response is valid only when `data.findings` actually exists and is an array.

These are **human-labelled synthetic fixtures**, not complete ground truth for arbitrary repositories. Regex/location/category/severity judgements can reject legitimate wording or newly discovered real defects. An unlabelled confirmed report is conservatively an FP pending human adjudication; it is not proof the model hallucinated. Review raw reports before changing labels, and avoid tuning only to these fixtures. This benchmark does not claim a causal memory-reuse rate or real-world accuracy from a handful of scenarios.

## Output and measured efficiency

The CLI response contract consumed is `result.data`: `findings`, optional `usage`, `usageComplete`, `durationMs`, `pendingCandidates`, `pendingFindings`, `verificationErrors`, `uncertaintyReasons`, `estimatedTokens`, `memoryPackTokens` and `run.rounds`. Reviewed findings and pending candidates remain separate. Raw `data`, findings, classification details, stopping reason, exit status, stderr and measurements are retained per run.

`usage` may contain `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`, `cost`, `durationMs`, `toolCalls`, and `repeatedToolCalls`. Missing, invalid or unavailable numeric measurements are `null`; estimated tokens are never substituted for measured usage. Reported zero is preserved. Tool/repeated-tool metrics come from the CLI instrumentation, not guessed from finding counts. CLI outcome duration, summed session duration, and harness subprocess wall time are separate. Wall time includes startup and is measured even when usage is unavailable.

Only `usageComplete === true` contributes to aggregate usage totals/means and paired usage deltas. Partial/unknown usage remains visible per run, with excluded-run coverage counts. Every aggregate measurement includes `measuredRuns`; a total with no measured runs is `null`. Paired deltas are candidate minus baseline for each scenario/repeat; unavailable or incomplete usage makes its delta `null`. Do not infer savings by comparing totals with different coverage, quality, pending work, errors or uncertainty.

`--json` emits one full report on stdout; progress goes to stderr. Without it, stdout contains summaries and paired deltas. `--output` explicitly exports the full report to a new local file (parent must exist), refuses overwrites, and uses mode 0600. No permanent artifact is created by default. Reports can contain fixture findings and CLI error output: treat exported artifacts as potentially sensitive. Exit codes: 0 = all runs pass or opt-in skipped; 1 = scored/CLI failures; 3 = setup/argument/export failure.
