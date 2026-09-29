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
- **Run (review run)** — one review request: a `review_runs` row with its
  own run id, verdicts and (when transcripts are on) a transcript directory.
  The unit the web UI pages over; distinct from the sessions inside it.
- **Session transcript** — the settled SDK message dump (prompt, thinking,
  tool traffic, usage) of one reviewer/verifier session, written under
  `<stateRoot>/<projectId>/transcripts/<runId>/`. Final messages, not a wire
  capture; compaction may have replaced earlier context.
- **Run manifest (run.json)** — the persisted counterpart of the stdout
  envelope (rounds, plugins, usage, files/coverage) written next to a run's
  transcripts, so finished runs are renderable without re-running anything.
- **Run event** — the live observation record (run/session lifecycle,
  streaming deltas, tool results) emitted by the supervisor into a
  process-local bus; buffered by the serve web registry, never persisted.
- **Live run** — a run executing inside a given `pir serve` process; only
  such runs can stream to the web UI. Runs from other processes (e.g. local
  CLI invocations) appear only after they finish, via their transcripts.
