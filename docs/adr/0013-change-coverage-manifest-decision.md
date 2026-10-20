# ADR 0013: Change-mode coverage manifest contract (D-B8) — not adopted as a new contract

## Status

**Accepted (2026-10-20), outcome: rejected — the trigger did not fire, and the substance already exists.** Decision point D-B8 of [the OCR-borrow × AACR-Bench roadmap](../roadmap-ocr-borrow-and-aacr-benchmark.md) §3, Iteration 4. The decision is a *reject of a new contract*, not a reject of coverage reporting: C1's ledger and B1's exclusion record already carry the audit information, and this ADR fixes the derivation rule so no second schema is invented.

## Context

D-B8 asked for a change-mode coverage manifest with per-file terminal states (reviewed / skipped / excluded) and for `incomplete` to be tied to coverage, taking OCR's frozen-denominator RunManifest as the model. The roadmap made it data-triggered: act "after B1, [when] the envelope already carries exclusion reasons and automation consumers ask for coverage auditing". B1 landed (ADR 0004), so the remaining question is whether any consumer actually asks for the extra vocabulary — and whether gating completion on coverage is the right direction.

## Evidence

**1. What already ships.** Change mode records a coverage ledger on the run manifest and on each round record: `hunksTotal` / `hunksCovered` / `filesTotal` / `filesCovered` plus a per-file `files[]` of `{ path, covered, total }` capped at 200 entries (`src/core/change-coverage.ts`; `RunManifest.changeCoverage` in `src/observability/run-events.ts`). A hunk counts as covered only through a deliberate read — paged `get_change` lines or a head-revision `read_code` window intersecting the hunk — never through overview listings or collector evidence. B1 adds `files[].excluded` + `excludedReason` to both the envelope's and the manifest's file list, with the diff body emptied at the source (`src/changes/change-set.ts`). Audit mode already has the per-file ledger with `reviewed` / `partial` / `unreviewed` / `blocked` / `failed` states (`audit_file_coverage`) and units. All of it is exposed: the web API returns a mode-specific `/api/runs/:projectId/:runId/coverage` payload (`src/server/web-store.ts`), `pir runs status` prints coverage and stop reason (`src/cli/runs.ts`), and [`docs/for-llm.md`](../for-llm.md) documents the change-mode contract.

**2. The consumers that exist are already served, and no one asks for the new vocabulary.** The web run detail, `pir runs status` and `pir audit coverage` read the current fields. The M1 evaluation driver does not persist coverage at all — a deliberate eval-side scope decision (a row records findings and cost, and the judge never needs hunk coverage), not a consumer asking the manifest for a different schema. No issue, roadmap item, dogfood finding or ADR requests per-file terminal states or a coverage-gated completion; the only source of that idea is OCR's manifest, and the roadmap's non-borrow list treats parity as optional.

**3. Terminal states are derivable from the existing two fields, cheaply and without ambiguity.** For a file in `changeCoverage.files`: `covered === total` → reviewed; `0 < covered < total` → partial; `covered === 0` → unreviewed. Excluded files are already terminal in `files[]` and are deliberately absent from the coverage denominator (ADR 0004 §4: no unreachable denominator, so full coverage stays achievable) — a second state machine would duplicate that information and create two sources of truth that can drift. The one genuinely missing value, "skipped/not selected", is an audit-mode concept (scope selection); change mode's denominator is the reviewed diff, so there is nothing to call skipped.

**4. Tying `incomplete` to coverage would reverse C1's documented stance.** C1 decided that coverage never gates, suppresses or drops findings; the one intervention is a single forced follow-up round whose focus list is the unread hunks (`unreadHunks` in `src/core/change-coverage.ts`). Making a clean completion depend on coverage would convert a review-quality signal into a correctness gate, change the `incomplete`/exit-code contract that automation already depends on (ADR 0001; `docs/review-loop.md`), and would mark ordinary large reviews incomplete whenever an unreachable hunk exists. That is a product decision with real outward cost, and no consumer has asked for it.

## Decision

**Reject the new contract; keep the existing two additive surfaces.** Do not add a per-file state field and do not gate `incomplete` on change coverage. The documented derivation for automation is: join `files[]` (for exclusion) with `changeCoverage.files` (for hunk coverage), derive reviewed/partial/unreviewed as in Evidence 3, and treat `excluded` as terminal-but-outside-the-denominator. `incomplete` stays tied to actual unfinished work: pending verification, verification execution errors, unfinished discovery, unfinished audit coverage.

## Revisit conditions

- **A real consumer that cannot join the two artifacts:** for example a SARIF/coverage export, a CI consumer or a client that needs one frozen per-file picture from one payload.
- **A shared cross-mode schema:** if web or export clients need change and audit coverage to share one vocabulary, the contract should be designed once for both modes.
- **B1's exclusion vocabulary proves insufficient:** if the existing `excluded` + `excludedReason` pair cannot express a new terminal case, extend that pair rather than adding a parallel state machine.
- If reopened, the shape is additive only: `files[].state` ∈ {reviewed, partial, unreviewed, excluded} on the existing coverage artifact, with no gating of completion.

## Consequences

- No code change; the current manifest/envelope fields stay the contract, and the derivation rule is recorded here so the omission is a decision rather than an oversight.
- The change-mode coverage ledger remains the denominator for the forced coverage round; `incomplete` keeps its existing meaning and exit-code behavior.
- The remaining gap is documentation/discoverability, not schema: automation joins two documented fields, and the join is now written down.

## References

- Roadmap: [`docs/roadmap-ocr-borrow-and-aacr-benchmark.md`](../roadmap-ocr-borrow-and-aacr-benchmark.md) §3 D-B8.
- Companion context: [`docs/ocr-borrow-and-aacr-benchmark-context.md`](../ocr-borrow-and-aacr-benchmark-context.md) §3 (coverage-accounting row).
- B1: [ADR 0004](0004-change-mode-file-filter.md) §4 (excluded ≠ invisible; excluded hunks stay out of the coverage denominator).
- C1: [ADR 0003](0003-findings-quality-roadmap.md) decision 2 (coverage ledger, observational then one forced round).
- Contract: [`docs/for-llm.md`](../for-llm.md) (change-mode coverage), [`docs/review-loop.md`](../review-loop.md) (completion and coverage), `docs/adr/0001-shared-review-executor.md`.
- Implementation: `src/core/change-coverage.ts`, `src/observability/run-events.ts`, `src/changes/change-set.ts`, `src/server/web-store.ts`, `src/cli/runs.ts`.
