# Roadmap: OCR borrowings (tracking file)

> **⚠️ This file is a temporary tracking artifact: delete it once every item below is ☑.**
> **Companion context: [ocr-borrowings-context.md](ocr-borrowings-context.md)** — the full research interpretation (OCR mechanisms with a source-location quick reference, the pir baseline, the dimension-by-dimension comparison, the deliberate non-borrow list, risks R1–R3, and the research method). Each item's ADR draws its Context from that document; this file tracks execution only and carries no research detail.
> Deletion preconditions: (1) every executed item's ADR is merged under `docs/adr/` (numbering continues in sequence), with this file acting only as an index; (2) content of the companion context document that is still referenced has been absorbed into the ADRs — then delete that document together with this file.
>
> Status legend: `☐ not started` · `◐ in progress` · `☑ done` · `⏸ parked (reason noted)`
> **ADR rule: each item writes its ADR (Status: Proposed) when execution starts, and flips it to Accepted when the implementation PR merges; at that point replace `ADR: written at execution` in the item header with the actual number. This file tracks execution; it does not replace the ADR.**
> Research sources: alibaba/open-code-review @ `8eb8334` (Apache-2.0). Research conclusions are summarized in §3.
> **Update rule: check off each task as it completes and append a row to §4; when status and reality diverge, code wins — fix this file immediately.**

---

## 0. Milestones

