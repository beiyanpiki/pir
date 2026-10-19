# Roadmap: OCR borrowings × AACR-Bench integration (tracking file)

> **⚠️ This file is a temporary tracking artifact: delete it once every item below is ☑.**
> **Companion context: [ocr-borrow-and-aacr-benchmark-context.md](ocr-borrow-and-aacr-benchmark-context.md)** — the full research interpretation (OCR mechanisms with a source-location quick reference, the pir baseline, the dimension-by-dimension comparison, the AACR-Bench assets and metric methodology, risks R1–R10, and the research method). Each item's ADR draws its Context from that document; this file tracks execution only and carries no research detail.
> Deletion preconditions: (1) every executed item's ADR is merged under `docs/adr/` (numbering continues in sequence), with this file acting only as an index; (2) any §3 decision point that was kicked off has its own ADR; (3) baseline numbers are persisted in `tests/eval/aacr/results/` and the relevant ADR/RESULTS documents, with nothing depending on this file's narrative; (4) content of the companion context document that is still referenced has been absorbed into the ADRs — then delete that document together with this file.
>
> Status legend: `☐ not started` · `◐ in progress` · `☑ done` · `⏸ parked (reason noted)` · `➜ decision point (awaiting data)`
> **ADR rule: each item writes its ADR (Status: Proposed) when execution starts, and flips it to Accepted when the implementation PR merges; at that point replace `ADR: written at execution` in the item header with the actual number. This file tracks execution; it does not replace the ADR.**
> Research sources: alibaba/open-code-review @ `8eb8334`, alibaba/aacr-bench, HF `Alibaba-Aone/aacr-bench` (all Apache-2.0; data use requires citing arXiv 2601.19494). Research conclusions are summarized in §5.
> **Update rule: check off each task as it completes and append a row to §6; when status and reality diverge, code wins — fix this file immediately.**

---

## 0. Milestones

| Milestone | Items | Status | Definition of done |
| --- | --- | --- | --- |
| Iteration 1 | B1, B2, B3, M0 skeleton | ☐ | B1–B3 each merged to dev and through the dogfood gate; M0 `--limit 100` produces first numbers |
| Iteration 2 | M0 full run, B4, M1 skeleton | ☐ | M0 full 2,145-comment report + OCR-prompt comparison; B4 merged with no kill-rate regression; M1 `--limit 20` smoke passes |
| Iteration 3 | M1 full run, B5 | ☐ | First M1 comparison report (balanced_score); B5 merged |
| Iteration 4 | M2 baseline lock-in, D-B6/D-B7/D-B8 decisions | ☐ | Change protocol in effect; all three decision points have data-backed adopt/reject records |

---

## 1. Borrow track

### B1 · Change-mode file filter gate `P0` · ADR: written at execution · Depends on: none · Status: ☐

**Tasks**
- [ ] T0 Write the ADR (must cover: shared filter module, gate order, non-overridable secret paths, excluded≠invisible, preview reusing the same pure function)
- [ ] T1 Sink the audit filters (`DEFAULT_SKIP_PATTERNS` / `BINARY_EXTENSIONS` / size gates from `snapshot.ts`) into a shared module `src/changes/filter.ts` (version tag migrates along)
- [ ] T2 find applies the four gates after `buildChangeSet()`: binary → secret paths (non-overridable; `.env.example` family exempt) → skip patterns → oversized single-file diff
- [ ] T3 Filtered files keep path/status/churn metadata visible to the reviewer; diff bodies never enter the prompt; envelope gains `files[].excluded` + reason (purely additive)
- [ ] T4 `pir find --preview` prints the selection result via the same pure function

**Acceptance**
- [ ] A1 Unit tests per gate + include bypass (secret paths have no bypass)
- [ ] A2 Envelope fields backward compatible (zero consumer changes)
- [ ] A3 Dogfood on pir's own PRs shows no behavioral regression

### B2 · Snippet-anchored location correction `P0` · ADR: written at execution · Depends on: none · Status: ☐

