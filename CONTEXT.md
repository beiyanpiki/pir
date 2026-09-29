# Project context — pir domain vocabulary

A glossary of the terms this codebase uses. Implementation details live in
[docs/design.md](docs/design.md); this file only fixes what words mean.

- **Change review (find)** — a review whose findings must be *introduced or
  unmasked by* a specific change range. The verifier checks realness and
  attribution.
- **Audit** — a review of a single pinned snapshot asking *"what is broken
  now?"*. No attribution: a long-standing defect is in scope because it
  exists today. Age is never counter-evidence.
- **Snapshot (RepoSnapshot)** — one immutable committed revision plus its
  tree inventory (paths, blob ids, classifications). The coverage
  denominator for audits; never the working filesystem.
- **ReviewTarget** — what one review run examines: a *change target* (a
  ChangeSet with base/head/merge-base) or an *audit target* (a Snapshot with
  a scope). Decides the epistemic contract of reviewer and verifier.
- **Work unit** — a bounded, deterministic slice of an audit's scope
  (module group, possibly line-range chunks of oversized files) that owns a
  set of files. Scheduling granularity, not a review engine.
- **Owned file vs context file** — owned files carry the audit obligation
  for a unit; context files may be read freely for understanding but never
  count as reviewed.
- **Coverage** — per-file process accounting for audits: `reviewed`,
  `partial`, `unreviewed`, `blocked`, `failed`, `excluded`, `not-selected`.
  "Reviewed" means the allotted sessions completed with pinned reads of the
  owned files — it is not a promise that every defect was found.
- **Incomplete** — a run that did not finish all of its work (pending
  candidates, verification errors, non-terminal coverage). Incomplete runs
  must surface as such, never as a clean result.
- **Candidate / verified finding** — a reviewer hypothesis vs a finding that
  passed an independent verifier session.
- **Prior decision (IssueMemory)** — a recorded user verdict over a finding
  (`expected`, `false-positive`, `accepted-risk`, `wont-fix`, …).
  Suppression is conditional: it applies only when the verifier re-validates
  the decision against current code, so drift reopens findings.
- **Memory pack** — the bounded, evidence-framed knowledge excerpt a
  reviewer session receives. Issue decisions are deliberately excluded from
  it (verifier-only).
