# Roadmap: OCR borrowings × AACR-Bench integration (tracking file)

> **⚠️ This file is a temporary tracking artifact: delete it once every item below is ☑.**
> **Companion context: [ocr-borrow-and-aacr-benchmark-context.md](ocr-borrow-and-aacr-benchmark-context.md)** — the full research interpretation (OCR mechanisms with a source-location quick reference, the pir baseline, the dimension-by-dimension comparison, the AACR-Bench assets and metric methodology, risks R1–R10, and the research method). Each item's ADR draws its Context from that document; this file tracks execution only and carries no research detail.
> Deletion preconditions: (1) every executed item's ADR is merged under `docs/adr/` (numbering continues in sequence), with this file acting only as an index; (2) any §3 decision point that was kicked off has its own ADR; (3) baseline numbers are persisted in `tests/eval/aacr/results/` and the relevant ADR/RESULTS documents, with nothing depending on this file's narrative; (4) content of the companion context document that is still referenced has been absorbed into the ADRs — then delete that document together with this file.
>
> Status legend: `☐ not started` · `◐ in progress` · `☑ done` · `⏸ parked (reason noted)` · `➜ decision point (awaiting data)` · `✗ rejected (data trigger did not fire; ADR linked)`
> **ADR rule: each item writes its ADR (Status: Proposed) when execution starts, and flips it to Accepted when the implementation PR merges; at that point replace `ADR: written at execution` in the item header with the actual number. This file tracks execution; it does not replace the ADR.**
> Research sources: alibaba/open-code-review @ `8eb8334`, alibaba/aacr-bench, HF `Alibaba-Aone/aacr-bench` (all Apache-2.0; data use requires citing arXiv 2601.19494). Research conclusions are summarized in §5.
> **Update rule: check off each task as it completes and append a row to §6; when status and reality diverge, code wins — fix this file immediately.**

---

## 0. Milestones

