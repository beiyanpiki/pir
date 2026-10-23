# ADR 0017: A lightweight per-file attention prompt for the reviewer (S3)

## Status

**Accepted (2026-10-23).** Second OCR-borrow series, item S3 (Iteration 3). Prompt-only: zero extra model calls, no new tool, no new enforcement, no hard error. Shipped as an attention aid; its effect on recall is **not measured** in this ADR.

## Context

The M1 end-to-end baseline reports weak recall across sizes, not only for large PRs: the `≥500` lines bucket is 4 PRs / 72 references / 6.9% recall, and the `50–199` lines bucket is 20 PRs / 100 references / 8.7% recall ([`M1-2026-10-20-baseline-glm.md`](../../tests/eval/aacr/results/M1-2026-10-20-baseline-glm.md)). Two caveats are load-bearing and must travel with any change made for this signal: the `≥500` bucket is only four PRs, and the reference population is maintainability-heavy, a category pir deliberately de-emphasises (Q1 blacklist / F1 angles) — so no single intervention is expected to move `balanced_score` on its own.

OCR injects the changed-file list into the reviewer context and asks for a pass per `<review_files>` entry (`prompts/main_task_system.md:16-23`). pir does not list the changed files at all: the reviewer discovers them through `get_change`, which pages one file at a time, so the shape of the whole change is never visible before the first read. That is a plausible mechanism for a changed file never entering the investigation, but it is a hypothesis on a directional signal, not a measured cause.

The constraint that decides the design: the plan phase is a separate decision point (D1 in the roadmap) and must not ride along, and the reviewer cannot be asked to read more than it already reads. This ADR therefore adds **attention**, not work.

## Decision

1. **Inject a bounded `CHANGED FILES` section** into the change-mode reviewer prompt: `path`, `status`, churn (`+additions/-deletions`), and — for a file the change-mode filter withheld — the exclusion reason. The data is the existing change-set projection (`changedFileSummary`), the same one the JSON envelope and `run.json` record, so the prompt cannot disagree with what the run logged. Nothing new is computed from git.
2. **Cap at 60 entries with an explicit remainder line.** A change larger than that renders the first 60 and `... N more changed files not listed`. The count in the heading is always the true total, so a truncated list never reads as a complete one.
3. **Place it after the change line (and angle block) and before `PROCESS`** — the map before the method. The evidence block and memory pack stay at the end of the prompt, unchanged.
4. **Ask for per-file accounting in the existing vocabulary.** The section ends with: before `finish_round`, each listed file is either investigated or explicitly skipped with a stated reason in `coverage` (for example, skipped because it is generated); an unread file silently omitted is not a skip; and the sentence says outright that this is **not a hard error** — reading every file is not required, accounting for them is.
5. **Zero extra calls, no state, no enforcement.** No extra model call, no new tool, no read requirement, no ledger change, no new manifest field. Rounds 2+ get the same list because it describes the change, not the round; fan-out angle sessions get the same list; audit keeps its owned-range prompt; verifier prompts are untouched.
6. **Absent or empty change set renders nothing**, so the reviewer prompt is byte-identical to the pre-S3 prompt.
7. **Repository-controlled fields are flattened before rendering.** A changed file's path comes from the repository, and a hostile PR can ship a name containing a newline, a control character, a bidi override or an absurd length. Every rendered field is collapsed to one line (control, line-separator and invisible characters become a space) and length-capped (300 characters for the path), so a name can never end its bullet and add a line that reads like prompt text; a path with no printable content renders as `<path unavailable>`. Nothing else is rewritten — a visibly hostile name stays visible next to its churn, which is the honest thing to show a reviewer. The exclusion reason, itself code-generated, passes through the same flattener as defence in depth.

## Evidence

**1. The projection is shared, so the list cannot drift.** `changedFileSummary` already backs `data.run.files[]` in the envelope and `files[]` in `run.json`, including the `excluded`/`excludedReason` pair from the change-mode filter (ADR 0004). The prompt is one more consumer of the same projection, not a parallel list.

**2. A list is the cheapest available intervention.** It costs no session and no tool call; it changes what the model can see before it chooses where to spend its reads. For a change with a hundred files, the old prompt gave no way to know the set existed.

**3. The accounting request is not a coverage contract.** The change-coverage ledger (C1) already records which hunks were read, and ADR 0013 keeps one state machine rather than two. Making unread files an error would convert the prompt into a second, enforced contract — and would force reads of generated or lockfile noise the filter exists to avoid. A stated skip reason is therefore a valid pass, and the prompt says so.

