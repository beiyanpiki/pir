# Review loop: evidence, scheduling, and evaluation

## Roles and evidence

Reviewer prioritizes behavioral changes and investigates a small causal slice: change, reachable trigger, incorrect outcome, and plausible counter-evidence. It submits distinct grounded root causes rather than filling the findings limit. Verifier independently checks both technical validity and attribution to the change; candidate evidence is a navigation aid, not a conclusion to inherit. Both roles use structured completion tools as their sole final tool call. Neither role executes tests or changes source files.

`read_code` and `search_text` read immutable Git revisions. Their `revision` selector is `head` (default), `base` (the requested comparison ref), or `merge-base` (the actual old side of the three-dot diff). `buildChangeSet` resolves refs before reading the patch. Tool responses identify the commit and provide bounded output with continuation parameters. `get_change` supports file, hunk, and raw hunk-line pagination so removed code is recoverable even for large changes. Built-in filesystem and structural-index tools remain navigation aids, not proof of what exists in the reviewed commit.

## Candidate lifecycle

Known candidates, pending verification, and verified results are separate. New candidates are deduplicated and queued in severity order. Existing pending work is verified before paying for another discovery session. Each loop round performs at most eight verifications by default; a subsequent round can drain the queue without another Reviewer session. Rejections and historical suppression do not consume the report limit. Confirmed and uncertain findings do.

The existing `--max-rounds` option bounds all loop rounds, including verification-only rounds. `--max-findings` is a ceiling, never a target. Hitting a round, report, or token limit can leave pending candidates. These are persisted with status `candidate`, listed separately as `pendingFindings` in JSON, and counted by `pendingCandidates`; they are not reported as confirmed or uncertain findings. Inspect them with `pir findings list --status candidate`. This does not implement automatic cross-run queue resumption.

An empty discovery round no longer forces immediate termination if Reviewer requests further investigation. The loop still obeys its round/budget/convergence limits. A missing `finish_round` is an execution failure, not a clean review; already recorded candidates are retained when that session fails. Missing verdicts and verifier/provider failures remain explicitly classified uncertainties.

`data.incomplete` marks pending verification, unfinished discovery, or verification execution errors. With a configured `--fail-on` threshold, a qualifying reported finding returns exit code 1; otherwise an incomplete review returns 3 instead of passing the gate. Default `--fail-on none` still returns 0 with explicit incomplete diagnostics. Persisted runs use status `incomplete` rather than `completed` in these cases.

## Feedback and memory

A later discovery session receives coverage, unresolved questions, blockers, and bounded code-only verification feedback. Historical issue decisions and their rationale remain Verifier-only. Feedback is withheld when Verifier has received or queried issue decisions.

Verifier receives candidate evidence, the relevant diff tools, and historical decision IDs, triggers, and stale markers. Applicability is assessed per decision ID; a blanket legacy boolean can only apply when exactly one decision matched. A technically real defect can still be covered by an applicable trusted accepted-risk or wont-fix decision. Agent-generated knowledge alone cannot suppress findings.

Memory packs retain a compact set of project invariants and prioritize relevant entity/feature contracts and verified fixes, including entity-only fix history. Sections are bounded to fit the pack budget. Stored knowledge is evidence, not instructions; lack of a stale flag is not proof of freshness. Model-backed bootstrap/refresh remains explicit rather than automatically running during review.

## Reproducible sessions and metrics

Pi sessions use an explicit read-only system role, a resource loader with no ambient project/global resource discovery, memory-only session settings, and the tool allowlist. Project AGENTS/SYSTEM files, extensions, skills, prompt templates, and hooks are not automatically loaded. Model credentials and selected model/thinking settings still come from the established model runtime.

`data.usage` reports SDK-accounted input/output/cache tokens, total tokens, cost, session durations, tool calls, and repeated read/search calls when available. `data.usageComplete` indicates whether every session supplied usage. Missing usage is not represented as a measured zero. `estimatedTokens` remains the budget counter: measured session tokens when available, text estimates otherwise. Token limits are checked between sessions, not hard cancellation of an in-flight model turn. `data.durationMs` measures the whole review, while session usage durations cover session work.

`data.verificationErrors` and `data.uncertaintyReasons` distinguish missing evidence/tool limitations from provider errors or missing structured verdicts. `PIR_TRANSCRIPTS=1` adds usage and effective-session metadata to the opt-in JSON conversation snapshots next to the memory database. These are not provider-wire captures; model thinking is present only if emitted by the provider/SDK.

## Evaluation

Run `npm test` for model-free tool, scheduler, session-isolation, and scoring regressions. See [the evaluation guide](../tests/eval/README.md) for labelled scenarios and paired baseline/candidate runs. Live evaluation remains opt-in with `PIR_EVAL=1`.

Scoring uses one-to-one matching with claim/location/category/severity constraints. Extra and duplicate reports count against precision; uncertain matches do not count as confirmed successes. Compare recall and precision together with complete token usage, wall time, duplicate work, verification errors, and pending candidates. Baseline and candidate runs use identical committed fixtures and independently copied memory state. Report repeated-run results rather than claiming improvement from one passing scenario. No model-quality gain follows merely from passing deterministic unit tests.
