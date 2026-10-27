# ADR 0018: Audit resume — input identity and state protocol (S4), discovery only

## Status

**Accepted (2026-10-23), outcome: no-go for now.** Second OCR-borrow series, item S4 (Iteration 4). This ADR records the demand discovery (T0), the input-identity protocol (T1), the state semantics (T2) and the cost estimate with the go/no-go (T3). It ships no code, no schema and no flag: `pir audit` still starts a new run every time and never resumes an interrupted one. Implementation, if demand ever appears, is a separate ADR and PR (decision point D2).

## Context

The docs are explicit about the capability gap. [`review-loop.md`](../review-loop.md#L156-L160) says audit candidates are checkpointed after discovery sessions and that "there is no automatic restart/resume of an interrupted audit"; [`design.md`](../design.md#L155-L163) says the ledger makes progress visible and that "reading stored candidates does not resume them in a later run". A new invocation always creates a new `review_runs` row.

The raw material for a resume exists — for runs produced by recent builds. An audit persists, as it runs: the run row with its target — commit, tree id, selection version, planner version and scope ([`audit-store.ts`](../../src/memory/audit-store.ts#L31-L37), written at run start in [`supervisor.ts`](../../src/core/supervisor.ts#L1159-L1162)); one durable state row per work unit as it transitions ([#38](https://github.com/beiyanpiki/pir/issues/38) incremental flush, [`supervisor.ts`](../../src/core/supervisor.ts#L1230-L1252)); one coverage row per file; and every candidate as a finding row at collection time, updated in place by its verdict ([`supervisor.ts`](../../src/core/supervisor.ts#L1212-L1228)). All of that arrived over time: before the #38 fixes an audit flushed its ledger only at the end, so a run that never finished left findings but no coverage. What is missing is an identity comparison that would let a later invocation trust that state, and a state machine that would let it continue from it.

OCR's protocol is the reference implementation (pinned `375f64c`, `internal/session/resume_identity.go:36-127`, `manifest.go`, `internal/scan/agent.go:550-786`): a run manifest records the input identity, a resume request must match it field by field, and **any** mismatch rejects the whole resume rather than degrading to partial reuse — "mixing results computed from one input with results computed from another produces a report in which no field distinguishes the two". Its checkpoints are per-item fingerprints that are reused or re-dispatched individually.

Two boundaries bound this item. It is discovery, not implementation: no code, no promise of an "L" coverage level, and no coverage-contract change — ADR 0013's single-ledger rule stands. And it must not import OCR's vocabulary wholesale: OCR's coverage item and failure classes are its own contract, not pir's.

## Demand discovery (T0)

**Who runs multi-day audits, and how often.** The record is thin, and it is not empty. A read-only scan of this machine's state on 2026-10-23 (3,217 project databases under `~/.local/state/pir`, 2,334 of them with a `review_runs` table new enough to record a mode; older tables cannot hold an audit because the mode column arrived with it) found 55 review runs, **five of them audits**. All five ran on the night of 2026-09-30 against one private repository (a Go backend project) at a pinned commit: three never finished and produced no findings; one stopped at the default findings cap (10 findings, 19 rounds, 188 units, "690 files unreviewed"); and one ran for about six and a half hours and produced 152 verified findings (139 confirmed, 12 rejected, 1 uncertain) before it stopped without finishing — its row is still `running` today. The deployed instance's 27h47m production audit ([#38](https://github.com/beiyanpiki/pir/issues/38), [#42](https://github.com/beiyanpiki/pir/issues/42)) is a second, separate run. The 200 `audit` submission receipts in `~/.pir/receipts` are integration-test fixtures (`127.0.0.1` origins, `/tmp` worktrees), not usage. So: one operator, two multi-hour audits on record, no routine cadence.

**What happened after an interruption.** The six-hour run is the interruption on record. Nothing in the machine's record says what stopped it: no reboot occurred between 2026-09-02 and 2026-10-19, and the journal shows the operator's SSH session disconnecting at 09:05:49 — ten minutes after the run's last persisted finding (08:55:36), and the machine's model proxy logged a call about forty seconds earlier. The likeliest cause is the process dying with its terminal, and this ADR does not claim more than that. What the operator did next is visible: four audit starts inside 27 minutes the same night (01:55, 01:56, 01:58, 02:21), then the six-hour run at 02:22, and **no audit on that project after it**. Restarting was the only tool available; the six-hour restart was never attempted. The findings survived — they are project-scoped rows, readable with `pir findings list` — and the remaining coverage did not. The audited commit is no longer in the repository's local clone, so nothing could be resumed today even with the feature.

**The incident predates the state a resume would need.** Those five runs were produced by a build older than the #38 incremental ledger: the project database has no `review_runs.updated_at` column (the heartbeat migration), and the four unfinished runs have no work-unit or file-coverage rows at all. The roadmap's premise — "audit candidates and coverage are persisted, so the raw material exists" — therefore holds for runs produced after #38; the one interrupted run on record has findings but no ledger. The shipping order matters: the incremental ledger and heartbeat (#38), the async job contract (#53), run recovery (#48/#49/#60) and the scope preview (#56) all landed after 2026-09-30, so nothing recorded here exercises the post-#38 generation under interruption.

**Is restarting acceptable.** The operator restarted four times in 27 minutes and then did not restart the six-hour run. Both facts point the same way: restarting is accepted when the scope is small, and a multi-hour restart is expensive enough that moving on was the better choice. That is a measured cost — about six and a half hours of provider time, with the rest of the audit's coverage lost — not a stated request. No issue, PR, dogfood finding or message in this repository's record asks for continuing an interrupted audit.

**What the operator can do today instead**, which is why the absence of resume is not a dead end: `audit --dry-run` prices the scope before committing ([#56](https://github.com/beiyanpiki/pir/issues/56)); `--path`/`--skip` cut the run into affordable pieces; `--detach` submits remotely so a client disconnect cannot stop the job ([#53](https://github.com/beiyanpiki/pir/issues/53)) — remote only, which is exactly why the local six-hour run was exposed; and finished findings are recoverable by run URL ([#48](https://github.com/beiyanpiki/pir/issues/48)). None of these continues an interrupted compute, but together they cover the failure modes actually observed.

**Conclusion: one interrupted run is recorded, and demand for resume is still not.** A1 is satisfied by recording both the incident and the absence of a request for the feature.

## Input identity (T1)

An audit's unit plan is a pure function of the pinned snapshot and two version tags: `planAuditUnits` partitions deterministically, and the same inputs reproduce the same unit ids and owned ranges ([`audit-planner.ts`](../../src/core/audit-planner.ts#L53-L139)). That determinism is what would make unit-level reuse possible at all: a resumed run can re-plan and match rows by unit id instead of storing ranges twice.

The compare-and-refuse set:

| Input | Recorded today | Must match to resume? |
| --- | --- | --- |
| Project identity (origin + root commit) | project database location (`projectId`) | yes — a resume is per-project by construction |
| Snapshot commit and tree id | `review_runs.head`, `review_runs.target.treeId` | yes |
| Scope (`--path`, `--skip`) | `review_runs.target.scope` | yes |
| Selection policy | `review_runs.target.scopeVersion` (`FILTER_VERSION`, currently 1, [`filter.ts`](../../src/changes/filter.ts#L25)) | yes |
| Unit planner | `review_runs.target.plannerVersion` (`PLANNER_VERSION`, currently 3, [`audit-planner.ts`](../../src/core/audit-planner.ts#L29)) | yes |
| Reviewer model and thinking level | `run.json.model` only | yes |
| Verifier model and thinking level | `run.json.verifierModel` only | yes |
| Language packs (name, version, activation) | `run.json.plugins[]` only | yes |
| Build and prompt identity | **nowhere** | yes — must be created |
| Project rules (`--rule`, `.pir/rule.json`) | not applicable: audit rejects `--rule` ([`executor.ts`](../../src/cli/executor.ts#L651)) | no |
| User background | not applicable: find-only (ADR 0016) | no |
| `--base`, `--branch`, `--angles`, `--max-rounds` | not applicable: audit rejects them ([`executor.ts`](../../src/cli/executor.ts#L644-L657)) | no |
| Stop policy: `--max-tokens`, wall clock, `--max-findings`, verify settings | flags, partially in `run.json` | no — it changes where the run stops, not what a unit produced |
| Memory pack content | derived at run time from the project database | no — cannot be pinned |
| Codegraph index | derived at run time | no — cannot be pinned |
| Provider sampling | — | no — inherent |

Three consequences follow from reading the table honestly.

**The identity is not all persisted where a resume could read it.** The model, verifier model and language packs live only in `run.json`, and that file is written only when transcripts are enabled (`writeRunManifest` returns early without a transcript directory, [`run-events.ts`](../../src/observability/run-events.ts#L521-L528); `PIR_TRANSCRIPTS` is opt-in on the CLI, enabled by the server, [`transcripts.ts`](../../src/agents/transcripts.ts#L40-L42), [`server.ts`](../../src/server/server.ts#L98)). A resume that trusts `run.json` would therefore work on the deployed server and be unable to verify itself on a local CLI run. Any implementation must persist identity on the run row — or in a resume-state table — before its first resumed session.

**Build identity does not exist yet.** Nothing identifies the prompts, the tool schemas or the supervisor code that produced a run. The M0/M1 drivers solved the analogous problem with a `dist` digest ([ADR 0009](0009-m1-end-to-end-benchmark.md)), and that is the available shape; a package version alone would not catch an uncommitted build.

**The rules hash is excluded on purpose.** The roadmap's T1 lists it because OCR folds rules and the file filter into one aggregate; in pir the rule file is a find-only input and audit sessions carry no PROJECT RULES section, so refusing a resume over it would be refusing over a file that could not have changed the run.

**Refusal is whole, never partial.** If any row above marked "yes" differs, a resume must refuse outright and name the field and both values. Reusing "only the units whose inputs did not change" sounds reasonable and is exactly the failure OCR's check exists to prevent: the output would mix two populations and no field in the report would say which wrote which.

**Two caveats travel with any exact match.** The memory pack is built from mutable project memory at run time, and the optional codegraph index is not part of the pinned snapshot; both change what a reviewer session sees without appearing in the identity table. A resumed run cannot claim byte-identical review context for the units it re-runs. The claim it can make is structural: completed units' findings were produced under the parent identity, and the resumed units under the same pinned snapshot, model and build.

## State semantics (T2)

pir's durable unit vocabulary is `pending | in-progress | reviewed | blocked | failed` ([`coverage.ts`](../../src/core/coverage.ts#L89-L133)); file coverage adds `partial`, `unreviewed`, `excluded` and `notSelected`. There is **no `waived` state**, and this ADR does not invent one: a waiver is benchmark vocabulary (ADR 0003), and ADR 0013 already refused a second state machine over one ledger. A resume protocol has to work with the states that exist.

| Durable state | Resume action | Why |
| --- | --- | --- |
| `reviewed` unit | reuse — do not schedule | Its findings are already rows; re-running would pay again for the same unit. |
| `in-progress` unit | re-run from the start | It was interrupted inside a session, and candidates are persisted only after a session ends, so nothing about it is durable. The attempt counts. |
| `failed` unit | re-run while `attempts < 2` | `DEFAULT_MAX_UNIT_ATTEMPTS` is 2 ([supervisor.ts](../../src/core/supervisor.ts#L150)); past it the run's own semantics would have left it failed. |
| `blocked` unit | stay blocked | A block is a reviewer verdict ("completion claimed without the owned reads"); retrying it silently spends tokens on a unit that already declared it done badly. An explicit retry flag is an open question, not a default. |
| `pending` unit (no row yet) | schedule | The flush only writes transitions; an untouched unit has nothing to read. |
| candidate rows (`status = 'candidate'`) | re-verify, never re-discover | The row carries claim, severity, category, entity, anchors and fingerprint; the shared verification drain consumes it as-is. |
| verified rows | reuse; recount | `confirmed` / `rejected` / `uncertain` counters must be rebuilt from rows, not from an in-memory state that no longer exists. |
| dedup `known` set | seed from the run's candidate rows | It is in-memory only. On resume it must be rebuilt by fingerprint so a defect found in the remaining units still collapses against completed ones. |
| `attempts` | carry per unit | Persisted on the unit row; the cap must span the resume boundary, or a unit that crashes the process can retry forever. |
| `--max-tokens` spend | carry | Measured usage is not in the database today. A ceiling that silently doubles on resume is not a ceiling; carrying it requires persisting usage, which is another reason identity and state belong on the run row. |
| wall clock | restart | It measures one process, and the resumed process is a new one. |
| the run row | continue the same run | A resumed audit must remain one run with one coverage ledger and one identity. A second row would split one audit across two identities and make "how much of the scope was reviewed" ambiguous. |

Pending candidates are the case with an easy wrong answer: re-verifying is right because the candidate's evidence is already fixed and a verdict costs one verifier session, while re-discovering the same unit costs a full reviewer session and may find something else instead. The reverse — reusing verdicts for rows the run never verified — is not possible, because a verdict is written to the row it was rendered for.

**A run with no ledger is the hardest case**, and it is the one on record: no unit rows, no coverage rows, only findings. A resume there can re-plan (the plan is deterministic) and reuse the verified findings, but it cannot know which units were already reviewed, so every unit would be reviewed again — the same work, with duplicate-finding dedup as the only saving. Rendering that as "resumed" would be a lie about coverage. The honest behaviour for a pre-ledger run is a refusal, or an explicit findings-only recovery that starts a new run and says so.

## Cost estimate (T3)

An implementation would need: one schema migration persisting identity and measured usage on the run row (or a resume-state table); a supervisor change that seeds the audit loop from persisted rows instead of an empty state and checks identity before opening any session; a CLI surface (`audit --resume <run-id>` or `--latest-interrupted`, plus the serve/job equivalent); and tests for plan determinism, the refusal matrix per identity field, the state matrix above, dedup seeding, budget carry-over, a simulated crash-and-resume, and a no-resume path that is byte-identical to today's behaviour. Rough size: two PRs, ~500–800 lines plus tests. The risk is not the schema — it is converting `auditIssues`'s in-memory state into a reconstructible machine without changing how an ordinary run behaves.

The payoff is bounded by the demand: the one recorded interruption lost about six and a half hours of audit time, and the findings it had produced were already safe. What resume would have added is the remaining coverage — for a run that, as it happens, could not have supplied the ledger such a resume needs.

## Decision

**No-go for now: do not implement audit resume.** Decision point D2's trigger — "S4 T0–T2 show real demand and an agreed identity/state protocol" — has half fired: the protocol is agreed and written here, the demand is one incident and no request. Three facts decide it:

1. **The recorded interruption most likely died with its terminal, and a cheaper remedy exists for exactly that.** A local audit outliving the shell that started it is a durability problem, not a state-machine problem: keeping the process alive across a disconnect (or offering local detached execution, which today is remote-only, [#53](https://github.com/beiyanpiki/pir/issues/53)) would have prevented the loss outright, and costs a fraction of this protocol. Resume only salvages what remains after a process has already died.
2. **The incident predates the state resume would use.** No ledger rows, no heartbeat column, a run from before #38. The capability gap the roadmap describes is real today, but it was not this run's gap; no post-#38 interrupted audit is recorded.
3. **No request exists.** The issues about long audits ask for delivery, recovery and a scope preview — all shipped — and none asks to continue an interrupted run.

Nothing in this ADR changes current behaviour: `pir audit` still starts a new run, `incomplete` keeps its meaning, exit codes are untouched, and the completion contract of ADR 0013 stands. Any future implementation would be an explicit `--resume <run-id>` on the same project database — never an implicit continuation of a plain `pir audit`, because a resume that can start silently is a resume nobody verified.

What the ADR does change is the cost of a future yes: the identity comparison, the state mapping, the two persistence gaps (identity and usage on the run row, build identity anywhere) and the pre-ledger refusal are written down, so a later go starts from a protocol instead of re-deriving one.

## Revisit conditions

- **A post-#38 interrupted audit.** An audit produced by a build with the incremental ledger that stopped mid-run — process death, not a findings cap — whose operator wanted to continue. This is the trigger the recorded incident cannot supply, because that run predates the ledger.
- **A process death detached execution cannot prevent.** A server restart, OOM kill or crash that ends a detached job (or any run the client is not holding open). The 2026-09-30 loss is explained by terminal-bound execution; a death that detached execution does not cover is a different failure.
- **A user or automation request.** An issue, PR or dogfood finding that asks for continuing an interrupted audit, as opposed to recovering a finished one.
- **If any of them fires:** a separate implementation ADR and PR, following the identity and state protocol above, refusing partial reuse and pre-ledger runs, adding no unit state, and keeping completion/exit semantics unchanged.

## Consequences

- No new schema, flag, command, state or model call; the documented behaviour — "no automatic restart/resume of an interrupted audit" — stays true and is now backed by a decision instead of an omission.
- An interrupted audit still restarts from zero. The price is written down here, and the cheap mitigations (dry-run pricing, scoped runs, detached submission, run-URL recovery) are named so the absence of resume is not mistaken for an absence of options.
- The next investment this discovery points at is **local durability**, not resume: a local audit that survives its terminal. `--detach` is remote-only today, which is why the recorded loss happened. That is a separate item and not part of this ADR.
- The protocol is reusable: identity fields, refusal rule, state mapping, the pre-ledger case and the two persistence gaps are recorded in the place a future implementation would look first.
- OCR's resume identity and checkpoint mechanism stay deliberately unborrowed; the next move is justified by a recorded incident of the right kind, not by parity.

## Acceptance mapping

- **A1 — discovery answers recorded, including "no demand recorded".** Demand discovery above records five audit runs from 2026-09-30 — one of them a six-and-a-half-hour run with 152 verified findings that never finished — and records that no request for continuing an interrupted audit exists. Demand is one measured cost, not a stated need.
- **A2 — identity and state protocol written.** The compare-and-refuse table, the whole-refusal rule, the two caveats, the durable-state mapping and the pre-ledger refusal case, all against the current schema.
- **A3 — go/no-go recorded; implementation is a separate ADR/PR.** Go/no-go is **no-go**; D2 remains untriggered; implementation would need its own ADR and PR.

## References

- Contract today: [`review-loop.md`](../review-loop.md#L146-L176), [`design.md`](../design.md#L155-L163), [`for-llm.md`](../for-llm.md) (run recovery, `checkpoint.json`).
- Implementation surfaces: [`audit-store.ts`](../../src/memory/audit-store.ts) (target, unit/file ledgers), [`audit-planner.ts`](../../src/core/audit-planner.ts) (`PLANNER_VERSION`), [`filter.ts`](../../src/changes/filter.ts) (`FILTER_VERSION`), [`supervisor.ts`](../../src/core/supervisor.ts) (`auditIssues`), [`coverage.ts`](../../src/core/coverage.ts) (unit states), [`run-events.ts`](../../src/observability/run-events.ts) (`RunManifest`), [`findings/dedup.ts`](../../src/findings/dedup.ts) (the `known` set).
- Related decisions: [ADR 0013](0013-change-coverage-manifest-decision.md) (one coverage ledger, no second state machine), [ADR 0012](0012-session-audit-enhancements-decision.md) (no recorded demand is a legitimate reason not to build), [ADR 0009](0009-m1-end-to-end-benchmark.md) (dist-digest build identity), [ADR 0016](0016-user-background-for-find.md) (find-only inputs).
- External mechanism: OCR `alibaba/open-code-review` @ `375f64c` (Apache-2.0), `internal/session/resume_identity.go:36-127`, `internal/session/manifest.go`, `internal/scan/agent.go:550-786`.
- Sources for the demand evidence: the machine's audit rows and journals scanned read-only on 2026-10-23; [#38](https://github.com/beiyanpiki/pir/issues/38), [#42](https://github.com/beiyanpiki/pir/issues/42), [#56](https://github.com/beiyanpiki/pir/issues/56), PR [#60](https://github.com/beiyanpiki/pir/pull/60).