| Milestone | Items | Status | Definition of done |
| --- | --- | --- | --- |
| Iteration 1 | B1, B2, B3, M0 skeleton | ☑ | B1–B3 merged to the iteration's declared integration branch (`roadmap/ocr-borrow-and-aacr-benchmark`) through the dogfood gate; M0 `--limit 100` produced its first numbers; ADRs 0004–0007 written |
| Iteration 2 | M0 full run, B4, M1 skeleton | ☑ | M0 full 2,145-comment report + OCR-prompt comparison; B4 merged with no kill-rate regression; M1 `--limit 20` smoke passes |
| Iteration 3 | M1 full run, B5 | ⏸ | B5 merged (#124); the first M1 report is deferred by maintainer direction — the sampled round stopped at 57/196 on 2026-10-20 and its resume state is recorded under §2 M1 |
| Iteration 4 | M2 baseline lock-in, D-B6/D-B7/D-B8 decisions | ☑ | Change protocol in effect (`results/RESULTS.md`); all three decision points have data-backed **reject** records (ADRs 0011–0013); M1 baseline locked on the fixed 50-PR subset (round `2026-10-20-m1-baseline-glm`: 49/50 instances evaluated, judge `glm-5.3` × 3 rounds × 2 views, `balanced_score` 0.1663 reported / 0.1647 confirmedOnly) |

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
- [x] A3 `FindingView` emits the correction flag (the M1 calibration split lands with M1's normalization; the flag and the two ranges are already in the envelope)

### B3 · Default token budget with graceful truncation `P0` · ADR: 0006 · Depends on: none · Status: ☑

**Tasks**
- [x] T0 Write the ADR (must cover: default ceiling constants, grace semantics = "finish verifying what was found", unchanged incomplete/exit-code contract, no in-session compression)
- [x] T1 find default budget: 1.2M reviewer + 0.8M verifier input tokens (tunable constants; `--max-tokens` overrides; `unlimited` is the explicit opt-out)
- [x] T2 Budget hit: no new reviewer round starts, all pending candidates are verified (grace semantics), `stoppedBecause=budget` (an explicit `--max-tokens` stays hard; the grace is scoped to the default role ceilings — ADR 0006)
- [x] T3 `incomplete` semantics and the exit-code contract unchanged

**Acceptance**
- [x] A1 Budget-hit integration test with fake-session injected usage: pending drained, manifest records the budget stop, exit code per contract
- [x] A2 Constants may only be tightened after checking them against the M1 per-PR token distribution (recorded as an ADR amendment) — recorded in ADR 0006 as a standing constraint; no constant was tightened

### B4 · Structured verifier rejection grounds `P1` · ADR: 0008 · Depends on: M0 skeleton · Status: ☑

**Tasks**
- [x] T0 Write the ADR (ADR 0008: the `rejectionGround` enum, the asymmetric cost statement, the protected-subject clause, M0's kill family as the merge gate, and the audit-mode carve-out)
- [x] T1 `submit_verdict` gains a required-on-reject `rejectionGround` enum (7 values: no-such-code / contradicted-by-code / pre-existing / guarded / speculative / not-introduced-by-change / other; unknown normalizes to `other`; the roadmap's `rejection_ground` spelling is realized as the tool's camelCase parameter — ADR 0008 §1)
- [x] T2 Verifier prompt gains the asymmetric cost statement ("a false kill destroys a real finding ≫ a false keep costs one review pass") + protected-subject clause (concurrency / memory-safety / security rejections must name a contradicting artifact)
- [x] T3 Grounds flow into findings JSON / memory write-back (migration v8) / M0–M1 result rows (score buckets + results-document table)

**Acceptance**
- [x] A1 Prompt unit tests updated (plus tool-contract, memory round-trip, scorer and renderer tests)
- [x] A2 **M0 before/after: kill-rate (rejecting a label=1 comment) does not regress — this is B4's merge gate** — measured on the fixed 100-comment sample (`results/M0-2026-10-19-b4-before-after.md`): falseKillRate 77.1% → 78.6% (one comment, 54/70 → 55/70) with the label-0 kill set identical and five label-1 comments swapping sides; recorded as **not proven either way at this sample's one-comment resolution, no evidence of a systematic increase** (ADR 0008, gate result)

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

## 2. Benchmark track (AACR-Bench)

Everything lands under `tests/eval/aacr/`, gated by `PIR_EVAL=1`; upstream assets pinned by sha256 (meta.json convention, data files gitignored and auto-downloaded). Scoring and metric caliber are fixed in M0's ADR at kickoff; the existing ADR-0003 stance (ReviewBench for local evaluation) continues to apply.

### M0 · Verifier offline benchmark (reflection test set) `P0` · ADR: 0007 · Status: ☑

**Tasks**
- [x] T0 Write the ADR (must cover: the `_verify-comment` internal command and its mapping contract, uncertain=keep as the primary scoring policy, kill-rate as the north-star metric, the OCR-prompt comparison arm, the delegate-to-upstream-judge stance, cost and citation obligations)
- [x] T1 Data acquisition script: HF `dataset.json` download + sha256 pin + citation notice written into output headers
- [x] T2 Materialization (one-off, cacheable): shared clone cache for the 50 repos → checkout target commit → per-comment diff + head file extraction → intermediate JSONL (fetch failures become error rows, never aborts)
- [x] T3 Internal command `pir _verify-comment` (underscore prefix, outside the stable contract): fixed comment→CandidateFinding mapping (title = first sentence / claim = full note / trigger empty / category mapped / severity P2 / anchor = line range / evidence = driver-supplied diff excerpt), wrapping `runVerifier`
- [x] T4 Eval driver: spawn the command with rb-grade env isolation (HOME/XDG / per-task cold `PIR_MEMORY_DB` / `--plugins none` / `--local`)
- [x] T5 Scoring `score.js` (pure function): uncertain=keep primary policy + strict variant, accuracy/P/R/F1, confidence AUC, kill-rate north star; buckets by source_model / category / context / is_ai_comment
- [x] T6 OCR reflection-prompt comparison arm (port `review_filter_task_system.md`, with attribution)
- [x] T7 `--limit 100` sampled first run → full corpus in iteration 2 (the `--limit 100 --seed 42` round ran in Iteration 1; the 2,134 head-anchorable comments ran post-B4 and are committed as `results/M0-2026-10-19-full.md` with the OCR comparison arm)

**Acceptance**
- [x] A1 First `results/M0-*.md` (protocol copied from rb RESULTS: per-bucket metrics, sample sizes, model versions, variance notes, arXiv citation) — `tests/eval/aacr/results/M0-2026-10-19-limit100.md`

### M1 · End-to-end benchmark `P1` · ADR: 0009 · Depends on: M0 skeleton, B1 (B1's effect measured by M1) · Status: ◐

**Tasks**
- [x] T0 Write/extend the ADR (ADR 0009: reference comments are label=1 only, judging delegated to the upstream judge (no self-built judge), balanced_score as the external caliber, the two views, the materialization decision incl. the synthetic head)
- [x] T1 Fixture conversion: upstream `positive_samples.json` → `fixtures/test-set.json` (196 tasks / 1,506 comments; instance_id `owner__name@head7`; the body is derived upstream data and stays gitignored — only the builder, the sha256 pin and the citation are committed)
- [x] T2 `run-aacr.js` (clone of rb `run-rb.js`): shared-cache repos, detached checkout → spawn `pir find --base --head --max-rounds 2 --max-findings unlimited --json --quiet --local --cwd`; same-repo serial / cross-repo concurrent; 30-min timeout; `--limit/--only/--repeats/--resume/--eval-rounds`
- [x] T3 `normalize-aacr.js` (pure function): envelope → `{path, start_line, end_line, text}`; reported = confirmed + uncertain plus a confirmed-only view; anchor-less findings counted as dropped
- [x] T4 Judging delegation: pinned clone of upstream `judge.py`/`evaluate.py` invoked (`JUDGE_*` controlled, mock first then real; mock verified end to end, real mode needs `JUDGE_*` credentials)
- [x] T5 `--limit 20` smoke run (round `2026-10-19-m1-smoke-glm` on `zai-coding-cn/glm-5.3:max`: 20/20 instances produced rows, 0 errors, 33 reported / 32 confirmed findings, upstream mock judge 20 evaluated / 0 missing; the full 196-PR run + `--eval-rounds 3` averaging is Iteration 3)
- [x] T6 Large-repo materialization strategy landed (M0's shared depth-1 cache + GitHub merge base, with a deterministic synthetic head when ancestry is absent; `--filter=blob:none` documented as the fallback — ADR 0009 §7)

**Acceptance**
- [ ] A1 First `results/M1-*.md`: file-level semantic P/R + **balanced_score (the external comparison caliber)** + missing excluded from denominators + buckets by language / category / PR size — **deferred, resume state below**
- [ ] A2 (Optional) contribute an upstream `reviewers/pir.py` PR once numbers are publishable

**Paused (2026-10-20, maintainer direction: "暂时不用继续 … 在这个 docs 结束后再进行" and "抽样即可, 不用每一个都测了")**

M1 is paused, not abandoned, and the pause state is recorded here so no step depends on memory. What exists:

- The **B5** part of Iteration 3 is done and merged (ADR 0010, PR #124).
- The reviewer side of the full round `2026-10-20-m1-full-glm` was stopped deliberately after **57 of the planned 196 instances** produced both view result files (`zai-coding-cn/glm-5.3:max`, real judge configured but judging stopped with it). Those 57 rows carry 105 reported/confirmed findings, 121.1M session tokens and 17.2h of reviewer wall time; three heads are unfetchable force-pushed commits (`comfyanonymous__ComfyUI@4936d01`, `comfyanonymous__ComfyUI@cfc3122`, `nodejs__node@b225544`) and are error rows. The sample is the first-completed convenience subset, **not a random draw**, so it can seed a first report but must not be recorded as the M2 baseline.
- Judging was started against the pinned upstream judge (`glm-5.3`, `--eval-rounds 3`) and stopped after the first reported-view judge round; no judge verdicts were written back to the round summary.
- The round's reviewer result files and `summary.json` are **kept on purpose**, gitignored, in the paused worktree `.worktrees/m1-full-benchmark/tests/eval/aacr/out/2026-10-20-m1-full-glm` (raw data, not reproducible without re-spending the tokens). They live on this machine, not in git.
- The model-free evaluation infrastructure added during Iteration 3 is preserved on the pushed branch **`feat/m1-full-results`**: the results renderer `tests/eval/aacr/m1/report-m1.js` (headline, buckets, coverage, cost, provenance), the recorded judge model / judge timeout with the "no average file = failure" guard (`limits.judgeModel`, `PIR_AACR_JUDGE_TIMEOUT_MS`), and `run-aacr.js --resume --judge-only` for judging a sampled round without re-running reviewers. ADR 0009 §8 records the timeout/averaging decision.

To resume (after the documentation work this file tracks is finished):

1. Judge the completed rows only: `PIR_EVAL=1 PIR_AACR_CACHE=<cache> JUDGE_BASE_URL=… JUDGE_API_KEY=… JUDGE_MODEL=glm-5.3 PIR_AACR_PYTHON=<python> node tests/eval/aacr/m1/run-aacr.js --round 2026-10-20-m1-full-glm --resume --judge-only --judge real --eval-rounds 3 --view both --model zai-coding-cn/glm-5.3:max`.
2. Render the report from `feat/m1-full-results`: `node tests/eval/aacr/m1/report-m1.js --round <round dir> --out tests/eval/aacr/results/M1-2026-10-20-sampled.md --title "AACR-Bench M1 — first sampled result (57/196 PRs)" --note "…"`; the document must say it is a convenience sample, that the 139 unrun instances are upstream `missing_instances` excluded from every denominator, and that it is not the M2 baseline.
3. Flip A1 and the Iteration 3 milestone here and append the change-log row. **M2 T1 is already complete** (Iteration 4): the baseline population is the seeded 50-PR subset, and round `2026-10-20-m1-baseline-glm` locked it (49/50 evaluated; `tests/eval/aacr/results/RESULTS.md`). If this parked convenience sample is ever judged, render it as a convenience-sample document only — it is not the baseline and not comparable to the subset.

### M2 · Baseline lock-in and change protocol `Iteration 4` · ADR: 0009 §11 (M2 amendment) · Status: ☑

**Tasks**
- [x] T1a Baseline decision + recording: M1's locked population is the fixed 50-PR subset (`--limit 50 --seed 42`, instance-set digest `754ae13a…`, 50 PRs / 29 repos / 333 reference comments); model, judge pins and procedure recorded in `results/RESULTS.md`, plus the parked sample's per-PR reference table (run_id / model / date / scores-when-available / per-PR cost+duration) — the "extend the sample to a seeded 50-PR subset vs rerun the full 196" decision the Iteration-3 pause note deferred to M2 T1
- [x] T1b Baseline score run: round `2026-10-20-m1-baseline-glm` on the locked 50-PR subset (`--limit 50 --seed 42`, digest `754ae13a…`) with the pinned judge (`ee9d7fe`, `glm-5.3`, `--eval-rounds 3`, both views) → [M1-2026-10-20-baseline-glm.md](../../tests/eval/aacr/results/M1-2026-10-20-baseline-glm.md) and the M1 row in `results/RESULTS.md`: 49/50 instances evaluated (one unfetchable force-pushed head excluded from every denominator), 102 findings, `balanced_score` 0.1663 reported / 0.1647 confirmedOnly
- [x] T2 Change protocol: behavioral changes run before/after on the fixed subset — verifier-side changes on M0's fixed 100-comment sample, end-to-end changes on M1's fixed 50-PR subset; `--seed 42` selection is deterministic and recorded, `--resume`/`--judge-only` refuse or replay a different subset; judge drift invalidates the comparison and forces a rerun (rb variance rules copied verbatim)
- [x] T3 Smoke: nightly/manual `--limit 20` documented with its exact command and cost; **not a regular CI gate** (cost stance per ADR-0003)
- [x] T4 North-star dashboard in RESULTS: balanced_score (M1 — 0.1663 reported / 0.1647 confirmedOnly, locked), kill-rate (M0 — locked), per-PR token cost (M1 — 2.65M total tokens/PR mean, 1.75M median, locked)

**Acceptance**
- [x] A1 First before/after comparison recorded under the protocol — the B4 M0 before/after (fixed 100-comment sample, same model, no judge, builds `b6214403` → `64734461`) is entered in the registry with its parameters, result and point-comparison caveat; the first M1 comparison row follows the T1b baseline.

---

## 3. Decision points (data-triggered; write the ADR when kicking off)

| ID | Topic | Trigger (data source) | Action when triggered | Status |
| --- | --- | --- | --- | --- |
| D-B6 | Deterministic slicing of large changesets (find) | M1 shows large PRs (>2000 lines) materially worse on findings density/cost, and B3's default budget hit frequently | Write the ADR, then implement: slice by hunk adjacency, one round per slice, fingerprint dedup across slices; failure must fall back and never act as a correctness gate (OCR's lesson) | ✗ rejected — the fixture has no PR >971 lines and 0/39 local manifests hit a budget stop (ADR 0011) |
| D-B7 | Session-audit enhancements (transcripts on by default + web marking / cost breakdown) | Accumulated debugging / cost-attribution demand, or prompt tuning needing replay evidence | Write the ADR; implement localStorage mark-and-hide (after the OCR viewer) | ✗ rejected — cost attribution ships in the manifest/run summaries, recent debugging used rows/manifests, no recorded replay demand (ADR 0012) |
| D-B8 | Change-mode coverage manifest contract (per-file terminal states) | After B1, the envelope already carries exclusion reasons and automation consumers ask for coverage auditing | Write the ADR: reviewed/skipped/excluded terminal states + incomplete tied to coverage | ✗ rejected — C1's ledger + B1's exclusion record already deliver it; states are derivable and gating `incomplete` would reverse C1 (ADR 0013) |

## 4. Dependency graph

```
B1 (filter gate) ──→ B5 (rule file include/exclude)
B1 ──→ M1 (filter effect measured by M1)
B2 (location correction) ──→ M1 (anchor metrics)
M0 (skeleton) ──→ B4 (merge gate = M0 kill-rate comparison)
M0 ──→ M1 ──→ M2 ──→ D-B6 decision (recorded: ADR 0011)
M2 ──→ D-B7 / D-B8 decisions (ADRs 0012–0013)
B3 and B2 have no dependencies; run in parallel
```

## 5. Research background

For the full research interpretation see the companion document **[ocr-borrow-and-aacr-benchmark-context.md](ocr-borrow-and-aacr-benchmark-context.md)**: OCR's philosophy and per-mechanism deep dive (§1, with the §1.4 source-location quick reference), the pir baseline (§2), the comparison table and the deliberate non-borrow list (§3), the two AACR-Bench assets and metric methodology (§4), risks R1–R10 (§5), and the research method (§6). **When writing each item's T0 ADR, draw the Context material from that document.**

The three load-bearing conclusions (details in the companion document):

- OCR = deterministic engineering × agent hybrid; its recall is deliberately low — any external comparison must use balanced_score (R10).
- What pir already leads on, we do not borrow: per-candidate falsifying verifier with evidence gate, SQLite memory, finding fingerprints, the JSON envelope contract, the rb eval skeleton.
- Borrowing focuses on the gaps: filter gate (B1), location correction (B2), default budget + graceful truncation (B3), verifier rejection grounds (B4); rule file (B5) next; large-PR slicing and two others are data-triggered decision points (§3) — all three were evaluated at Iteration 4 and none fired (ADRs 0011–0013).

## 6. Change log

| Date | Item | Change | Reason / link |
| --- | --- | --- | --- |
| 2026-10-19 | all | Roadmap created (ADRs deferred to each item's execution) | OCR/aacr-bench research + pir baseline survey; ADR timing adjusted per maintainer |
| 2026-10-19 | all | Companion context document added; §5 converted to a reference | Detailed research interpretation moved to `ocr-borrow-and-aacr-benchmark-context.md`; the roadmap keeps only tracking duties |
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
