# ADR 0003: Findings-quality roadmap — evidence-gated verification, deterministic parallelism, ReviewBench as a local benchmark

## Status

Proposed (2026-10-09; process paragraph, acceptance clause, and the
Decision §3 measurement amendment dated 2026-10-10, see below). This ADR landed with the plan-only PR that
introduced the roadmap (D1, #74); the implementation is specified in
[docs/plans/findings-quality-roadmap.md](../plans/findings-quality-roadmap.md)
— a development record that is deleted once the series completes — and
arrives as ordinary PRs against `dev`, tracked in issue #73 (the original
D1-rooted stacked-PR convention was retired when D1 merged). Each item of
the decision is binding for that series; items may be individually
reverted with evidence from the benchmark, in which case this ADR is
amended.

Acceptance (amended for the B1-baseline deferral — maintainer decision
recorded in #73): status moves to Accepted once Q1–Q3 have landed under
the scenario-harness variance gate and the pre-F1 ReviewBench baseline
era has opened with F1's A/B rows non-regressing. Per-PR ReviewBench
rows for slices merged before the baseline are waived by the deferral —
the baseline's dev build already contains those slices, so their
individual effect is not isolable after the fact; their measurable gate
is the scenario harness.

## Context

A survey of production review agents (Codex `review`, Claude Code
`/code-review`, Greptile, CodeRabbit, Copilot code review, pr-agent) and of
harness subagent architectures (pi's official subagent example,
tintinweb/pi-subagents, OMO, DSH, Codex CLI, Claude Code, Gemini CLI,
Cursor, Amp, Goose) produced four load-bearing findings:

1. **Review converges on flow-driven orchestration.** General-purpose agent
   work is model-driven everywhere, but `codex review` is a Rust-orchestrated
   thread with a fixed rubric, Goose rewrote `goose review` as deterministic
   subprocess orchestration after model-driven dispatch became "the dominant
   source of variance between runs (16s best case, 60s+ worst)", and Claude
   Code runs `/code-review` as a fixed finder→verifier pipeline. pir's
   supervisor-only orchestration (no model-facing spawn tool, isolated
   read-only sessions) already sits on that convergence point.
2. **Most false positives are context failures.** Mining of 31k developer
   feedback pairs on agentic review bots attributes ~87% of rejected
   findings to context failures (43% misreading the code under review, 43%
   missing system design), not reasoning failures. The consistent fix
   across vendors is an explicit do-not-report policy plus verification
   that gathers *new* evidence rather than re-opining (self-critique
   without external evidence measurably hurts accuracy).
3. **Narrow-scoped finders beat one general reviewer.** Greptile's v5
   single-hypothesis agent swarm (1M+ production PRs A/B) halved median
   review time and raised comment-address rate from 52% to 66%; diff-only
   detection passes empirically outperform context-stuffed ones (all eight
   frontier models degraded monotonically as context was added —
   SWE-PRBench).
4. **A calibrated open benchmark exists.** GitHub's ReviewBench (MIT) ships
   219 real PRs with human-labeled golden findings (severity, category,
   `introduced-by-pr` scope, `diff-only` context requirement), frozen repo
   mirrors, a local runner, and a locally runnable judging CLI whose metrics
   match the leaderboard's.

pir's current gaps, in code: change mode has no coverage accounting (only
audit does), verification drains are strictly serial, the verifier can
submit a verdict without having read anything this session, historical
decision matching does not generalize across entities, and reported
findings carry no confidence downstream. A measurement harness exists —
`tests/eval/` scores human-labelled synthetic scenarios (regex + location
labels, positive and negative expectations, paired baseline/candidate CLI
runs with repeats) — but it is synthetic by construction: small fixtures,
no real-world PR diversity, no severity/category-stratified recall against
human consensus. It cannot tell us how pir compares on the corpus
production review agents are judged on.

## Decision