**Tasks**
- [ ] T0 Write the ADR (must cover: optional excerpt with gradual adoption, local sliding-window match overriding LLM line numbers, locate-failure → tool-boundary error and resubmit, no cross-file relocation — the evidence gate already constrains drift)
- [ ] T1 `CandidateFinding.anchors[]` gains an optional `excerpt` field
- [ ] T2 `record_candidate`: when an excerpt is present, run a normalized sliding-window match against the pinned head content; on hit, the local location overrides the LLM's line numbers and a `lineCorrected` event is recorded (original range kept)
- [ ] T3 Excerpt locate failure → tool-boundary error so the model resubmits (existing retry-then-fail contract)
- [ ] T4 Reviewer prompt updated to request an excerpt

**Acceptance**
- [ ] A1 Unit test: correction success rate on fixtures with ±5-line drift
- [ ] A2 No-excerpt path behaves byte-identically to today
- [ ] A3 `FindingView` emits the correction flag; M1 normalization reports "correction rate among excerpt-bearing anchors" separately from "overall anchor validity"

### B3 · Default token budget with graceful truncation `P0` · ADR: written at execution · Depends on: none · Status: ☐

**Tasks**
- [ ] T0 Write the ADR (must cover: default ceiling constants, grace semantics = "finish verifying what was found", unchanged incomplete/exit-code contract, no in-session compression)
- [ ] T1 find default budget: 1.2M reviewer + 0.8M verifier input tokens (tunable constants; `--max-tokens` overrides; `unlimited` is the explicit opt-out)
- [ ] T2 Budget hit: no new reviewer round starts, all pending candidates are verified (grace semantics), `stoppedBecause=budget`
- [ ] T3 `incomplete` semantics and the exit-code contract unchanged

**Acceptance**
- [ ] A1 Budget-hit integration test with fake-session injected usage: pending drained, manifest records the budget stop, exit code per contract
- [ ] A2 Constants may only be tightened after checking them against the M1 per-PR token distribution (recorded as an ADR amendment)

### B4 · Structured verifier rejection grounds `P1` · ADR: written at execution · Depends on: M0 skeleton · Status: ☐

**Tasks**
- [ ] T0 Write the ADR (must cover: the rejection_ground enum, the asymmetric cost statement, the protected-subject clause, M0 kill-rate as the merge gate)
- [ ] T1 `submit_verdict` gains a required-on-reject `rejection_ground` enum (7 values: no-such-code / contradicted-by-code / pre-existing / guarded / speculative / not-introduced-by-change / other; unknown normalizes to `other`)
- [ ] T2 Verifier prompt gains the asymmetric cost statement ("a false kill destroys a real finding ≫ a false keep costs one review pass") + protected-subject clause (concurrency / memory-safety / security rejections must name a contradicting artifact)
- [ ] T3 Grounds flow into findings JSON / memory write-back / M0–M1 result rows

**Acceptance**
- [ ] A1 Prompt unit tests updated
- [ ] A2 **M0 before/after: kill-rate (rejecting a label=1 comment) does not regress — this is B4's merge gate**

### B5 · Layered user rule file (`.pir/rule.json`) `P1` · ADR: written at execution · Depends on: B1 (include/exclude wiring) · Status: ☐

**Tasks**
- [ ] T0 Write the ADR (must cover: three layers with first-match-wins, safe reading of guidance file references, PROJECT RULES injection position and byte-stable ordering, division of labor vs language packs and memory, rule hash into the manifest)
- [ ] T1 Three-layer loading (`--rule` > repo > global) + glob matching (reuse `pathMatchesGlob`)
- [ ] T2 Schema: `rules[{path, guidance, merge_builtin}]` + include/exclude; safe reading of guidance file references (size cap / extension allowlist / within-repo path validation)
- [ ] T3 Injection into the reviewer prompt as a `PROJECT RULES` section (before the memory pack, evidence-not-instructions preamble, path-sorted for byte stability)
- [ ] T4 Canonical rule-text hash into the run manifest; `pir config show` prints effective rules

