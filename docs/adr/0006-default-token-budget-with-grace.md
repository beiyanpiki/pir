# ADR 0006: Default token budget with graceful truncation

## Status

**Accepted (2026-10-19).** The default token budget decision of the 2026-10 OCR-borrow series (P0):
`pir find` gets default per-role token ceilings and a controlled
truncation path, without changing the incompleteness or exit-code
contract. This ADR supersedes the "no default token budget" policy that
commit 82505f9 established (see Context).

## Context

`pir find` opens a fresh reviewer session per round and one verifier
session per candidate, and charges every session's measured usage into a
single `Budget` (`src/core/budget.ts`). Until now that budget carried
exactly one optional token ceiling — `--max-tokens` — and no default:
commit 82505f9 removed the last default cap on purpose ("different
problems need different amounts, so the review runs until
rounds/findings/wall-clock stop it").

Two things changed that trade-off. First, the failure mode is asymmetric:
an unbounded run over a large change set spends real money silently, and
the operator learns about it from a bill rather than from the run.
Second, the borrow target is not a kill switch but a *controlled
truncation*. OCR's run-level budget ends a review by skipping
over-budget work while letting in-flight work finish — overshoot bounded
by concurrency — and derives its terminal state from coverage, never from
warnings, with a grace round as the explicit model: after
rounds or budget are exhausted, one final round still collects comments
(`internal/llmloop/loop.go`: `RunMainTask` :380, grace round :564).
Their per-prompt 80% gate and three-zone in-session compression
(`internal/llmloop/compression.go`: thresholds :21-31, partitioning
:132-163, anchored to `MAX_TOKENS=200000` input) solve a different
problem and are deliberately not borrowed: each pir round is a fresh
isolated session, so the long-conversation bloat that compression exists
to manage structurally does not exist here. OCR citations in this ADR are
against `alibaba/open-code-review` @ `8eb8334` (Apache-2.0).

A budget checked between sessions can only refuse new work or finish work
already started, and the pre-budget drain did neither cleanly: it refused
further admissions the moment `Budget.exhausted()` was true, so a run
crossing a ceiling mid-drain abandoned candidates it had already paid
discovery for — the worst of both worlds, and what "controlled
truncation" exists to avoid.

## Decision

**Default ceilings, find only.** `find` starts with two tunable
constants in `src/core/budget.ts`:
`DEFAULT_FIND_REVIEWER_INPUT_TOKENS = 1_200_000` and
`DEFAULT_FIND_VERIFIER_INPUT_TOKENS = 800_000`. They are ceilings, not
targets (the `--max-findings` doctrine): nothing is padded to reach them.
Audit keeps its pre-budget semantics with **no** default ceiling — its
`Budget` is built without role ceilings, and a regression test pins that
a future refactor cannot silently cap a multi-day sweep. The split is
deliberate: `find` reviews one change range with a bounded candidate
queue; an audit's unit count is a function of repository size, which the
user chose.

**Accounting: prompt-side input tokens.** Each session's charge is
attributed to its role (reviewer or verifier) and measured as
`inputTokens + cacheReadTokens + cacheWriteTokens`. The SDK buckets are
disjoint and `inputTokens` is *uncached* input only
(`src/agents/session-factory.ts`), so charging `inputTokens` alone would
let a caching provider move prompt volume out of the ceiling without
changing what the model read. Output tokens are excluded; the ceilings
describe reading cost. Estimated fallbacks are attributed the same way.

**Grace: finish verifying what was found.** A hit on either default
ceiling starts no new reviewer round, but every candidate already pending
still goes through the verification drain — even when the verifier
ceiling was already crossed, and even when the backlog outlives the
drain's per-round cap (the loop keeps running drain-only rounds until the
queue is empty, and the ceiling, not the round limit, is the reason it
reports). That bounded overshoot is the point: the discovery spend is
sunk, and a candidate left unverified is a run that paid twice for one
answer. The drain's admission gate therefore consults only the *hard*
ceilings (see below) while the between-session gate consults all of them.

**An explicit `--max-tokens N` stays hard.** The user's own ceiling
keeps today's exact semantics: measured-total-token accounting, checked
between sessions, refusing new admissions mid-drain, in-flight
verifications still landing. Two reasons: an explicit number is a promise
the operator chose, and the flag must keep one meaning across `find` and
`audit`. Supplying it replaces the default ceilings rather than
stacking with them. The three existing tests that pin the hard-stop
behavior (`tests/integration/parallel-drain.test.js`,
`tests/integration/review-loop.test.js`) stay green unchanged.

**`--max-tokens unlimited` is the explicit opt-out**, mirroring
`--max-findings unlimited` (#57): it parses to `null` and disables every
token ceiling, restoring the 82505f9 policy for a run that needs it (risk
R2's escape hatch). It also names a silent-cap trap: with defaults in
force, omitting the flag no longer means "unbounded", so the ReviewBench
runner's "unlimited" mode now passes it explicitly
(`tests/eval/reviewbench/run-rb.js`) — as must any external caller.

**Unchanged contracts.** `incomplete` is computed exactly as before — a
budget stop with un-reviewed work is still incomplete, pending candidates
and verification errors still count — and the exit-code contract
(0 / 1 / 3) is untouched. A budget stop is a controlled truncation, not a
failure: the run still persists findings, rounds, and a status.
`stoppedBecause` names the ceiling that was hit ("reviewer
token budget exhausted (… of 1200000 input tokens)", "verifier …",
"token …" for the explicit ceiling, "wall-clock …"), never a generic
round-limit string, and the manifest and outcome carry the same fact
structurally as `budgetStop: { kind, reason }` (schema version stays 1;
additive field).

**Tightening the constants.** The values may only be *tightened*
after checking them against the end-to-end benchmark's per-PR token distribution, recorded as
an amendment to this ADR — not a knob to tune by feel.

## Consequences

- A large-PR run that would previously have run unbounded now stops at a
  ceiling, finishes its backlog, reports incomplete when the reviewer
  wanted more, and exits 3 under a `--fail-on` gate.
- A run can overshoot the verifier ceiling only by the pending queue it
  already had: work already paid for, never new discovery.
- Because the ceilings are measured between sessions, one in-flight round
  can still overshoot in a single step — the pre-existing "checked between
  sessions" contract, and why the defaults sit well above a typical
  two-round run. The round-1 angle fan-out keeps its explicit-budget-only
  shrink guard; making the defaults shrink it is future work if the end-to-end benchmark shows
  it matters.
- The Pi extension lane parses `--max-tokens` with the same contractual
  parser as the CLI (`extractMaxTokens`), so the opt-out is reachable from
  `/review-find` (which previously ignored the flag) and `/review-audit`.
- Users who want 82505f9's policy back pass `--max-tokens unlimited`
  (scriptable, per run); a different bounded budget is an explicit
  `--max-tokens N`. The defaults are a product decision under revision,
  not a measured optimum: until the end-to-end benchmark's per-PR token distribution lands,
  1.2M/0.8M are informed guesses with a tightening protocol and an
  escape hatch.
