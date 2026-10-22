# ADR 0012: Session-audit enhancements (D-B7) — not adopted

## Status

**Accepted (2026-10-20), outcome: rejected — the data trigger did not fire.** Decision point D-B7 of [the OCR-borrow roadmap](../roadmap-ocr-borrowings.md), Iteration 4. No transcript-default or web-marking work is added; the conditions under which the decision reopens are recorded below.

## Context

D-B7 compared pir's audit surface with OCR's: OCR writes full JSONL session logs and ships a viewer with replay, marks and comparison; pir writes opt-in session snapshots (`PIR_TRANSCRIPTS=1`) plus a `run.json` manifest and renders findings in a read-only web explorer. The roadmap made the gap a **data-triggered** decision: act only on "accumulated debugging / cost-attribution demand, or prompt tuning needing replay evidence", and the action named was `localStorage` mark-and-hide after the OCR viewer. The trigger is therefore about *demonstrated need*, not about parity with OCR.

## Evidence

**1. Cost attribution is already answered without transcripts.** The `run.json` manifest records usage (input/output/cache tokens, cost), rounds, session references, stop reason and coverage; `pir runs status` prints the run's mode, stop reason, coverage and costs; the web run summaries expose model, duration, tokens and cost; the M1 driver's `summary.json` attributes tokens and duration per instance (the per-PR table in [RESULTS Appendix A](../../tests/eval/aacr/results/RESULTS.md) was built entirely from it). Of the 39 change-mode manifests on this machine, **39 carry usage** and none required a transcript to answer "what did this run cost".

**2. The debugging that actually happened did not need replay.** The M1 driver's last defects were diagnosed from the round summary, per-instance rows and stderr tails: exit 3 with a valid envelope had to be an incomplete row rather than an error (ADR 0009), and the paused round's resume state was reconstructed from `summary.json`, the round directories and the pinned docs. This repository's dogfood deferral backlog (machine-local, not committed) contains no entry whose disposition depends on transcript replay, and the Phase-3 review loop routinely resolves findings from the findings JSON and `verify-fix`.

**3. Prompt tuning used labels and findings, not replay.** B4's asymmetric rejection clause and B5's `PROJECT RULES` injection were evaluated on M0's 2,134 labelled comments and on dogfood findings; the evidence that decided them was score movement and finding provenance, not session replay. The documented fidelity limit reinforces this: pir's transcripts are retained SDK session snapshots (compaction may replace earlier context), **not provider request captures** — they are investigation aids, and an "on by default" replay surface would invite over-reading them as exact wire evidence.

**4. The missing UI feature has no recorded demand.** Transcripts are opt-in for CLI runs and enabled by default only for web-enabled server runs (`src/server/server.ts`), the explorer is read-only, and page alerts already have mark-read. No roadmap item, dogfood finding, issue or ADR asks for mark-and-hide; the OCR viewer is the only source of the idea, and the roadmap's own non-borrow list treats parity here as optional.

## Decision

**Reject D-B7 for now; keep transcripts opt-in and cost attribution manifest-based.** Defaulting transcripts on is a privacy/disk/retention decision, not a neutral observability toggle, and no measured need justifies it. The web marking feature is deferred with it, because it only has a subject once transcripts are the default inspection surface.

## Revisit conditions

- **Debugging:** an incident where the manifest, findings, `verify-fix` and stderr tails cannot locate the cause and a session replay demonstrably would have — record that incident in this ADR before changing defaults.
- **Prompt tuning at scale:** a campaign that needs cross-session replay (for example an at-scale false-negative analysis) and cannot be answered from M0/M1 scores plus findings.
- **External demand:** a user or automation consumer asking for per-finding cost or replay in the UI; then the request itself is the data.
- **If transcripts become default:** a documented retention and size budget, a delete/export story (they include prompt and tool traffic), and a note that they are not provider request captures must land in the same change.

## Consequences

- No new UI work, no default change, no new configuration knob; the read-only explorer and the manifest stay the audit surface.
- Evaluation isolation is unchanged: M1 rounds run with `PIR_TRANSCRIPTS=0` so a benchmark run does not write per-instance snapshots.
- The OCR-style viewer comparison remains deliberately unborrowed; the next observability investment is justified by a recorded incident, not by parity.

## References

- Roadmap: [`docs/roadmap-ocr-borrowings.md`](../roadmap-ocr-borrowings.md).
- Companion context: [`docs/ocr-borrowings-context.md`](../ocr-borrowings-context.md) §3 (session-auditing row) and §4 (risk table).
- Contract: [`docs/review-loop.md`](../review-loop.md) "Session metrics and transcripts"; [`docs/for-llm.md`](../for-llm.md) environment table (`PIR_TRANSCRIPTS`).
- Implementation: `src/agents/transcripts.ts` (opt-in), `src/server/server.ts` (web default), `src/observability/run-events.ts` (manifest), `src/server/web-store.ts` (run summaries/coverage).
- Cost source: [`tests/eval/aacr/results/RESULTS.md`](../../tests/eval/aacr/results/RESULTS.md).
