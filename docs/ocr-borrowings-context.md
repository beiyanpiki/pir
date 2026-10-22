# OCR borrowings: research context (roadmap companion)

> This document is the companion context for
> [roadmap-ocr-borrowings.md](roadmap-ocr-borrowings.md).
> It records the full research interpretation, the pir baseline, the
> comparison conclusions, and the risk register.
> **Role: source material for each roadmap item's ADR Context.** When an
> item's ADR is written at execution time, it draws its argumentation and
> source locations from here; once merged, the ADR absorbs what it needs.
> **Lifecycle: tied to the roadmap** — when the roadmap is deleted under its
> top-of-file preconditions, confirm that still-referenced content has been
> absorbed into the ADRs, then delete this document along with it.
> Research date: 2026-10-19. Sources and local copies: §5.

---

## 1. OCR (open-code-review) research interpretation

### 1.1 Project profile and design philosophy

alibaba/open-code-review (`ocr`): implemented in Go, ~134k lines of source
across 506 `.go` files, 315 test files (~2,863 test functions; the Makefile
enforces a 90% coverage floor). It originated as Alibaba's internal official
AI review assistant serving tens of thousands of developers for two years
before being open-sourced in 2026. Form factors: a CLI
(`ocr review/scan/config/session/delegate`), a GitHub Action, VSCode/IDEA
extensions, host-agent plugins (Claude Code / Codex / Cursor / Kimi /
OpenCode), and a local viewer.

**Core philosophy: Deterministic Engineering × Agent Hybrid.** Their
diagnosis of the three pain points of general-purpose agents doing review:
incomplete coverage (agents cut corners on large changesets), position
drift (comments not matching actual code locations), and unstable quality
(minor prompt variations swinging quality). Root cause: **a purely
language-driven architecture lacks hard constraints on the review
process.** The division of labor: whatever must not go wrong is handled by
engineering code; only dynamic decisions go to the LLM.

Their published evaluation shows: with the same underlying model, ~1/9
the tokens of a general-purpose agent, materially higher Precision and F1,
and **deliberately lower Recall** — trading recall for low noise is an
explicit product decision (stated in the README).

### 1.2 The full pipeline

The `ocr review` pipeline (`Agent.Run`, `internal/agent/agent.go:284`):

```
git diff (3 modes) → six-gate file filter (pure code) → semantic grouping
(one LLM call, metadata only) → concurrent sub-agents (per group: optional
Plan phase → ≤2 tool-loop rounds → per-round reflection filter) → comment
positioning (local algorithms + LLM fallback) → output (text/JSON/SARIF)
```

- **Diff acquisition** (`internal/diff/git.go`): workspace (staged +
  unstaged + untracked; untracked files get hand-synthesized full-add
  diffs) / commit (`git show --diff-merges=first-parent`) / range
  (merge-base..to); `-U3 --find-renames`; refs are frozen into immutable
  commit SHAs up front (feeding resume identity checks).
- **Input injection**: diffs of *all* changed files (including filtered
  ones) are pre-parsed into a DiffMap that the `file_read_diff` tool can
  query — the model knows globally what changed, but out-of-group patches
  never enter the prompt body.

### 1.3 Key mechanisms in depth (with source locations)

#### The six-gate file filter (`internal/agent/selection.go`)

Fixed priority: binary → **secret paths** (not rescuable by any user rule:
`.ssh/**`, the `id_rsa` family, `.netrc/.npmrc/.pypirc/.dockercfg`, the
`.env` family with `.env.example/.sample/.template` exempt) → user exclude
→ user include (bypasses the two gates below) → extension allowlist →
built-in default excludes (~100 globs: tests / generated code `.pb.go` /
lockfiles / build outputs / snapshot fixtures). Post-gates: `deleted`
(kept as context, never dispatched) and single-file diff tokens > 80% of
MAX_TOKENS → `too_large`. **`--preview` and the real run call the same
`selectFiles` pure function** — what you preview is what gets reviewed.
A provider-level directory blacklist additionally exists (`.git`,
`vendor`, `node_modules`, `target`, …; root-prefix match, *not*
overridable by include — preview reports `provider_directory` vs
`default_path`, a user-visible distinction).

