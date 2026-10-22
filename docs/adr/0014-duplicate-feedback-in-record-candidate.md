# ADR 0014: Visible duplicate feedback in `record_candidate`

## Status

**Accepted (2026-10-22).** Second OCR-borrow series, item S5. The item was scoped as a feedback gap with a code-fact evidence level, so it needed no model A/B before merge.

## Context

`record_candidate` validates a candidate, stores it, and answers with `Recorded candidate F-X: <title>` (`src/tools/collector-tools.ts`). The answer is identical whether the candidate is a new distinct defect or one that restates a finding the run already holds: duplicates are resolved afterwards, in the supervisor, by `deduplicateCandidates` (`src/findings/dedup.ts`) — strictly against prior-round knowledge on the single-session path and with the cross-angle relaxation on the round-1 fan-out path. The model therefore receives a confirmation that does not distinguish "new defect" from "overlaps an existing finding".

This is a **feedback gap, not a lost-record bug**: the candidate is recorded, deduplicated and reported exactly as before. The only effect is that the model cannot see that it just restated something the run already knows — so it cannot state how a genuinely different defect differs, and it cannot avoid burning a slot on a pure restatement. OCR treats the same class of blind spot as a defect in its own tool surface: an empty or no-op submission must error rather than return a success-shaped confirmation (upstream `internal/tool/code_comment.go`, commit `#1773`).

## Evidence

**1. The gap is structural, not a prompt omission.** The reviewer prompt carries the diff, memory, focus, rules and the previous round's prose summary, but never the accumulated candidate set: `state.known` lives in the supervisor and is the dedup baseline, not prompt content. A session can only rediscover it by re-reviewing the code, so the confirmation is the only moment a session could learn about an overlap.

**2. The comparison boundary has to be narrower than dedup's.** Dedup runs on the merged output of every session in a round, which is exactly what a single session cannot see. Two boundaries follow. Prior-round `state.known` is stable for the whole round and is already the strict baseline, so a session can be told. Its own earlier candidates are the session's own output, so it can be told. A parallel angle session's same-round candidates are invisible: they arrive concurrently, the cross-angle merge relaxes the category gate and can displace a less severe representative, and merging that state mid-run would require shared mutable session state — the supervisor stays the only place those collapse.

**3. The rule must be the dedup rule, literally.** A hint that fired on a different predicate than dedup would either promise a collapse that will not happen or stay silent on one that will. `duplicateMatch` (`src/findings/dedup.ts`) is therefore extracted as a pure, read-only predicate and used by both: exact fingerprint first, then the same entityKey with the same category and claim similarity at or above the dedup threshold. The cross-angle category relaxation stays an explicit option the tool does not pass. Scanning order is also shared: prior-round knowledge first, then the session's own earlier candidates, matching the order `deduplicateCandidates` sees.

**4. Wording is part of the contract, because the failure mode is behavioural.** The hint could make the model stop reporting or pad the diff with restatements to game a count. The sentence therefore states that the candidate **was** accepted and recorded for deduplication, names the overlapped finding and the criterion, tells the model what to do when the defect is genuinely different (state the difference in claim/trigger), and forbids only the one thing that is useless — resubmitting the same finding. It never says the finding will not count, never blocks submission, never touches severity, and never adds a required tool parameter.

**5. What must stay byte-identical.** When no overlap exists the tool result is the pre-existing string, character for character; dedup, `displayId` assignment, the reporting cap and the verifier's behaviour are untouched, and the hint is computed only after a candidate fully validated, so a rejected submission still reports no hint and mutates nothing.

## Decision

Attach an **optional, visibility-only duplicate hint** to the `record_candidate` result.

- Baseline: a snapshot of prior-round knowledge taken when the reviewer session starts (`ReviewerDeps.known` → `CandidateCollector.known`, wired from `state.known` in both change-mode paths and the audit path) plus the same collector's earlier candidates. The baseline is read-only: the tool never mutates it, never adds the round's output to it, and never calls `deduplicateCandidates`.
- Overlap rule: `duplicateMatch` with the strict prior-round gates (no cross-angle relaxation).
- Result: the unchanged `Recorded candidate F-N: <title>` line, then the hint `Accepted and recorded for deduplication. It overlaps an existing finding (F-12) by fingerprint|claim similarity. If it is materially different, state the difference in the claim/trigger. Do not resubmit the same finding.` The structured `duplicateOf` field (the overlapped runtime id) rides on the tool output for tests and observability and is never forwarded to the model.
- No new required parameter, no new tool, no change to the request envelope, no cross-angle state.

## Consequences

- A session can now tell a restatement from a new defect at the moment it submits, and can spend its remaining effort on the difference instead of re-deriving the overlap.
- The hint and the dedup pass cannot drift: one predicate, one scan order. A future change to the overlap rule changes both by construction.
- Dedup, `displayId` assignment, reporting counts, the severity rules (cross-angle displacement between batch peers, strict matching against prior-round knowledge) and the verifier are unchanged; the no-overlap path is byte-identical.
- Parallel angle sessions keep independent hints. Cross-angle and same-round duplicates are still only visible in the supervisor's merge, which is a deliberate limitation of this ADR, not an oversight.

## Revisit conditions

- **The hint suppresses genuine findings:** dogfood or a benchmark round shows sessions dropping a second, materially different defect because "Do not resubmit the same finding" was over-read, or findings shrinking without a matching coverage increase. Rewrite the sentence or gate the hint.
- **The hint inflates volume:** the model restates the overlapped id in claims/triggers to appear different, or pads with near-duplicates that spelled-out differences now let through. If that happens the overlap rule or the sentence needs tightening, not dedup.
- **Cross-angle state becomes shareable cheaply:** if the architecture ever gives parallel sessions a live read view of each other's candidates, the narrower boundary chosen here should be re-examined rather than assumed.
- **Dedup's predicate changes:** because the hint reuses `duplicateMatch`, any change there re-opens this ADR's wording review.

## References

- Implementation: `src/findings/dedup.ts` (`duplicateMatch`, `deduplicateCandidates`), `src/tools/collector-tools.ts` (`record_candidate`, `findOverlap`, `duplicateNotice`), `src/agents/reviewer.ts` (`ReviewerDeps.known`), `src/agents/types.ts` (`AgentToolOutput.duplicateOf`), `src/core/supervisor.ts` (the three `runReviewerRound` call sites).
- Tests: `tests/unit/collectors.test.js` (exact fingerprint, near-duplicate by entity+claim, strict category/entity gates, severity preserved, cross-session invisibility, no-hint byte identity).
- Precedent: OCR's "empty/no-op submission must error" (`internal/tool/code_comment.go`, commit `#1773`, pinned revision `375f64c`) — the same principle that a tool result must not claim more than it did.
- Related: [ADR 0003](0003-findings-quality-roadmap.md) (finding-loop quality work), [ADR 0011](0011-large-changeset-slicing-decision.md) (why cross-angle merge semantics stay supervisor-owned).
