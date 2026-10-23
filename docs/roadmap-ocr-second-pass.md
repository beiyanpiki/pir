# Roadmap: OCR second-pass borrowings — feedback, calibration, attention, recovery (temporary tracking)

> **⚠️ Temporary tracking artifact: delete this file once every item below is ☑ or ✗, and fold the surviving content into `docs/adr/`.**
> This file is the execution tracker for the second OCR deep dive (2026-10-22). It is not a research companion:
> the evidence each ADR needs is in §2–§3, and each ADR absorbs what it needs at execution time.
>
> **Deletion preconditions:** (1) every executed item's ADR is merged under `docs/adr/`, numbered in sequence;
> (2) any measurement result is persisted under `tests/eval/aacr/results/` or in the ADR that cites it;
> (3) the non-borrow decisions in §6 are recorded in the relevant ADR or in a successor document;
> (4) no code comment, doc, or test links to this file.
>
> **Status legend:** `☐ not started` · `◐ in progress` · `☑ done` · `⏸ parked (reason noted)` · `➜ decision point (awaiting data)` · `✗ rejected (trigger did not fire; ADR linked)`
>
> **ADR rule:** each item writes its ADR (Status: Proposed) when execution starts and flips it to Accepted when
> the implementation PR merges; numbering continues at **0014**. This file tracks execution; it does not replace
> the ADR.
>
> **Research basis:** `alibaba/open-code-review` @ `375f64c` (Apache-2.0), compared with the first series'
> pinned `8eb8334`; pir baseline `9de892a` (this branch). No architectural change landed upstream between the two
> revisions: language allowlist and rule-doc entries, MCP `tools/list` pagination, scan path resolution, the
> empty `code_comment` batch fix (#1773), small git/ignore fixes, and PR policy. The empty-batch fix is the
> direct precedent for S5.
>
> **Update rule:** check off each task as it completes and append a row to §8; when status and reality diverge,
> code wins — fix this file immediately.

---

## 0. Why a second pass

The first series (B1–B5, ADRs 0004–0010) borrowed OCR's **hard-constraint skeleton**: the file filter,
snippet-anchored location correction, the default budget with grace, structured rejection grounds, and the
layered rule file. That work is done and is not re-litigated here.

This pass asks what remains after the skeleton. The honest answer is narrower than the first draft claimed:

- **Confirmed code facts:** the duplicate-feedback gap (S5), and the absence of an explicit background contract (S2).
- **Hypotheses:** schema field order influencing verifier decisions (S1), and per-file attention prompting (S3).
- **A capability gap with unproven demand:** audit resume (S4).
- **Separate engineering/distribution work:** SARIF and rule introspection (S6/S7).

The guiding principle stays the first series': **measured gaps, not parity.** A hypothesis enters this file as
an experiment with a stop rule; it does not enter as a committed quality fix. Evidence levels used below:

| Label | Meaning |
| --- | --- |
| `code fact` | Verified in the current source; no model behaviour assumed. |
| `data signal` | Measured, but small samples or a confounded population; directional only. |
| `hypothesis` | Plausible mechanism; unproven for this repo, provider, or tool. |
| `product direction` | A missing input/feature; benefit and demand not yet measured. |

---

## 1. Iterations and execution order

| Iteration | Items | Definition of done |
| --- | --- | --- |
| **Iteration 1 — contract clarity** | S5, S1 (diagnostic only) | S5 merged with tests; S1 diagnostic proves the schema order that reaches the SDK/provider, and the M0 experiment is either scheduled or explicitly declined. |
| **Iteration 2 — calibration experiment** | S1 (M0 experiment) | The M0 point comparison (with repeats) is recorded; the item is either adopted with a pre-registered signal or closed as ✗. |
| **Iteration 3 — input experiments** | S2, S3 (independent) | Each has its own ADR, tests and dogfood notes; neither is bundled with the other. The M1 benchmark's locked 50-PR baseline is not changed by either without a separate round. |
| **Iteration 4 — recovery discovery** | S4 | Discovery answers and an identity/state protocol are written; go/no-go recorded. No implementation before go. |
| **Track B — distribution/UX** | S6, S7 | Demand-driven; never blocks Iterations 1–4; no model cost. |

**Execution order (not item numbers):** S5 → S1 diagnostic → S2 and S3 as separate experiments → S1 M0
experiment when budget allows → S4 discovery → S6/S7 on demand.

---

## 2. Evidence base (draw from here when writing an ADR Context)

### 2.1 M0 verifier surface (offline, fixed sample)

Source: [RESULTS.md](../tests/eval/aacr/results/RESULTS.md), round `2026-10-19-m0-full-glm`
(`zai-coding-cn/glm-5.3:max`, n = 2,012; 1,410 label-1 / 602 label-0).

| Arm | killRate | falseKillRate | interceptPrecision | accuracy / precision / recall / F1 |
| --- | ---: | ---: | ---: | --- |
| pir verifier | 82.7% | 72.0% | 32.9% | 44.3% / 79.1% / 27.9% / 41.3% |
| OCR reflection prompt | 8.0% | 3.0% | 52.7% | 70.3% / 71.1% / 96.9% / 82.0% |

**Caliber caveat (load-bearing for §6):** these are different tools on the same offline material. The OCR arm is
the reflection prompt applied to supplied comments, not the OCR reviewer, and the pir verifier in live mode can
read the repository while M0 feeds only diff + file. The percentages support **"the reflection filter's removal
surface is small on this material"**; they do **not** establish verifier cost savings, online false-kill rates,
or a quality ranking between the two systems.

### 2.2 M1 end-to-end surface (locked 50-PR subset)

Source: [M1-2026-10-20-baseline-glm.md](../tests/eval/aacr/results/M1-2026-10-20-baseline-glm.md).

- 49/50 instances evaluated; one unfetchable head in upstream `missing_instances`; 102 findings.
- `balanced_score` 0.1663 reported / 0.1647 confirmedOnly; precision 32.1% / recall 11.2%.
- 129.9M session tokens; 2.65M total tokens per produced row; 19.5 min mean reviewer wall time.
- Buckets relevant to S3: `≥500` lines = **4 PRs / 72 references / recall 6.9%**; `50–199` lines =
  **20 PRs / 100 references / recall 8.7%**; maintainability references = 172 / recall 5.8%.

**Caliber caveat:** the `≥500` bucket is only four PRs. The equally weak `50–199` bucket (20 PRs) shows the
recall issue is not specific to large PRs. The reference population is maintainability-heavy, and pir deliberately
de-emphasises that category (Q1 blacklist / F1 angles), so no single intervention is expected to fix
`balanced_score` alone.

### 2.3 OCR mechanisms cited by this roadmap

| Mechanism | OCR source (pinned `375f64c`) | Evidence level |
| --- | --- | --- |
| Reason-before-decision tool schema | `internal/agent/agent.go:1572-1597` (the two filter tools; a different tool and task from `submit_verdict`) | hypothesis |
| Background context, bounded and delimited | `cmd/opencodereview/background_file.go:15-118`; `prompts/main_task_user.md:12-14`; `prompts/plan_task_user.md:10-14` | code fact / product direction |
| Per-file attention and reply limit | `prompts/main_task_system.md:16-23`; `prompts/main_task_user.md:1-8` | code fact in OCR; effect in pir unproven |
| Plan phase (decision point only) | `internal/config/template/template.go:61-79`; `internal/agent/agent.go:1403-1430`, `:1467-1471` | hypothesis; do not start without D1 trigger |
| Empty/no-op submission must error | `internal/tool/code_comment.go:50-51,69-71`; commit #1773 | code fact |
| Resume identity and checkpoints | `internal/session/resume_identity.go:36-127`; `manifest.go`; `internal/scan/agent.go:550-786` | code fact in OCR; protocol complexity high |
| SARIF output | `cmd/opencodereview/sarif.go` | code fact |
| Rule introspection | `ocr rules check` (CLI reference) | code fact |

---

## 3. Items

### S5 · Visible duplicate feedback in `record_candidate` · P1 · evidence: `code fact` · ADR: [0014](adr/0014-duplicate-feedback-in-record-candidate.md) · Status: ☑

**Why.** [`record_candidate`](../src/tools/collector-tools.ts#L182-L189) validates and pushes every candidate,
then returns `Recorded candidate F-X`. Duplicates are resolved later by
[`deduplicateCandidates`](../src/findings/dedup.ts#L36-L89) in the supervisor (cross-angle included at
`{ crossAngle: true }`). The model therefore receives a confirmation that does not distinguish "new distinct
defect" from "overlaps an existing finding". This is a **feedback gap**, not a lost-record bug: the candidate is
still recorded, and severity-upgrade semantics must remain.

**Scope guard.** Do not change dedup behaviour, candidate storage, displayId assignment, or the reporting cap.
Do not claim "will not count". Do not block submission.

**Tasks**

- [x] **T0 Write the ADR.** Define the comparison boundary: prior-round `state.known` plus the same reviewer
      session's collector; cross-angle and same-round other-session duplicates stay supervisor-only. State that
      the hint is visibility-only and severity upgrades are preserved.
- [x] **T1 Wording.** Use a sentence that keeps the candidate actionable, e.g.:
      `Accepted and recorded for deduplication. It overlaps an existing finding (F-12) by fingerprint/claim.
      If it is materially different, state the difference in the claim/trigger. Do not resubmit the same finding.`
- [x] **T2 Implementation.** Optional `duplicateOf` hint on the tool result, computed from a read-only known set;
      no new required tool parameter, no dedup call inside the tool, no cross-angle state.
- [x] **T3 Tests.** Exact fingerprint, near-duplicate (entity + claim similarity), severity upgrade, no known set,
      cross-angle not visible, and "hint does not suppress the candidate".

**Acceptance**

- [x] A1 Unit tests cover the boundary and the wording invariants.
- [x] A2 Dedup, displayId and reporting counts are byte-identical to the current behaviour when no hint fires.
- [x] A3 Dogfood shows no padding and no premature stop on a case with a genuine severity upgrade.

**Decision rule.** Merge on A1–A3; no model A/B required.

---

### S1 · Tool-schema order: diagnostic, then a small experiment · P2 · evidence: `hypothesis` · ADR: [0015](adr/0015-tool-schema-field-order-diagnostic.md) · Status: ✗

**Why.** [`submit_verdict`](../src/tools/collector-tools.ts#L288-L299) declares `verdict` first and
`rationale` second. OCR's filter tools deliberately put `analysis` before `comment_ids` and record that session
replays showed the model committing to ids before reasoning (`internal/agent/agent.go:1572-1597`). That is
evidence for **a different tool on a different task**. It does not prove that reordering `submit_verdict` changes
calibration in pir.

**What is already known.** TypeBox preserves object insertion order. The SDK passes a normal tool's schema
through as-is; when its strict-schema path is used it also iterates `Object.entries(properties)` and sets
`required` in that order. [`adaptTool`](../src/agents/session-factory.ts#L383-L399) does not set
`constrainedSampling`, so this is a normal tool schema, not forced structured output. The order is therefore
visible to the provider; whether the model generates in that order, and whether that changes the verdict, is
unknown.

**Scope guard.** Do not bundle a `record_candidate` reorder. Do not treat the M0 result as an adoption gate.
Do not change field names or semantics.

**Tasks**

- [x] **T0 Write the ADR.** Record the hypothesis, the expected direction, the provider caveat and the stop rule.
- [x] **T1 Diagnostic.** Add a model-free test that asserts the property order of `submit_verdict.parameters`;
      if the SDK exposes a payload/session tap, capture the actual provider tool schema; otherwise use a local
      mock endpoint once. Document the result.
- [x] **T2 M0 experiment.** Fixed 100-comment sample, **at least two repeats per side**, same model and build
      provenance. Read `killRate`, `falseKillRate`, accuracy and output tokens. Label the result a point
      comparison, not a variance floor.
- [x] **T3 Decision.** Adopt only if the pre-registered direction holds (falseKill falls without a comparable
      kill collapse) and replicates across repeats; otherwise close as ✗ and record why in the ADR.

**Acceptance**

- [x] A1 Diagnostic result recorded (schema order and, if captured, wire order).
- [x] A2 M0 comparison recorded with both sides' CLI sha256, model, sample digest and repeats
      ([repeat 1](../tests/eval/aacr/results/M0-2026-10-22-s1-field-order-r1.md),
      [repeat 2](../tests/eval/aacr/results/M0-2026-10-22-s1-field-order-r2.md)).
- [x] A3 Decision recorded in the ADR; a "no effect" result is a legitimate outcome.

**Decision rule.** No merge of a production reorder before A2/A3. If the effect is small or inconsistent, stop.

**Outcome (2026-10-22).** The two repeats disagreed on the sign of the `falseKillRate` change and every cross-build delta sat inside the same-build repeat noise, so the reorder was **not adopted** and the item closes as ✗ ([ADR 0015 §Iteration 2](adr/0015-tool-schema-field-order-diagnostic.md#iteration-2--the-m0-comparison-and-the-decision-2026-10-22)). No production field moved; the eval tooling gained per-arm token accounting so the pre-registered cost metric is readable from the results document.

---

### S2 · Explicit user background for `find` + reviewer only · P2 · evidence: `product direction` · ADR: [0016](adr/0016-user-background-for-find.md) · Status: ☑

**Why.** There is no explicit background flag in [`find`](../src/cli/executor.ts#L81-L146). The reviewer does
receive memory, project rules, focus, prior summaries and the diff, so the claim is not "no context at all"; the
missing input is the **user's stated goal for this change** (PR description, migration note, intentional
behaviour change). OCR treats that as a bounded, delimited, first-class input
(`cmd/opencodereview/background_file.go:15-118`).

**Scope guard.** First version: `find` only, reviewer prompt only. Do not add audit, verifier, or multiple
entrypoints. Do not change the request-envelope contract. Default remains no background.

**Tasks**

- [x] **T0 Write the ADR.** Record the scope, the trust boundary ("user-supplied context, not instructions"),
      and why verifier/audit are deferred. ([ADR 0016](adr/0016-user-background-for-find.md))
- [x] **T1 Flags and guards.** `--background <text>` and `--background-file <path>`; file wins with a warning;
      1MB raw cap; 8,000-character hard / 2,000-character soft; strip control characters and collapse blank
      lines; reject content containing the reserved delimiters; reject directories/empty-after-sanitisation.
      (The soft cap warns rather than truncates and the hard cap truncates rather than rejects — rationale in
      ADR 0016 §Decision 3–4.)
- [x] **T2 Injection and provenance.** Wrap in a reserved `<user_background>` section in the reviewer prompt,
      after process rules and before evidence; record a canonical hash (never the text) in `run.json`.
- [x] **T3 Tests.** Precedence, size limits, sanitisation, delimiter rejection, hash stability, no-background
      path byte-identical.
- [ ] **T4 Dogfood.** 3–5 real PRs with descriptions; compare findings and note any over-fitting to the stated
      goal. Do not change the locked M1 baseline; a later M1 round may be justified separately.
      **Partial (2026-10-23):** this item's own PR ran three times with a background description and once
      without (same HEAD) — observational notes and the run-by-run outcome are in the PR. The remaining PRs are follow-up dogfood, not a merge gate. The
      locked M1 baseline was not changed.

**Acceptance**

- [x] A1 Unit tests cover every guard and the no-background path.
- [x] A2 Dogfood notes exist; any improvement is labelled observational, not measured.
- [x] A3 The flag is opt-in and remote-mode forwarding is documented or explicitly rejected.

**Decision rule.** Ship as an opt-in input after A1/A2; promote it into a measured M1 round only with a separate
decision.

**Outcome (2026-10-23).** Shipped as an opt-in input ([ADR 0016](adr/0016-user-background-for-find.md)):
`--background` / `--background-file` on `find`, reviewer prompt only. Guards are 1 MiB raw, 8,000-character
hard truncation, a 2,000-character soft warning, sanitisation, and reserved-delimiter rejection; the prompt carries
a delimited `<user_background>` section after every process rule and before the evidence block; `run.json`
records hash and sizes only. Audit rejects the flags, verifier prompts are untouched, `--background-file` is
rejected in remote mode on both sides (CLI and the server's `/v1/review`/`/v1/exec` lanes, dogfood F-1) and
`--background` needs a same-version server.

---

### S3 · Lightweight per-file attention prompt · P3 · evidence: `data signal` · ADR: [0017](adr/0017-per-file-attention-prompt.md) · Status: ⏸ parked — shipped prompt-only; effect **not measured** (A3: no M1 round)

**Why.** M1 recall is weak across sizes, not only for large PRs: `≥500` lines = 4 PRs / 6.9% recall;
`50–199` lines = 20 PRs / 8.7% recall. OCR injects the changed-file list and requires a pass per
`<review_files>` entry (`prompts/main_task_system.md:16-23`). pir's reviewer prompt
([`prompts.ts`](../src/agents/prompts.ts#L162-L214)) does not list the changed files; the model discovers them
through `get_change`.

**Scope guard.** This item is **prompt-only, zero extra model calls**. The plan phase is a separate decision
point (D1) and must not ride along. Do not force a read of every file; allow a stated skip reason.

**Tasks**

- [x] **T0 Write the ADR.** Record the weak-signal caveat (4 PRs in the large bucket; maintainability-heavy
      reference population) and the zero-extra-call constraint. ([ADR 0017](adr/0017-per-file-attention-prompt.md))
- [x] **T1 Changed-file block.** Inject a bounded `CHANGED FILES` section (path, status, churn, and
      `excludedReason` for filtered files), capped at 60 entries with an explicit "… N more" line.
- [x] **T2 Attention language.** Ask the reviewer to account for every changed file before `finish_round` —
      either a pass or a stated skip reason in `coverage`; do not make unread files a hard error.
- [x] **T3 Tests.** Prompt rendering, cap, excluded reasons, and byte-stable output when the change set is empty.
- [x] **T4 Dogfood first.** Inspect whether the model's `coverage` and finding distribution change. Only if the
      signal is real, run M1 on the full 50-PR subset; report the whole set and buckets, not only `≥500`.
      **Dogfood done (2026-10-23):** this item's own PR ran with the section present and its reviewer `coverage`
      and findings are recorded in the PR as observational notes. No clear recall signal emerged from one PR, so
      the conditional M1 round was not started — the item is parked as not-measured rather than promoted.

**Acceptance**

- [x] A1 Prompt tests.
- [x] A2 Dogfood notes.
- [ ] A3 If M1 is run: protocol-compliant comparison with the subset digest and both CLI shas; otherwise the item
      is closed as "not measured" or ✗, not "done". **Not measured:** no M1 round was run, so the item is parked
      as **not measured** (per this criterion), not marked done.

**Decision rule.** Do not treat a large-bucket-only improvement as success; the 50–199 bucket and Code Defect
recall must be read.

**Outcome (2026-10-23).** Shipped prompt-only ([ADR 0017](adr/0017-per-file-attention-prompt.md)): the change-mode
reviewer prompt carries a bounded `CHANGED FILES` section (path, status, churn, exclusion reason for withheld
files; 60 entries plus an explicit remainder line) and asks for per-file accounting in `coverage` without making
unread files an error. Zero extra calls, no new state, no new manifest field, and a byte-identical prompt when the
change set is empty. Three dogfood rounds on the rebased branch changed the implementation before merge: the
accounting request now names `finish_round`'s 40-entry `coverage` cap (F-3), repository-controlled paths are
flattened to one line and length-capped (F-2), and the flattener preserves legal path whitespace (F-4) — see
ADR 0017 decisions 4 and 7. The M1 baseline is untouched; the item stays ⏸ until a protocol-compliant round
measures it.

---

### S4 · Audit resume: discovery and protocol only · P3 · evidence: capability gap, demand unproven · ADR: [0018](adr/0018-audit-resume-identity-protocol.md) · Status: ☑ discovery complete — implementation is a **no-go** (one pre-ledger interruption recorded; D2 not triggered)

**Why.** The docs are explicit: [`review-loop.md`](review-loop.md#L156-L160) "There is no automatic
restart/resume of an interrupted audit"; [`design.md`](design.md#L155-L163) "Reading stored candidates
does not resume them in a later run." Audit candidates and coverage are persisted (since the #38 ledger fixes),
so the raw material exists for runs produced today. What is missing is an identity/state protocol and evidence
that users need it: multi-day audits appear as a scenario in docs/CLI, and no user request, issue or dogfood
finding in this repository's record documents an interrupted-audit loss (the operator's own state does — see the
T0 answer below).

**Scope guard.** This item is discovery, not implementation. Do not write code, do not promise L, and do not
describe it as a coverage-contract change (D-B8 / ADR 0013 remains rejected).

**Tasks**

- [x] **T0 Demand discovery.** Who runs multi-day audits, how often, what they do after an interruption, and
      whether restarting is acceptable. Record the answers (or the absence of answers) in the ADR.
      **Answered (2026-10-23):** five audit runs are recorded on 2026-09-30 against one private repository
      — three never finished and produced nothing, one stopped at the findings cap with 690 files unreviewed,
      and one ran ~6.5 hours, produced 152 verified findings and never finished (its row is still `running`);
      no reboot occurred, and the journal shows the operator's SSH session ending minutes after the last model
      call, so terminal-bound execution is the likeliest cause. No request for continuing an interrupted audit
      exists, and the operator never restarted the six-hour run. **Demand is one measured cost, not a stated
      need**, and that run predates the #38 ledger a resume needs.
- [x] **T1 Identity protocol.** Snapshot commit/tree; scope (`--path`/`--skip`); filter/planner version;
      reviewer and verifier model; rule hash; plugin and prompt versions; budget policy. State which changes
      force a full refusal rather than partial reuse. **Written (ADR 0018):** compare-and-refuse table over the
      persisted target plus the model/verifier/pack identity; whole refusal, never partial reuse; the rule hash
      is excluded because audit rejects `--rule`; build identity does not exist yet and is named as a gap;
      model, verifier and pack identity live only in `run.json`, which is absent unless transcripts are on.
- [x] **T2 State semantics.** Completed/reused/failed/waived units; in-progress re-run; blocked retry; pending
      candidates (reuse or re-verify); dedup against completed findings; budget carry-over or reset.
      **Written (ADR 0018):** a durable-state table over pir's actual vocabulary (`pending`, `in-progress`,
      `reviewed`, `blocked`, `failed` — there is no `waived` state and none is invented); pending candidates
      are re-verified, never re-discovered; the `known` dedup set is rebuilt from candidate rows; attempts and
      `--max-tokens` spend carry, the wall clock restarts.
- [x] **T3 ADR + estimate.** Only after T0–T2, write the ADR and a cost estimate; record go/no-go.
      **Recorded (ADR 0018):** two PRs, ~500–800 lines plus tests, one migration to persist identity and usage;
      go/no-go is **no-go**.

**Acceptance**

- [x] A1 Discovery answers recorded, including "no demand recorded".
- [x] A2 Identity and state protocol written.
- [x] A3 Go/no-go recorded; implementation is a separate ADR/PR.

**Outcome (2026-10-23).** Discovery complete, implementation declined
([ADR 0018](adr/0018-audit-resume-identity-protocol.md)). The record contains more than the roadmap assumed:
five audits ran on 2026-09-30, and one of them — ~6.5 hours, 152 verified findings — stopped without finishing
and is still marked `running`; its findings survived, its remaining coverage did not. But that run predates the
incremental ledger (#38), so the state a resume needs did not exist for it; its likeliest cause is a
terminal-bound local run (no reboot; an SSH disconnect minutes after the last model call); and no one has asked
for the feature since. The ADR therefore writes the identity/state protocol a future implementation must
follow — exact match on project, commit/tree, scope, selection and planner versions, reviewer/verifier models,
language packs and a build identity that does not exist yet; whole-run refusal on any mismatch and on a
pre-ledger run; reuse of `reviewed` units, re-run of `in-progress`, retry of `failed` only inside the
two-attempt cap, `blocked` stays blocked, pending candidates re-verified, and the same run row continued rather
than a second one created — and records **no-go**, pointing the next investment at local durability (a local
audit that survives its terminal) rather than at a resume state machine. D2 is **not triggered**; no code,
schema, flag or state changed.

---

### S6 · SARIF output · Track B · evidence: `code fact` · ADR: [0020](adr/0020-sarif-output.md) · Status: ☑

**Why.** pir has text/JSON and stable exit codes; it has no SARIF, so GitHub Code Scanning and other SARIF
consumers cannot ingest findings. OCR ships a full SARIF 2.1.0 writer (`cmd/opencodereview/sarif.go`).

**Scope guard.** No model change. Demand-driven; do not block the core items.

**Tasks**

- [x] **T0 ADR** (short): result mapping, rule ids, severity levels, fingerprints, incomplete-run invocation.
      **Written ([ADR 0020](adr/0020-sarif-output.md)):** the mapping table, the rule-id sanitization, the
      location rules, the fingerprint slot and the invocation contract.
- [x] **T1 Mapping.** `category` → ruleId; `P0/P1` → `error`, `P2` → `warning`, `P3` → `note`;
      anchors → physical locations; finding identity → `partialFingerprints`. **Shipped:** the builder maps
      one reported finding to one result, drops unusable anchors instead of clamping them, and uses the
      canonical `buildIdentity` fingerprint under `pirFinding/v1`.
- [x] **T2 CLI.** `--format sarif` on `find` and `audit`; no findings → valid empty `results`; incomplete run
      represented in `invocations`. **Shipped:** `--format text|json|sarif` (with `--json` the legacy spelling
      of `json`), validated before transport/bundle work; the invocation records `executionSuccessful` plus a
      stop-reason notification, and an audit invocation carries coverage. Preview/readout lanes reject sarif.
- [x] **T3 Golden/schema tests** and docs. `tests/unit/sarif.test.js` (with a structural validator for the
      SARIF subset used), `tests/unit/output-format.test.js`, `tests/integration/sarif-cli.test.js`;
      README, `docs/README.zh-CN.md` and `docs/for-llm.md` document the flag and the document.

**Acceptance**

- [x] A1 Output validates against the SARIF 2.1.0 schema subset used.
- [x] A2 Empty and incomplete runs are valid.
- [x] A3 JSON/text outputs are unchanged.

**Outcome (2026-10-23).** Shipped `--format sarif` on `find` and `audit`
([ADR 0020](adr/0020-sarif-output.md)). One SARIF 2.1.0 log per invocation: `category` becomes the rule id
(sanitized, sorted, one rule per distinct category), P0/P1 map to `error`, P2 to `warning` and P3 to `note`,
the first anchor is the primary location and the rest become `relatedLocations`, and the finding's canonical
identity is `partialFingerprints["pirFinding/v1"]`. `invocations[0]` records `executionSuccessful` from the
run's `incomplete` flag plus a notification carrying `stoppedBecause`, and an audit invocation carries the
coverage summary. No findings yields valid empty `results`; the text and `--json` outputs are byte-identical to
before and exit codes do not move. `--json` with a contradictory `--format` is a usage error, and
`find --preview`, `audit --dry-run` and `audit coverage` reject sarif rather than ignoring it.

---

### S7 · `pir rules check <file>` · Track B · evidence: `code fact` · ADR: [0019](adr/0019-project-rules-check.md) · Status: ☑

**Why.** [`pir config show`](../src/cli/executor.ts#L1999-L2014) prints the loaded rule layers, but there is no
per-file answer to "which rule wins for this path?". OCR has `ocr rules check` for exactly that debugging step.
B5's resolver already has the winning-rule data.

**Scope guard.** No model, no run. Demand-driven.

**Tasks**

- [x] **T0 ADR or docs note** (small): output contract. **Written ([ADR 0019](adr/0019-project-rules-check.md)):**
      the text lines, the `rules.check` envelope (winner, per-layer gates, `renderedSection`), the path
      contract and the no-host-paths rule.
- [x] **T1 Command.** Print the winning rule, source layer, matched glob, and rendered text; reuse
      `applyProjectRules`; no absolute paths. **Shipped:** the matcher was extracted from
      `applyProjectRules` into `matchProjectRule`, so the prompt and the command cannot drift;
      `checkProjectRules` adds the per-layer gate explanation. Paths are reported repository-relative;
      layer labels come from `layerLabel`.
- [x] **T2 Tests** for layer precedence, exclude wins, no-match, and byte-stable output.
      `tests/unit/project-rules-check.test.js` (matcher/check agreement, gates, rename) and
      `tests/integration/rules-cli.test.js` (text and JSON contracts, byte stability, no host paths, usage
      guards, no state directory).
- [x] **T3 Docs** in `for-llm.md` / README. README, `docs/README.zh-CN.md` and `docs/for-llm.md`
      document the command and the JSON envelope.

**Acceptance**

- [x] A1 Output is stable and path-safe.
- [x] A2 No run row, no model session.
- [x] A3 `config show` output is unchanged.

**Outcome (2026-10-23).** Shipped (`pir rules check <path>`, [ADR 0019](adr/0019-project-rules-check.md)).
The command prints the winning layer, matched glob, `mergeBuiltin`, the canonical guidance text and the rules
hash, or one line per loaded layer naming the gate that failed; `--json` adds the exact PROJECT RULES block the
path would receive. It runs client-side in every mode, opens no project database, starts no session and writes
nothing. One matcher backs both the reviewer prompt and the answer: `applyProjectRules` now calls the extracted
`matchProjectRule`, and a unit test asserts the two agree on every fixture path.

---

## 4. Decision points (data-triggered; do not start without the trigger)

| ID | Topic | Trigger | Action when triggered | Status |
| --- | --- | --- | --- | --- |
| D1 | Plan phase for large changes | S3 dogfood or a protocol-compliant M1 round still shows weak coverage/recall after the changed-file/per-file prompt, and the budget allows one extra call per PR | Write an ADR; one plan call gated by OCR's 50/100-line thresholds; inject as advisory text in round 1 only; strip on round 2+ because a plan can become a coverage ceiling; fall back to no plan on failure | ➜ waiting on S3 |
| D2 | Audit resume implementation | S4 T0–T2 show real demand and an agreed identity/state protocol | Separate ADR and implementation PR; reuse completed units only under exact identity; never mix models or prompt versions | ✗ not triggered — S4 found one interruption (2026-09-30, a pre-#38 run whose ledger was never written, most likely terminal-bound) and no request; the protocol is written ([ADR 0018](adr/0018-audit-resume-identity-protocol.md)) |
| D3 | `record_candidate` field reorder | S1 shows a real, replicated effect and a second experiment is affordable | Separate ADR; move category/severity after anchors/evidence; measure on M1, not M0 | ➜ waiting on S1 |
| D4 | Reflection filter as a pre-verifier funnel | New cost data shows the filter is much cheaper per candidate than the verifier and the removal surface remains small | Do not reopen on the current M0 percentages alone; if reopened, measure filter cost and verifier cost per candidate, not percentages | ✗ not triggered |
| D5 | Semantic grouping / large-PR slicing | A protocol-compliant full-corpus or 50-PR run shows a large-PR-specific coverage/cost failure that the attention prompt does not fix | ADR 0011's conditions still apply; grouping must fail back to per-file and never gate correctness | ✗ rejected (ADR 0011) |
| D6 | Cross-file relocation | A measured anchor-error class shows findings uniquely located in another changed file | ADR 0005 §4 still governs; a unique-hit relocation may retarget a finding the model never analysed | ✗ rejected (ADR 0005 §4) |

---

## 5. Dependencies

```text
S5 (feedback) ── independent
S1 diagnostic ──→ S1 M0 experiment ──→ D3 (record_candidate reorder)
S2 (background) ── independent, find + reviewer only
S3 (per-file prompt) ──→ D1 (plan phase) only if the signal survives
S4 discovery ──→ D2 (implementation) only after go
S6 / S7 ── Track B, demand-driven, no dependency on S1–S4
```

---

## 6. Non-borrows (do not re-litigate without new evidence)

| Direction | Reason |
| --- | --- |
| Reflection filter as a cost funnel | M0 shows a small removal surface (8.0% kill / 3.0% false kill on the offline material). The percentages do not establish verifier cost savings or online false-kill rates; a pre-filter also adds a new loss channel. Revisit only with measured per-candidate costs (D4). |
| Semantic grouping / large-PR slicing | ADR 0011's data trigger did not fire. M1's weak recall is not large-PR-specific (4 vs 20 PRs across the two weak buckets), and grouping adds cross-group drift risk. |
| Cross-file relocation | ADR 0005 §4: a unique-hit relocation can retarget a finding to a file the model never analysed; the evidence gate is the better constraint. |
| In-session three-zone compression | pir opens a fresh session per round; the long-conversation bloat OCR compresses does not exist structurally. |
| Coverage manifest / per-file terminal states | ADR 0013: the existing ledger and exclusion record already derive the states; a second state machine creates two sources of truth. S4 is execution recovery, not this contract. |
| Session viewer / audit enhancements | ADR 0012: no recorded demand; transcripts are retained SDK snapshots, not provider wire captures. |
| Delegation mode / ACP / multi-provider / ChatGPT auth | Different product form factors; pir's skill + JSON envelope + serve already cover the equivalent. |
| Auto-fix / `suggestion_code` | pir's reviewer prompt deliberately says "Do not propose fixes"; adding suggestions changes the product boundary and would need its own verification. |
| LLM grouping call | Same as semantic grouping; the metadata-only trick is clever but the need is unproven. |
| Re-location LLM fallback | B2 chose reject-and-resubmit over letting the model guess a snippet again; OCR's own prompt demands VERBATIM, showing how error-prone the fallback is. |

---

## 7. Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | S1 overfits to one provider or one tool schema; the effect is absent on another implementation | Diagnostic first; M0 with repeats; pre-registered direction; stop rule; do not merge a production reorder on a single point comparison |
| R2 | S5 wording makes the model stop submitting or pad findings | No "will not count"; keep the candidate recorded; distinguish "overlaps" from "invalid"; dogfood a severity-upgrade case |
| R3 | S2 background becomes a prompt-injection or secret-leak channel | Size caps, control-character sanitisation, reserved delimiters, trust label, hash-only provenance, explicit user opt-in |
| R4 | S3 prompt bloat or forced reads raise cost | Cap at 60 files; allow a stated skip reason; zero extra calls; do not bundle the plan phase |
| R5 | S4 protocol is more complex than expected and becomes an implicit coverage contract | Discovery first; separate ADR; refuse partial reuse; pending/state semantics written before code |
| R6 | M1 comparison cost/variance is used to over-claim | Protocol-compliant runs only; both CLI shas and subset digest; label point comparisons; no large-bucket-only claims |
| R7 | Track B (SARIF/rules check) competes with core quality work | Separate track; demand-driven; no model cost; never blocks S1–S4 |

---

## 8. Change log

| Date | Item | Change | Reason / link |
| --- | --- | --- | --- |
| 2026-10-22 | all | Roadmap created as a temporary tracker; will be deleted once items close and ADRs absorb the content | Second OCR deep dive; first series B1–B5 retired |
| 2026-10-22 | all | Priority revised after review: S5 first, S1 as diagnostic + experiment; background and per-file attention separated; audit resume reduced to discovery; SARIF/rules check moved to Track B | Corrected over-claims: schema order is a hypothesis, the ≥500 bucket is 4 PRs, audit resume demand is unproven, and M0 percentages do not prove cost or online behavior |
| 2026-10-22 | all | Iteration labels renamed (Iteration 1–4) to avoid collision with the M1 benchmark; ADR numbering fixed at 0014; deletion checklist added | Drafting hygiene; keeps the tracker unambiguous while it exists |
| 2026-10-22 | S5 | Shipped: optional visibility-only duplicate hint in `record_candidate` (ADR 0014), shared `duplicateMatch` predicate, strict prior-round baseline; no dedup/reporting change | Iteration 1 contract clarity |
| 2026-10-22 | S1 | [ADR 0015](adr/0015-tool-schema-field-order-diagnostic.md) accepted (diagnostic only); T0/T1 done — declared and captured wire order both assert `verdict, rationale, …`, and the repeat protocol is pre-registered | Diagnostic first: the reorder stays undecided until the Iteration 2 M0 comparison |
| 2026-10-23 | S2 | Shipped: opt-in `--background` / `--background-file` for `find` (ADR 0016), reviewer prompt only, delimited and labelled, hash-only provenance in `run.json`; A1–A3 done, T4 dogfood partial (this PR, with and without a background) | Iteration 3, first item; the locked M1 baseline is untouched |
| 2026-10-23 | S3 | Shipped: bounded per-file attention prompt `CHANGED FILES` + accounting request (ADR 0017); prompt-only, zero extra calls, byte-identical when the change set is empty; A1/A2 done, A3 not measured, item parked ⏸ | Iteration 3, second item; no M1 round was run, so no recall claim is made |
| 2026-10-22 | S1 | Iteration 2 ran and closed: two M0 repeats per side on the fixed sample ([r1](../tests/eval/aacr/results/M0-2026-10-22-s1-field-order-r1.md) / [r2](../tests/eval/aacr/results/M0-2026-10-22-s1-field-order-r2.md)); the expected `falseKillRate` direction did not replicate and every cross-build delta sat inside same-build repeat noise, so the reorder was **not adopted** and S1 closes ✗ | The pre-registered stop rule; ADR 0015 §Iteration 2 records both builds, both repeats and the decision |
| 2026-10-23 | S6 | Shipped `--format sarif` on `find` and `audit` (ADR 0020): one SARIF 2.1.0 log per run with category rule ids, severity levels, anchor locations, canonical partial fingerprints and an invocation that records completeness; `--json` and text are unchanged; A1–A3 done | Track B, second item; SARIF consumers can ingest findings without a custom mapper |
| 2026-10-23 | S7 | Shipped `pir rules check <path>` (ADR 0019): client-side, no run/database/session, text + `rules.check` JSON with the rendered PROJECT RULES section; the winning-rule matcher is now shared with `applyProjectRules`; A1–A3 done | Track B, first item; rules could be listed but not resolved for one path |
| 2026-10-23 | S4 | Iteration 4 closed as discovery only: the record holds one interrupted ~6.5-hour audit (a pre-#38 run with no ledger, most likely killed with its terminal) and no request for resume; identity/state protocol and cost estimate written, **no-go** for implementation ([ADR 0018](adr/0018-audit-resume-identity-protocol.md)); D2 not triggered | The series' rule is measured gaps, not parity: the one loss on record predates the ledger a resume needs, and local durability is the cheaper remedy for its cause |

---

## 9. Deliberately not in this roadmap

- Any automatic fixing or auto-apply behaviour.
- Any change to the AACR-Bench baseline protocol or the locked 50-PR population without a separate ADR.
- Any re-litigation of ADR 0005 §4, ADR 0011, ADR 0012 or ADR 0013.
- Any multi-provider/auth/ACP work; those are product-form decisions, not review-quality borrowings.

---

## 10. Deletion checklist

- [ ] Every item is ☑ or ✗; no ☐/◐ remains.
- [ ] Every executed item's ADR is merged; the `ADR:` field in its header names the number.
- [ ] Any measurement result lives in `tests/eval/aacr/results/` or the ADR that cites it.
- [ ] §6 non-borrows are absorbed into the relevant ADR(s) or a successor decision document.
- [ ] No code comment, doc, test, or commit message links to this file.
- [ ] Delete this file; remove branch-level tracking references; keep the ADRs as the surviving record.