| Milestone | Items | Status | Definition of done |
| --- | --- | --- | --- |
| Iteration 1 | B1, B2, B3 | ☑ | B1–B3 merged to the iteration's declared integration branch (`roadmap/ocr-borrow-and-aacr-benchmark`) through the dogfood gate; ADRs 0004–0006 written |
| Iteration 2 | B4 | ☑ | B4 merged (ADR 0008); its merge gate was a verifier kill-rate before/after on a fixed 100-comment sample, recorded in the item's acceptance |
| Iteration 3 | B5 | ☑ | B5 merged (ADR 0010, PR #124) |

---

## 1. Borrow track

### B1 · Change-mode file filter gate `P0` · ADR: 0004 · Depends on: none · Status: ☑

**Tasks**
- [x] T0 Write the ADR (must cover: shared filter module, gate order, non-overridable secret paths, excluded≠invisible, preview reusing the same pure function)
- [x] T1 Sink the audit filters (`DEFAULT_SKIP_PATTERNS` / `BINARY_EXTENSIONS` / size gates from `snapshot.ts`) into a shared module `src/changes/filter.ts` (version tag migrates along)
- [x] T2 find applies the four gates after `buildChangeSet()`: binary → secret paths (non-overridable; `.env.example` family exempt) → skip patterns → oversized single-file diff
- [x] T3 Filtered files keep path/status/churn metadata visible to the reviewer; diff bodies never enter the prompt; envelope gains `files[].excluded` + reason (purely additive)
- [x] T4 `pir find --preview` prints the selection result via the same pure function

**Acceptance**
- [x] A1 Unit tests per gate + include bypass (secret paths have no bypass)
- [x] A2 Envelope fields backward compatible (zero consumer changes)
- [x] A3 Dogfood on pir's own PRs shows no behavioral regression (two self-review passes; F-177 and F-183 fixed, no P0–P2 left on the merged form)

### B2 · Snippet-anchored location correction `P0` · ADR: 0005 · Depends on: none · Status: ☑

**Tasks**
- [x] T0 Write the ADR (must cover: optional excerpt with gradual adoption, local sliding-window match overriding LLM line numbers, locate-failure → tool-boundary error and resubmit, no cross-file relocation — the evidence gate already constrains drift)
- [x] T1 `CandidateFinding.anchors[]` gains an optional `excerpt` field
- [x] T2 `record_candidate`: when an excerpt is present, run a normalized sliding-window match against the pinned head content; on hit, the local location overrides the LLM's line numbers and a `lineCorrected` event is recorded (original range kept)
- [x] T3 Excerpt locate failure → tool-boundary error so the model resubmits (existing retry-then-fail contract)
- [x] T4 Reviewer prompt updated to request an excerpt

**Acceptance**
- [x] A1 Unit test: correction success rate on fixtures with ±5-line drift
- [x] A2 No-excerpt path behaves byte-identically to today
- [x] A3 `FindingView` emits the correction flag (the flag and the two ranges are already in the envelope)

### B3 · Default token budget with graceful truncation `P0` · ADR: 0006 · Depends on: none · Status: ☑

**Tasks**
- [x] T0 Write the ADR (must cover: default ceiling constants, grace semantics = "finish verifying what was found", unchanged incomplete/exit-code contract, no in-session compression)
- [x] T1 find default budget: 1.2M reviewer + 0.8M verifier input tokens (tunable constants; `--max-tokens` overrides; `unlimited` is the explicit opt-out)
- [x] T2 Budget hit: no new reviewer round starts, all pending candidates are verified (grace semantics), `stoppedBecause=budget` (an explicit `--max-tokens` stays hard; the grace is scoped to the default role ceilings — ADR 0006)
- [x] T3 `incomplete` semantics and the exit-code contract unchanged

**Acceptance**
- [x] A1 Budget-hit integration test with fake-session injected usage: pending drained, manifest records the budget stop, exit code per contract
- [x] A2 Constants may only be tightened after checking them against a measured per-PR token distribution (recorded as an ADR amendment) — recorded in ADR 0006 as a standing constraint; no constant was tightened

### B4 · Structured verifier rejection grounds `P1` · ADR: 0008 · Depends on: none · Status: ☑

**Tasks**
- [x] T0 Write the ADR (ADR 0008: the `rejectionGround` enum, the asymmetric cost statement, the protected-subject clause, and the audit-mode carve-out)
- [x] T1 `submit_verdict` gains a required-on-reject `rejectionGround` enum (7 values: no-such-code / contradicted-by-code / pre-existing / guarded / speculative / not-introduced-by-change / other; unknown normalizes to `other`; the roadmap's `rejection_ground` spelling is realized as the tool's camelCase parameter — ADR 0008 §1)
- [x] T2 Verifier prompt gains the asymmetric cost statement ("a false kill destroys a real finding ≫ a false keep costs one review pass") + protected-subject clause (concurrency / memory-safety / security rejections must name a contradicting artifact)
- [x] T3 Grounds flow into findings JSON / memory write-back (migration v8) / evaluation result rows (score buckets + results-document table)

**Acceptance**
- [x] A1 Prompt unit tests updated (plus tool-contract, memory round-trip, scorer and renderer tests)
- [x] A2 **Before/after: kill-rate (rejecting a label=1 comment) does not regress — this is B4's merge gate** — measured on a fixed 100-comment sample: falseKillRate 77.1% → 78.6% (one comment, 54/70 → 55/70) with the label-0 kill set identical and five label-1 comments swapping sides; recorded as **not proven either way at this sample's one-comment resolution, no evidence of a systematic increase** (ADR 0008, gate result)

### B5 · Layered user rule file (`.pir/rule.json`) `P1` · ADR: 0010 · Depends on: B1 (include/exclude wiring) · Status: ☑

**Tasks**
- [x] T0 Write the ADR (ADR 0010: three layers with first-match-wins, safe reading of guidance file references and of the repository rule file itself, PROJECT RULES position and byte-stable ordering, division of labor vs language packs and memory, rule hash into the manifest)
- [x] T1 Three-layer loading (`--rule` > repo `.pir/rule.json` > global `<config-dir>/rule.json`) + glob matching through B1's `pathMatchesGlob`; layer-local include/exclude (exclude wins)
- [x] T2 Schema `rules[{path, guidance|guidanceFile, mergeBuiltin}]` + include/exclude; guidance references are repo-relative, extension-allowlisted (`.md`/`.markdown`/`.txt`), 64 KiB-capped and realpath-contained; a symlinked repository rule file cannot escape the repository root; unknown keys and a missing explicit `--rule` fail loudly
- [x] T3 Injection into the reviewer prompt as a `PROJECT RULES` section (after the process rules, before the built-in language guidance and the memory pack; evidence-not-instructions preamble; groups sorted by glob and file lists sorted for byte stability; `mergeBuiltin=false` withholds the pack guidance for the run)
- [x] T4 Canonical rule-text hash into the run manifest (`projectRules` in `run.json`); `pir config show [--json] [--cwd <repo>]` prints the effective layers, rules and hash

**Acceptance**
- [x] A1 Unit tests: layer precedence / merge semantics / mutual exclusion with language packs (`tests/unit/project-rules.test.js` + `tests/integration/project-rules.test.js`; 24 model-free cases)
- [x] A2 Dogfood using a rule file to constrain pir's own PRs — final pass `41f9b807-4bb0-458f-acfb-3c60a4366985` (`zai-coding-cn/glm-5.3:max`, explicit `--rule` with `src/rules/**` `mergeBuiltin=false`) reported P3-only findings (F-8, F-9); F-1/F-2/F-4/F-5 were fixed during the loop, F-3/F-6/F-7/F-8/F-9 are deferred to `dogfood-p3-backlog.md`

---

## 2. Dependencies

```
B1 (filter gate) ──→ B5 (rule file include/exclude)
B2 and B3 have no dependencies; run in parallel
```

## 3. Research background

For the full research interpretation see the companion document **[ocr-borrowings-context.md](ocr-borrowings-context.md)**: OCR's philosophy and per-mechanism deep dive (§1, with the §1.4 source-location quick reference), the pir baseline (§2), the comparison table and the deliberate non-borrow list (§3), risks R1–R3 (§4), and the research method (§5). **When writing each item's T0 ADR, draw the Context material from that document.**

The load-bearing conclusions (details in the companion document):

- OCR = deterministic engineering × agent hybrid; its recall is deliberately low, which fixes how any external comparison of the two systems must be read.
- What pir already leads on, we do not borrow: per-candidate falsifying verifier with evidence gate, SQLite memory, finding fingerprints, the JSON envelope contract, the rb eval skeleton.

Borrowing focused on the gaps: filter gate (B1), location correction (B2), default budget + graceful truncation (B3), verifier rejection grounds (B4), rule file (B5).

## 4. Change log

| Date | Item | Change | Reason / link |
| --- | --- | --- | --- |
| 2026-10-19 | all | Roadmap created (ADRs deferred to each item's execution) | OCR/aacr-bench research + pir baseline survey; ADR timing adjusted per maintainer |
| 2026-10-19 | all | Companion context document added; §5 converted to a reference | Detailed research interpretation moved to `ocr-borrowings-context.md`; the roadmap keeps only tracking duties |
| 2026-10-19 | all | Converted both documents to English (matching repo docs convention); Chinese versions removed | Maintainer request |
| 2026-10-19 | Iteration 1 | B1, B2, B3 and the M0 skeleton executed and merged into the roadmap integration branch; ADRs 0004–0007 written; milestone and item statuses synced | Merges: B3 #114, B2 #115, B1 #116, M0 #117; each passed its own dogfood gate (P0–P2 fixed, P3s deferred to `dogfood-p3-backlog.md`) |
| 2026-10-19 | B4 | Structured verifier rejection grounds landed (ADR 0008): required-on-reject enum, cost asymmetry + protected-subject prompt clauses, ground carried to the envelope/memory/results; before/after gate run recorded | Merge: #120; dogfood skipped for the iteration phase per the task instruction; CI green |
| 2026-10-19 | M0 | Full corpus run (2,134 head-anchorable comments, both arms) on the post-B4 build; 122 captured head commits are no longer fetchable (force-pushed PRs) and are counted as error rows; results committed | Merge: #122; `results/M0-2026-10-19-full.md` |
| 2026-10-19 | M1 | Skeleton landed (ADR 0009): pinned fixture builder, normalizer, `run-aacr.js`, upstream judge delegation; `--limit 20` smoke round recorded; full run and `results/M1-*.md` stay Iteration 3 | Merge: #121; M1 stays ◐ until A1 |
| 2026-10-19 | All | Testing model moved to `zai-coding-cn/glm-5.3:max` (max thinking) for the full-corpus M0 round and the M1 smoke; the earlier opencode-go deepseek attempt was abandoned rather than mixed | Maintainer direction after the opencode-go account usage limit was exhausted; each round stays single-model and names its model in its results file |
| 2026-10-19 | Iteration 2 | Milestone closed: M0 full report, B4 and the M1 smoke merged into the roadmap integration branch; ADRs 0008–0009 written; statuses synced | This PR |
| 2026-10-20 | B5 | Layered project rule file landed (ADR 0010): three layers with first-match-wins, contained rule/guidance reads, `PROJECT RULES` injection, canonical hash in the manifest, `config show` output; dogfood found and fixed four P0–P2-class issues (F-1/F-2/F-4/F-5) and deferred five P3s | Merge: #124; `feat/b5-layered-rule-file` |
| 2026-10-20 | Iteration 3 / M1 | Iteration 3 paused: B5 merged; the M1 full sweep was sampled and stopped (57/196 completed, 105 findings, 3 unfetchable heads) and its judging stopped with it. The resume state (round data location, `feat/m1-full-results` infra, `--judge-only` command) is recorded under §2 M1; A1 and the milestone stay open | Maintainer: "暂时不用继续 … 在这个 docs 结束后再进行" + "抽样即可, 不用每一个都测了"; the roadmap records the pause so the next session does not re-spend tokens |
| 2026-10-20 | Iteration 4 / M2 + D-B6–D-B8 | M2 baseline lock-in and change protocol: the fixed 50-PR subset (`--limit 50 --seed 42`, digest `754ae13a…`) is implemented in the M1 driver with provenance guards and tests; `results/RESULTS.md` carries the baseline decision, the protocol, the north-star dashboard and the registry; ADR 0009 §11 records the protocol. All three decision points were evaluated and **rejected** on data (ADRs 0011–0013). T1's numeric M1 baseline (T1b) stays open with the parked M1 sweep; A1 is entered with the B4 M0 comparison | This PR |
| 2026-10-20 | M2 T1b | M1 baseline locked on the fixed 50-PR subset: round `2026-10-20-m1-baseline-glm` (49/50 instances evaluated, the one miss an unfetchable force-pushed head; 102 findings; judge `glm-5.3` × 3 rounds × 2 views; `balanced_score` 0.1663 reported / 0.1647 confirmedOnly) rendered as `results/M1-2026-10-20-baseline-glm.md`; RESULTS dashboard and roadmap filled. P3 F-7/F-8 drained (renderer population pins, RESULTS provenance wording) | This PR |
| 2026-10-22 | all | Removed the AACR-Bench benchmark track (M0/M1/M2), its data-triggered decision points and the M1 A2 upstream-contribution item; the roadmap now tracks the OCR borrow track (B1–B5) only. The evaluation code under `tests/eval/aacr/` and the committed results files stay in the repository as historical artifacts; ADR 0009 §10 keeps only the "does not modify upstream" scope boundary | Maintainer direction: the roadmap applies upstream ideas inside pir; it does not integrate or contribute to the upstream benchmark |