#### Semantic grouping (`internal/agent/grouping.go`)

- Decision tree (`config/template/template.go:127`): ≥4 files → LLM
  grouping; else total churn < 200 lines → bundle-all; else per-file.
- **The LLM sees metadata only**: `[0] MODIFIED src/a.go (+120/-5)` lines,
  no diff content; it returns groups **by integer index**
  (`[{label, files:[0,3]}]`) — an order of magnitude fewer tokens than
  paths, and truncation-resistant. Grouping semantics live in the prompt:
  same module, producer–consumer (interface and implementation), i18n /
  config variants bundled together.
- **Deterministic guards**: ≤10 files per group; a group over the 80%
  token ceiling is split back to single files; any file the model failed
  to assign gets its own single-file group; a parse failure falls back to
  per-file dispatch wholesale ("best-effort optimisation, never a
  correctness gate").
- In-group paths are sorted into a stable key (session key and
  prompt-cache affinity keys derive from it).

#### Subtask dispatch and context isolation (`agent.go:629`, dispatchSubtasks)

One goroutine per group, default concurrency 8, per-group panic recovery
(a failure counts only as `subtaskFailed` and never sinks the run);
in-group diffs are concatenated as `<file path="...">` XML, **out-of-group
changes appear only as `STATUS path (+N/-M)` metadata lines** — the model
knows the global picture but cannot read other groups' patches, blocking
cross-group comment drift. Multi-rule groups wrap each block in
`<rules for="path1,path2">`; single-rule groups emit bare text for byte
stability (provider prefix caching).

#### The Plan phase (optional; `template.go:67`, PlanRequired)

Dual threshold: a single file ≥ 50 changed lines, or the group ≥ 100.
The plan is plain text (numbered issues + a tool-call plan); tools are
text references only, never invoked. **Rounds 2+ deliberately strip the
plan block** — the comment says it outright: "a plan tends to act as a
coverage ceiling once the obvious issues are found."

#### The distilled toolset (`internal/config/toolsconfig/tools.json`)

Six tools: `code_search` (git grep, ≤100 hits, 10s timeout), `file_read`
(≤500-line window + truncation flag), `file_read_diff` (any changed file,
including filtered ones), `file_find` (≤100 paths), `code_comment` (the
single structured output channel), `task_done`. All read-only plus
structured output — no shell, no file writes; every tool has hard output
caps so results can't blow up the context; the scan scenario drops
`file_read_diff` (pointless there — wastes rounds). The README credits
the design to mining production tool-call traces (frequency
distributions, per-tool repetition rates, impact of new tools on the call
chain).

#### The three-tier comment-positioning chain (`internal/diff/resolver.go`)

**The LLM never supplies line numbers — it supplies an `existing_code`
snippet; lines are computed locally:**

1. Same-file hunk sliding-window match: new side (context + added) first,
   old side as fallback; line normalization (TrimSpace, strip `+/-`
   prefixes, skip blanks) makes the model's whitespace sloppiness
   irrelevant; hunk failure falls back to a whole-file sliding window.
2. Cross-file relocation (`RelocateAcrossFiles`): plain string match
   across all diffs; **relocate only on a unique hit (path + line);
   zero or multiple hits are both rejected.**
3. LLM fallback (RE_LOCATION_TASK): the model must copy diff lines
   VERBATIM (`/no_think` to disable thinking); the fresh snippet
   temporarily replaces the old one and parsing reruns; on failure the
   original is restored.

A viewer-side rule completes the philosophy: when the line gutter cannot
be trusted, show no gutter — a wrong gutter is worse than none.

#### Comment reflection (`agent.go:1798`; prompts/review_filter_task_*.md)

After each main-loop round, that round's **new** comments go through an
independent REVIEW_FILTER LLM call. Core design:

- **Asymmetric costs** (prompt text): "Keeping an incorrect comment costs
  a reviewer a few seconds of attention. Removing a correct comment
  silently destroys a real finding… when your evidence falls short of
  proof, approve."
- Exhaustive deletion grounds: **Ground A** (the code the comment
  describes does not exist in the subject file's diff) and **Ground B**
  (a single diff line in any in-group file literally contradicts the
  comment's core claim).
- **Protected-subject veto**: memory safety / concurrency / link
  consistency / behavior compat — "On a protected subject you do not get
  to be confident. Approve."
- Forced tool choice: `report_incorrect_comments(analysis, comment_ids)`
  vs `approve_all_comments()`. **The argument field order is
  load-bearing** — session replays showed that when `analysis` follows
  `comment_ids`, models pick ids first and cannot walk them back (long
  comment at agent.go:1577).

#### The three-tier token budget and controlled truncation

Anchored to MAX_TOKENS=200000 (input) / MAX_COMPLETION_TOKENS=16384
(output; deliberately separate):

1. Per-prompt hard gate at 80% (`PromptTokenLimit`).
2. In-session three-zone compression (`llmloop/compression.go`): 60%
   triggers asynchronous background compression, 80% synchronous;
   partitions are frozen (first 2 messages — anchors the system + first
   user message for cache hits) / compress (a five-dimension structured
   summary re-injected as `<previous_review_summary>`) / active (the
   most recent K complete rounds kept per budget).
3. Run-level aggregate budget with pre-dispatch per-group look-ahead
   (over-budget groups are skipped along with everything after them;
   in-flight groups run to completion; overshoot ≤ concurrency).

**Grace round** (`loop.go:564`): after rounds or budget are exhausted,
one final round keeps only code_comment + task_done and injects "Your
review budget is exhausted. This is your FINAL round." **Budget
exhaustion is a controlled truncation, not a run failure** — the terminal
state derives from coverage; any coverage at all still exits 0.

#### Resume and the RunManifest (`internal/session/`)

- File-level checkpoint = content fingerprint
  `sha256(mode ∥ oldPath ∥ newPath ∥ diffText)` — a moved ref changing
  the diff invalidates it.
- **The RunManifest (`ocr.run-manifest/v1`) is the single source of truth
  for coverage**: five disjoint sets
  (selected/completed/reused/failed/waived); `SealSelected` freezes the
  denominator before dispatch; the terminal state (complete/partial/
  failed) **derives from coverage only, never from warnings**.
- Resume identity checks (session/resume_identity.go): mode, repo
  identity, `source_artifact_sha256` (length-prefixed hash over the
  selected set's (item_id, fingerprint) pairs), and `rule_config_sha256`
  (rule texts + filters) must all match; an implicit provider/model
  drift requires explicit `--provider/--model` flags to resume
  (preventing silently mixing results from two models with no field to
  tell them apart); the check must run *before* `session.New` (else
  rejected resumes leave orphan sessions).
- Idempotency: a checkpoint line counts only if the parent manifest also
  records that fingerprint as completed/reused — lost JSONL lines and
  torn writes are harmless; the manifest is the truth.

#### The rules system (`internal/config/rules/system_rules.go`)

Four layers: `--rule` > repo `.opencodereview/rule.json` > global
`~/.opencodereview/rule.json` > built-in (55 per-language/file-type rule
docs embedded in the binary). Schema:
`rules:[{path glob, rule, merge_system_rule}]` + include/exclude;
order-preserving deserialization (declaration order = match priority;
a streaming JSON decoder avoids Go map shuffling); content sniffing for
`.m` files (Objective-C vs MATLAB, decorating only the system layer so
it can't override user rules); rule-file references are read as
untrusted input (512KB cap, extension allowlist, symlink + repo-escape
checks); `CanonicalConfig()` hashes into the manifest for
reproducibility. **Injection is glob-decided — which rule text enters
which file's prompt is deterministic code**, in explicit contrast to
"stuff the standards into the system prompt and let the model sort it
out" — the engineering basis of the README's claim that template-engine
rule matching beats language-driven guidance.

#### Session auditing and the viewer (`internal/session/persist.go`, `internal/viewer/`)

Every LLM request/response/tool call/usage lands in JSONL (uuid +
parentUuid chain). The viewer is read-only replay: TaskCards organized
by file × task type, per-file token breakdowns, cross-run compare;
fixed/ignored marks are browser-localStorage presentation state
(mark-and-hide) and never touch the JSONL. The value proposition: AI
review becomes an auditable, replayable, archivable workflow — several
of OCR's engineering discoveries (the field-order finding above) came
from session replay.

#### Loop control and fault tolerance (`internal/llmloop/loop.go`)

MAX_TOOL_REQUEST_TIMES=100; three consecutive empty rounds stop the run;
MAX_REVIEW_ROUNDS=2 per group (effort low/medium/high → 1/2/3); round 2+
injects the confirmed-findings list to avoid duplicates (capped at 30).
**Escalating tool-failure policy**: 1st failure = plain error, 2nd =
explicit warning, 3rd+ = **pretend it was accepted and skip**, ending
infinite retries (a real case retried the same call 6 times). Argument
parsing tolerates real gateway/model defects (find the first balanced
top-level JSON; repair bare quotes with a triple-verification gate) —
deterministic repair before asking the model to retry.

#### Other points worth knowing

- **Multi-provider**: 4 protocols (anthropic / openai /
  openai-responses / bedrock), 25 built-in providers; Anthropic prompt
  caching with three breakpoints; cache-affinity keys derived per
  (session, taskType, scope) — one key for the whole run would pin
  unrelated concurrent conversations to one cache node.
- **scan (whole-file review) is a fully separate template**: its own
  prompt family and budgets (MAX_TOKENS=58888 etc.), plus DEDUP_TASK
  (intra-batch near-duplicate merging) and PROJECT_SUMMARY_TASK
  (cross-file top issues / hotspots); batches run serially with
  same-language adjacency → prompt-cache hits.
- **Delegation mode**: `ocr delegate preview/rule` emits only the file
  list + exclusion reasons + grouped rules (zero LLM config); the host
  agent executes with its own quota; the skill defines a coverage
  contract (every check item terminates as reviewed or skipped-with-
  reason).
- **MCP**: a client implementation; external tools share the namespace
  with the six built-ins (conflicts skipped with a warning).
- **Security engineering**: ASSURANCE_CASE.md (threat model + four
  trust boundaries); `--end-of-options` on git subcommands against
  injection; `pathutil.WithinBase` validating before and after symlink
  resolution; viewer host allowlist against DNS rebinding;
  `safeSegment` returning the *checked* value instead of a bool (so
  static analysis can prove use-after-check); `sanitizeReason`
  stripping credentials from manifest reasons.
- **The ROADMAP's explicit non-goals**: automated fixing without human
  review, general-purpose coding assistant, self-hosted models.
  Domain-specific long-term memory is on their 2027 H1 plan — pir
  already has it.

### 1.4 OCR source-location quick reference (for ADR citations)

| Mechanism | Location (repo-relative) |
| --- | --- |
| Pipeline orchestration | `internal/agent/agent.go` (`Agent.Run` :284, `dispatchSubtasks` :629, `executeGroupSubtask` :1379) |
| Six-gate filter | `internal/agent/selection.go` (`whyExcluded` :70) |
| Semantic grouping | `internal/agent/grouping.go` (`groupDiffs` :68; guards :22/:323/:345) |
| Tool loop | `internal/llmloop/loop.go` (`RunMainTask` :380; grace round :564) |
| Three-zone compression | `internal/llmloop/compression.go` (thresholds :21-31; partitioning :132-163) |
| Comment positioning | `internal/diff/resolver.go` (`ResolveComment` :62, `RelocateAcrossFiles` :100) |
| Comment reflection | `internal/agent/agent.go` :1798 + `internal/config/template/prompts/review_filter_task_system.md` |
| Template & budget constants | `internal/config/template/task_template.json` + `template.go` |
| RunManifest / resume | `internal/session/manifest.go`, `resume.go`, `resume_identity.go` |
| Rules system | `internal/config/rules/system_rules.go` |
| Main prompt | `internal/config/template/prompts/main_task_system.md` (26 lines; the Strict Focus Rules section defines the `<review_files>` contract) |
| Official architecture doc | `pages/src/content/docs/en/architecture.md` |

---

## 2. The pir baseline (the other side of the comparison)

> This section is the "current state" anchor for executing the borrow
> items; for the full implementation docs see `docs/design.md` and
> `docs/review-loop.md`.

**Architecture**: TypeScript (ESM) on the Pi coding agent SDK; 76 files /
~20k lines under src/; three form factors share one engine (the `pir`
CLI, the Pi extension's `/review-*` commands, and `pir serve` over
HTTPS). All model calls go through the Pi SDK's ModelRuntime — no direct
OpenAI/Anthropic SDK dependency.

**The review loop** (`src/core/supervisor.ts`): find (`findIssues` :456)
loops buildChangeSet (`git diff -M -U3` over merge-base..head) → reviewer
rounds (**each round a fresh isolated session**; tools: get_change,
read_code, search_text, find_symbol, find_callers, find_callees,
find_references, memory tools, record_candidate, finish_round) →
concurrent drainVerifications (default 1, cap 8, results posted in strict
admission order) → applyVerdict. Stop conditions: maxFindings, the
reviewer's completion signal, shouldStop (rounds/tokens/wall clock/two
rounds without new information); a coverage round is forced once per run
if the reviewer signals done with unread hunks. audit (`auditIssues`
:1007) plans work units (≤5 files / ≤1200 lines each) and keeps a
CoverageLedger.

**Verifier and evidence gate** (`src/agents/verifier.ts`;
`src/tools/collector-tools.ts:199-270`): per-candidate falsification
("Reviewer assertions are hypotheses, not facts"); **hard evidence
gate** — a submit_verdict with zero pinned reads and zero evidence calls
in the session is rejected at the tool boundary, and the rationale must
cite a pinned-read path verbatim. Verdicts: confirmed (a concrete
current failure plus change causation both hold) / rejected (a concrete
counter-example exists) / uncertain (missing-evidence or tool-limit; no
guessing) plus confidence 0..1.

**Repository memory** (`src/memory/`, SQLite per projectId):
project/feature/entity tiers plus issue_memories (user decisions with
trust tiers user_explicit / verified_fix / agent_summary) and verified
fixes; **the review agents only read memory**; buildMemoryPack injects
~4000 tokens by default; **issue decisions deliberately never enter the
reviewer pack — verifier-only** (preventing historical bias from
suppressing discovery); matchIssueHistory: fingerprint → scope → fuzzy
claim.

**Location handling today** (`collector-tools.ts:69-98`):
`record_candidate` trusts the model's line numbers, validating only
positive integers, ordering, and the head-commit file length (via a
pinned `git show <commit>:<path>` read); there is no excerpt/snippet
mechanism.

**Filtering today**: find has **zero filtering** (binary files enter as
hunk-less entries); audit has versioned three-layer filtering
(`src/changes/snapshot.ts:63-94`: DEFAULT_SKIP_PATTERNS /
BINARY_EXTENSIONS / size gates) plus `--dry-run --list-files` preview;
glob matching is a homegrown DP matcher (`pathMatchesGlob`).

**Output contract**: the `--json` envelope (`{schemaVersion, command,
project, data}`); finding views carry id/displayId/title/claim/trigger/
category (11 values)/severity (P0-P3)/status/anchors/evidence/
memoryMatches/verifierRationale/confidence; stdout is pure JSON,
progress goes to stderr, exit codes 0/1/2/3 are stable. **The eval
harness already consumes it as an interface.**

**Loop control today**: `Budget` accumulates measured usage per session,
but there is **no default token ceiling**; maxRounds defaults to 2; no
cross-interruption resume for find (audit has data-level checkpoints:
candidates persist on discovery, plus the ledger).

**Finding identity and dedup** (`src/findings/identity.ts`):
fingerprint = sha256(featureKey ∥ entityKey ∥ category ∥ normalizedClaim
∥ normalizedTrigger) — a line-number-independent stable identity; dedup:
exact fingerprint, or same entity + category with claim similarity ≥0.82.

**Eval infrastructure** (`tests/eval/`, gated by `PIR_EVAL=1`): (1) a
synthetic-scenario harness (13 labeled fixtures, maximum-cardinality
one-to-one matching for P/R/F1, baseline/candidate A/B); (2) the
**ReviewBench real-PR benchmark** (`tests/eval/reviewbench/`; ADR-0003's
local-only stance): 25-PR fixtures + frozen mirrors + `run-rb.js`
(spawning `pir find --json` with full env isolation: HOME/XDG, cold
`PIR_MEMORY_DB` per task, PIR_TRANSCRIPTS=0) + `normalize.js` (envelope
→ judge format) + `prefilter.js` (deterministic advisory matching) +
`judge.js` (delegating to the upstream official judge) + the RESULTS.md
protocol (variance rules: judge drift voids comparisons).

---

## 3. pir vs OCR: the full comparison and conclusions

| Dimension | OCR | pir | Conclusion |
| --- | --- | --- | --- |
| False-positive filtering | Per-round REVIEW_FILTER (asymmetric deletion, Grounds A/B) | Per-candidate falsification + evidence gate + continuous confidence | **pir leads**; borrow the asymmetric wording and exhaustive grounds → B4 |
| Long-term memory | None (2027 roadmap) | SQLite three tiers + decision write-back + trust levels | **pir leads**; not borrowed |
| Comment positioning | Snippet anchoring + three-tier local resolution | Trusts LLM line numbers + range validation | **Gap** → B2 (same-file sliding-window tier only) |
| File filtering | Six gates on find + secret paths | Zero filtering on find; full filtering on audit | **Gap** → B1 (sink the audit logic into a shared module) |
| Token budget | Three tiers + grace round + controlled truncation | Budget exists but no default ceiling | **Gap** → B3 (run-level default budget + "verify the pending" grace) |
| User rules | Four-layer rule.json + globs + manifest hash | None (approximations: memory invariants / language packs / feedback) | **Gap** → B5 |
| Context slicing | LLM semantic grouping + deterministic guards | find: single session + frontier; audit: work units | Partially equivalent → D-B6, data-decided |
| Output contract | text/JSON/SARIF + exit codes | JSON envelope + exit codes (externally consumable) | Equivalent (SARIF deferred) |
| Session auditing | Full JSONL + viewer replay/marks/compare | PIR_TRANSCRIPTS (off by default) + run manifest + web findings | Partially equivalent → D-B7 |
| Coverage accounting | RunManifest's five sets, frozen denominator, coverage-derived terminal state | Audit has the ledger; find is weaker | → D-B8 |

**Deliberate non-borrowings** (with reasons — do not re-litigate in
ADRs):

- **Delegation mode**: pir's positioning is "engine + service"; skill
  distribution and the JSON envelope contract are the equivalent.
- **In-session three-zone compression**: pir opens a fresh session per
  round; long-conversation bloat structurally does not exist.
- **The LLM grouping call**: change review targets single PRs and the
  frontier already steers attention. Any slicing scheme must fail back
  gracefully and never act as a correctness gate (OCR's lesson).
- **Automated fixing**: both projects decline it; pir's verify-fix
  verifies an already-made fix rather than authoring one — same
  boundary.

---

## 4. Risks and open questions (check each during execution)

| # | Risk | Impact | Mitigation (land it during execution) |
| --- | --- | --- | --- |
| R1 | B2's gradual adoption mixes metrics (excerpt vs non-excerpt) | Acceptance reading | Report every correction metric in two calibers: excerpt-bearing subset and overall |
| R2 | A too-low B3 default silently degrades large-PR quality | User perception | Tighten constants only after checking a measured per-PR token distribution; keep the explicit `--max-tokens unlimited` exit |
| R3 | B4's protected-subject clause over-protects → false keeps rise | Merge-gate metrics | Track kill-rate *and* intercept-rate together; the merge gate is explicit in the roadmap |

---

## 5. Research method and materials

- **OCR source**: `git clone --depth 50
  https://github.com/alibaba/open-code-review`, head commit `8eb8334`
  (as of 2026-10); four parallel subsystem deep-reads (pipeline / agent
  internals / rules & ecosystem / output & sessions) plus manual
  verification of key files (README, ASSURANCE_CASE, architecture.md,
  main_task_system.md, ROADMAP).
- Local copies (temporary, rebuildable): `/tmp/open-code-review`.
- The pir baseline (§2) comes from a full survey of this repository's
  dev branch (as of a35e4b4): module-by-module reading of
  supervisor/agents/memory/findings/changes/tools/cli/tests plus the
  three SKILL.md files.
