# ADR 0001: One target-aware review executor for change and audit modes

## Status

Accepted (2026-09-29, full-repository audit feature).

## Context

`pir find` reviews a change range: findings must be *introduced by* the diff.
A full-repository audit has different semantics — a defect is reportable
because it exists at the current snapshot, however long it has existed — and
different economics: one reviewer session cannot hold a whole repository.
The first design sketch proposed a separate `auditIssues` loop over batched
modules; review of that sketch flagged the risk that every future review
flavor (security audit, dependency audit, …) would fork its own supervisor,
duplicating budget accounting, dedup, verification draining and suppression
semantics until the copies drift.

## Decision

Both review modes run through **one** executor in `src/core/supervisor.ts`:

- `ReviewTarget` (`core/review-target.ts`) is a discriminated union:
  `change` wraps a resolved `ChangeSet` (base/head/merge-base, attribution
  semantics); `audit` wraps a pinned `RepoSnapshot` (current-state
  semantics, no comparison revisions, root commits valid).
- Verification orchestration is single-sourced in `drainVerifications` and
  used by both loops; so are `ReviewState`, `Budget`, dedup and
  `applyVerdict` (including the trusted-decision suppression contract).
- Audit scheduling is *only* a work-unit queue (`core/audit-planner.ts`)
  feeding the shared machinery — never `findIssues` per chunk, never a
  second verification path.
- An audit must not fabricate a comparison: no empty-tree diff, no
  `base = head`, no root-commit diff pretending to be a snapshot.

## Consequences

- New review flavors become new targets/planners plus prompt builders, not
  new supervisors.
- `find` behavior is unchanged (its whole regression suite passes untouched)
  because the change path kept its exact loop and the shared pieces were
  extracted from it.
- Audit-specific concerns (coverage ledger, unit completion validation,
  checkpointed candidate persistence) live beside the scheduler, not inside
  the change loop.
- Language-pack guidance is currently change-mode-specific; audits detect
  and report packs but withhold their guidance until audit-aware variants
  exist, rather than demanding diff attribution inside audit prompts.