**Acceptance**
- [ ] A1 Unit tests: layer precedence / merge semantics / mutual exclusion with language packs
- [ ] A2 Dogfood using a rule file to constrain pir's own PRs

---

## 2. Benchmark track (AACR-Bench)

Everything lands under `tests/eval/aacr/`, gated by `PIR_EVAL=1`; upstream assets pinned by sha256 (meta.json convention, data files gitignored and auto-downloaded). Scoring and metric caliber are fixed in M0's ADR at kickoff; the existing ADR-0003 stance (ReviewBench for local evaluation) continues to apply.

### M0 · Verifier offline benchmark (reflection test set) `P0` · ADR: written at execution · Status: ☐

**Tasks**
- [ ] T0 Write the ADR (must cover: the `_verify-comment` internal command and its mapping contract, uncertain=keep as the primary scoring policy, kill-rate as the north-star metric, the OCR-prompt comparison arm, the delegate-to-upstream-judge stance, cost and citation obligations)
- [ ] T1 Data acquisition script: HF `dataset.json` download + sha256 pin + citation notice written into output headers
- [ ] T2 Materialization (one-off, cacheable): shared clone cache for the 50 repos → checkout target commit → per-comment diff + head file extraction → intermediate JSONL (fetch failures become error rows, never aborts)
- [ ] T3 Internal command `pir _verify-comment` (underscore prefix, outside the stable contract): fixed comment→CandidateFinding mapping (title = first sentence / claim = full note / trigger empty / category mapped / severity P2 / anchor = line range / evidence = driver-supplied diff excerpt), wrapping `runVerifier`
- [ ] T4 Eval driver: spawn the command with rb-grade env isolation (HOME/XDG / per-task cold `PIR_MEMORY_DB` / `--plugins none` / `--local`)
- [ ] T5 Scoring `score.js` (pure function): uncertain=keep primary policy + strict variant, accuracy/P/R/F1, confidence AUC, kill-rate north star; buckets by source_model / category / context / is_ai_comment
- [ ] T6 OCR reflection-prompt comparison arm (port `review_filter_task_system.md`, with attribution)
- [ ] T7 `--limit 100` sampled first run → full 2,145 in iteration 2

**Acceptance**
- [ ] A1 First `results/M0-*.md` (protocol copied from rb RESULTS: per-bucket metrics, sample sizes, model versions, variance notes, arXiv citation)

### M1 · End-to-end benchmark `P1` · ADR: written at execution (may share M0's) · Depends on: M0 skeleton, B1 (B1's effect measured by M1) · Status: ☐

**Tasks**
- [ ] T0 Write/extend the ADR (must cover: reference comments are label=1 only, judging delegated to the upstream judge (no self-built judge), balanced_score as the external caliber, the large-repo materialization decision)
- [ ] T1 Fixture conversion: upstream `positive_samples.json` → `fixtures/test-set.json` (200 tasks; instance_id convention `owner__name@head7`)
- [ ] T2 `run-aacr.js` (clone of rb `run-rb.js`): shared-cache repos, detached checkout → spawn `pir find --base --head --max-rounds 2 --max-findings unlimited --json --quiet --local --cwd`; same-repo serial / cross-repo concurrent; 30-min timeout; `--limit/--only/--repeats/--resume`
- [ ] T3 `normalize-aacr.js` (pure function): envelope → `{path, start_line, end_line, text}`; reported = confirmed + uncertain plus a confirmed-only view; anchor-less findings counted as dropped
- [ ] T4 Judging delegation: pinned clone of upstream `judge.py`/`evaluate.py` invoked (`JUDGE_*` controlled, mock first then real)
- [ ] T5 `--limit 20` smoke → full run + `--eval-rounds 3` multi-round averaging
- [ ] T6 Large-repo materialization strategy landed (full clone or `--filter=blob:none`; decision recorded in the ADR)

**Acceptance**
- [ ] A1 First `results/M1-*.md`: file-level semantic P/R + **balanced_score (the external comparison caliber)** + missing excluded from denominators + buckets by language / category / PR size
- [ ] A2 (Optional) contribute an upstream `reviewers/pir.py` PR once numbers are publishable