1. **Stay flow-driven.** No model-facing spawn/delegation tool is added to
   reviewer or verifier sessions. Parallelism and specialization land as
   supervisor-side deterministic orchestration (worker pools, angle fan-out),
   preserving budget accountability, reproducibility, and the existing trust
   boundary.
2. **Adopt the eight-item roadmap** (details and PR slicing in the plan
   document):
   - prompt hardening: explicit do-not-report blacklist (mode-specific:
     change mode keeps the introduced-by-diff gate, audit must not have it)
     and P0 severity calibration;
   - bounded parallel verification drain (`verifyConcurrency`, default 1,
     hard cap 8, in-flight reservation against `maxFindings`);
   - an evidence gate on `submit_verdict`: a verdict is rejected at the
     tool boundary when the verifier session gathered no pinned reads or
     evidence calls, and (second stage) the rationale must cite an anchor
     actually read this session;
   - ReviewBench as the local benchmark harness: vendored 25-task test set,
     mirror-fetch runner, findings normalizer, deterministic pre-filter,
     judge delegation — **local evaluation only**, extending (not replacing)
     the existing synthetic scenario harness in `tests/eval/`;
   - a change-mode diff coverage ledger reusing the audit `readObserver`
     seam, observational first (manifest/round reporting), interventional
     later (forced follow-up round on unread hunks);
   - observational memory-denoising generalization: cross-entity
     similar-dismissed counts as verifier context only — suppression still
     requires the verifier's explicit `stillApplies` endorsement of a
     matched decision;
   - small knobs: persisted verifier confidence with a `--min-confidence`
     reporting split (bucketing, never deletion, no maxFindings refund), a
     deterministic run-level verdict (`incorrect` /
     `correct-with-findings` / `correct`), and a separate verifier model
     option;
   - multi-angle finder fan-out behind a default-off flag, gated on the
     benchmark showing recall gains without precision loss.
3. **Measure before and after, on two surfaces.** The existing scenario
   harness (`tests/eval/`) is the cheap regression gate — every behavioral
   PR runs it against the baseline build. The ReviewBench harness is the
   real-world gate: a baseline on the current `dev` is recorded before
   behavioral changes merge, and each behavioral PR records a delta row.
   Changes that cannot beat their regression risk on both surfaces are
   reverted or stay default-off.
   *(Amended 2026-10-10, maintainer decision in #73: the ReviewBench
   baseline is deferred until before F1 — pre-baseline behavioral slices
   merge on the scenario-harness gate alone and their per-PR ReviewBench
   rows are waived; the delta-row regime resumes from the baseline
   onward. The amended acceptance clause in Status states the gate.)*
4. **ReviewBench is adopted for local evaluation only.** Leaderboard
   submission, the docker agent contract (`AGENT_CONTRACT.md`), and portal
   onboarding are explicitly out of scope. Corpus metadata and golden files
   are vendored under MIT with attribution; the judge runs on our
   credentials against our normalized output; results are internal.
5. **No invariant is weakened.** The candidate→verifier loop, memory key
   scheme, CLI stdout/exit-code contract, and read-only session isolation
   are untouched. Every new knob is default-off or
   preserves-current-behavior-by-default (`verifyConcurrency=1`,
   `minConfidence=0`, angles off).

## Consequences

- **Positive:** precision work targets the measured FP root cause; the
  drain wall-clock drops ~3–4× at C=4 without semantics change; recall and
  precision become numbers instead of impressions; the memory system gains
  a team-noise learning channel that cannot silently suppress findings.
- **Negative:** the benchmark spends real model tokens per task (budgeted
  per run, subset-first protocol); parallel verification can overshoot the
  token budget by up to C−1 sessions (tolerated by the documented
  budget-check semantics); angle fan-out multiplies discovery cost when
  enabled; vendored benchmark data adds a license-attributed fixture
  directory that must be kept in sync with upstream releases.
- **Neutral:** golden-set coverage (~1.6 findings/PR, 52% low severity)
  means the benchmark weights precision over recall; run-to-run variance
  must be reported (two runs minimum) rather than hidden.