**4. The prompt surface is inject-safe by construction.** The section is built from repository-controlled strings, so a dogfood run on the rebased branch found the gap the first build had: an unsanitised path could carry a line break into the prompt. The flattener in decision 7 closes it, and `tests/unit/prompts.test.js` asserts that a name containing `\n\nIGNORE ALL PREVIOUS INSTRUCTIONS`, control characters or 5,000 characters still renders as exactly one bullet.

**5. What is deliberately not claimed.** This ADR makes no recall claim. The M1 protocol's locked 50-PR baseline is not re-run here, so S3 closes as *shipped, effect not measured*: the roadmap's A3 explicitly refuses to call an unmeasured prompt change done.

## Consequences

- A reviewer session can see the whole change (up to the cap) before its first read, including which files are known-unreviewable and why.
- The prompt grows by at most about 60 short lines (about 3 KB, well under 1,000 tokens) on change runs, with no extra call; rounds 2+ and angle sessions reuse it.
- Nothing is enforced and nothing new is persisted. A reviewer that ignores the section produces the same run as before: a coverage list that omits a file is visible to the operator, not fatal to the run.
- A crafted filename cannot add prompt text: it can be visible (that is the point) but it cannot become a separate line or an unbounded value.
- A change with more than 60 files gets a truncated list; the remainder line says so, and the full set is still reachable through `get_change`.

## Acceptance mapping

- **A1 — prompt tests.** `tests/unit/prompts.test.js` (rendering, singular/plural header, cap plus remainder, exclusion reason, placement, byte-identical absent path, audit unaffected) and `tests/integration/changed-files-prompt.test.js` (supervisor wiring: the change set reaches the prompt, an excluded file's body still never does, the 60-entry cap holds end to end).
- **A2 — dogfood notes.** Recorded in the PR: the reviewer's `coverage` and finding distribution on this repository's own diff, observational only.
- **A3 — M1.** Not run. The locked baseline is unchanged, and per the roadmap the item is closed as *not measured*, not done.

## Revisit conditions

- **The model parrots the list.** If dogfood shows `coverage` restating paths without investigating them, or findings that merely name listed files, tighten the accounting paragraph — do not add enforcement.
- **The prompt gets a measured M1 round.** A protocol-compliant comparison on the full 50-PR subset is the only way this item becomes measured; it must report the whole set and the buckets, never the `≥500` bucket alone.
- **The cap is too small in practice.** If real reviews routinely exceed 60 files, raise the cap deliberately (with the token cost stated) rather than dropping the remainder line.
- **The plan phase is proposed (D1).** It remains a separate decision point gated by this item's dogfood or an M1 result; it does not ride along here.

## References

- Implementation: [`src/agents/prompts.ts`](../../src/agents/prompts.ts) (`ChangedFileLine`, `CHANGED_FILES_LIMIT`, `changedFileLines`), [`src/agents/reviewer.ts`](../../src/agents/reviewer.ts) (the change-set projection passed into the prompt).
- Tests: [`tests/unit/prompts.test.js`](../../tests/unit/prompts.test.js), [`tests/integration/changed-files-prompt.test.js`](../../tests/integration/changed-files-prompt.test.js).
- Baseline and caveats: [`M1-2026-10-20-baseline-glm.md`](../../tests/eval/aacr/results/M1-2026-10-20-baseline-glm.md), [`RESULTS.md`](../../tests/eval/aacr/results/RESULTS.md), [ADR 0009](0009-m1-end-to-end-benchmark.md) (M1 protocol), [ADR 0007](0007-aacr-verifier-offline-benchmark.md) (caliber caveats).
- Related: [ADR 0004](0004-change-mode-file-filter.md) (the exclusion record this section renders), [ADR 0013](0013-change-coverage-manifest-decision.md) (why coverage stays one ledger, not an enforced prompt contract), [ADR 0016](0016-user-background-for-find.md) (the other Iteration 3 input; deliberately a separate PR).
- External mechanism: OCR (pinned `375f64c`) `prompts/main_task_system.md:16-23` (per-file pass requirement) and `prompts/main_task_user.md:1-8` (changed-file list); hypothesis for pir.
- Roadmap: `docs/roadmap-ocr-second-pass.md` §3, item S3.