### M2 · Baseline lock-in and change protocol `Iteration 4` · ADR: fixed alongside M1's ADR · Status: ☐

**Tasks**
- [ ] T1 Baseline recording: M1 numbers into `tests/eval/aacr/results/` (run_id / model / date / scores / per-PR delta)
- [ ] T2 Change protocol: behavioral changes (B1/B2/B4/B5 landings) run before/after on a fixed 50-PR subset (`--seed 42`); judge drift invalidates the comparison and forces a rerun (rb variance rules copied verbatim)
- [ ] T3 Smoke: nightly/manual `--limit 20`; **not a regular CI gate** (cost stance per ADR-0003)
- [ ] T4 North-star dashboard in RESULTS: balanced_score, kill-rate (M0), per-PR token cost

**Acceptance**
- [ ] A1 First before/after comparison recorded under the protocol

---

## 3. Decision points (data-triggered; write the ADR when kicking off)

| ID | Topic | Trigger (data source) | Action when triggered | Status |
| --- | --- | --- | --- | --- |
| D-B6 | Deterministic slicing of large changesets (find) | M1 shows large PRs (>2000 lines) materially worse on findings density/cost, and B3's default budget hit frequently | Write the ADR, then implement: slice by hunk adjacency, one round per slice, fingerprint dedup across slices; failure must fall back and never act as a correctness gate (OCR's lesson) | ➜ |
| D-B7 | Session-audit enhancements (transcripts on by default + web marking / cost breakdown) | Accumulated debugging / cost-attribution demand, or prompt tuning needing replay evidence | Write the ADR; implement localStorage mark-and-hide (after the OCR viewer) | ➜ |
| D-B8 | Change-mode coverage manifest contract (per-file terminal states) | After B1, the envelope already carries exclusion reasons and automation consumers ask for coverage auditing | Write the ADR: reviewed/skipped/excluded terminal states + incomplete tied to coverage | ➜ |

## 4. Dependency graph

```
B1 (filter gate) ──→ B5 (rule file include/exclude)
B1 ──→ M1 (filter effect measured by M1)
B2 (location correction) ──→ M1 (anchor metrics)
M0 (skeleton) ──→ B4 (merge gate = M0 kill-rate comparison)
M0 ──→ M1 ──→ M2 ──→ D-B6 decision
B3 and B2 have no dependencies; run in parallel
```

## 5. Research background

For the full research interpretation see the companion document **[ocr-borrow-and-aacr-benchmark-context.md](ocr-borrow-and-aacr-benchmark-context.md)**: OCR's philosophy and per-mechanism deep dive (§1, with the §1.4 source-location quick reference), the pir baseline (§2), the comparison table and the deliberate non-borrow list (§3), the two AACR-Bench assets and metric methodology (§4), risks R1–R10 (§5), and the research method (§6). **When writing each item's T0 ADR, draw the Context material from that document.**

The three load-bearing conclusions (details in the companion document):

- OCR = deterministic engineering × agent hybrid; its recall is deliberately low — any external comparison must use balanced_score (R10).
- What pir already leads on, we do not borrow: per-candidate falsifying verifier with evidence gate, SQLite memory, finding fingerprints, the JSON envelope contract, the rb eval skeleton.
- Borrowing focuses on the gaps: filter gate (B1), location correction (B2), default budget + graceful truncation (B3), verifier rejection grounds (B4); rule file (B5) next; large-PR slicing and two others are data-triggered decision points (§3).

## 6. Change log

| Date | Item | Change | Reason / link |
| --- | --- | --- | --- |
| 2026-10-19 | all | Roadmap created (ADRs deferred to each item's execution) | OCR/aacr-bench research + pir baseline survey; ADR timing adjusted per maintainer |
| 2026-10-19 | all | Companion context document added; §5 converted to a reference | Detailed research interpretation moved to `ocr-borrow-and-aacr-benchmark-context.md`; the roadmap keeps only tracking duties |
| 2026-10-19 | all | Converted both documents to English (matching repo docs convention); Chinese versions removed | Maintainer request |
