# ADR 0007: AACR verifier offline benchmark (M0)

## Status

**Accepted (2026-10-19).** Item M0 (Verifier offline benchmark —
reflection test set) of the 2026-10 OCR-borrow series,
Iteration 1. M0 stands alone as a measurement surface; B4 (structured
verifier rejection grounds) consumes its kill-rate/false-kill numbers as a
merge gate under the protocol fixed here.

## Context

M1 of the same roadmap measures the whole `pir find` loop against
AACR-Bench's end-to-end metric, but change-mode precision is decided in
exactly one place: the per-candidate verifier. A find-level score cannot
isolate it. The HF dataset `Alibaba-Aone/aacr-bench` is comment-level ground
truth: 2,145 real review comments (1,505 correct / 640 incorrect,
expert-verified) over 200 PRs in 50 repositories, each carrying `path`,
`side`, `from_line`/`to_line`, `note`, `category` (Code Defect /
Maintainability and Readability / Performance / Security Vulnerability),
`context` (Diff / File / Repo Level), `is_ai_comment` and `source_model`.
That is verifier binary-classification material by construction, and its
official positioning — "evaluate the extent to which a model can intercept
low-quality review comments" — is the question `runVerifier` answers with
confirmed / rejected / uncertain.

The comparison arm is OCR's comment reflection
(`internal/agent/agent.go:1798` running
`internal/config/template/prompts/review_filter_task_system.md` +
`review_filter_task_user.md`): one independent LLM call per round that may
only delete comments the diff **proves** wrong, on two exhaustive grounds
(A: the described code is absent from the subject file's diff; B: one diff
line literally contradicts the core claim), with a protected-subject veto
(memory safety, concurrency, linkage/declaration consistency, behavior or
compatibility change, unused parameter) applied before correctness is judged
at all. Its stated asymmetry — "Removing a correct comment silently destroys
a real finding" — is the same cost model pir's verifier already encodes
("Reviewer assertions are hypotheses, not facts", evidence-gated
`submit_verdict` in `src/tools/collector-tools.ts:199-270`). M0 makes the
two mechanisms comparable on identical material instead of comparing two
published, differently-measured systems.

The dataset is Apache-2.0; use requires citing arXiv 2601.19494. ADR-0003's
local-only evaluation stance applies unchanged: this benchmark runs on a
developer machine, never in CI, never against a leaderboard.

## Decision

1. **`pir _verify-comment` is an internal, eval-only command.** Underscore
   prefix, absent from `USAGE`/`HELP_SECTIONS`, absent from skills and docs,
   added to the CLI's `LOCAL_ONLY` set so remote mode never forwards it, and
   refused unless `PIR_EVAL=1` is set. It is outside the stable
   stdout/exit-code contract and may change or disappear without notice;
   promotion, if ever, is a separate decision after M0. It takes one task
   file (`--task-file`), one checkout (`--cwd`), one model, and prints a
   pure JSON envelope.
2. **Fixed comment → `CandidateFinding` mapping** (no model involvement, no
   `record_candidate`): title = first sentence of `note`; claim = the full
   `note`; trigger = empty string; category = deterministic dataset mapping
   (Code Defect → correctness, Maintainability and Readability →
   maintainability, Performance → performance, Security Vulnerability →
   security; unknown → other); severity = P2 (severity is not what M0
   measures); anchor = `{path, startLine: from_line, endLine: to_line}`;
   evidence = one `diff` entry whose excerpt is the driver-supplied
   per-comment diff excerpt (the hunks overlapping the anchor, else the
   leading hunks, size-capped). Identity is computed with the production
   `buildIdentity` so fingerprints stay meaningful.
3. **The verifier arm runs production `runVerifier`**
   (`src/agents/verifier.ts`) inside a driver-supplied `ToolContext`:
   `repoRoot` = the task checkout of the dataset's head commit, `changeSet`
   = a synthetic change set built from the merge-base..head diff narrowed to
   the comment's path, cold per-task memory, no prior decisions. Every
   production guarantee applies — evidence gate, verdict vocabulary,
   confidence — so the measured object is the shipped code, not a
   re-implementation.
4. **Scoring policy: uncertain = keep is primary.** Keeping is the `label=1`
   side of the confusion matrix, so `confirmed` and `uncertain` both count
   as keeps and only `rejected` kills. This matches the verifier's own bias
   (an unresolved candidate is reported as uncertain, never silently
   dropped) and OCR's "when your evidence falls short of proof, approve". A
   **strict** variant is always reported beside it: `uncertain` earns no
   credit in either direction, so it neither counts as a keep for
   recall/precision nor as a kill for kill-rate.
5. **Kill-rate is the north-star metric, with its cost side named.**
   `killRate` = rejected(label=0) / label=0: the share of known-bad comments
   the verifier removes (higher is better; B4's protected-subject clause can
   only lower it). `falseKillRate` = rejected(label=1) / label=1: the share
   of real findings destroyed (lower is better). `interceptPrecision` =
   rejected(label=0) / all rejected: how much of what it killed was actually
   noise (all three must be read together). The series' B4 acceptance text
   uses "kill-rate" for what this protocol calls `falseKillRate`; B4's gate
   is therefore `falseKillRate` must not regress while `killRate` and
   `interceptPrecision` are read jointly. Results files carry all three per
   bucket, so neither wording can be misread.
6. **Buckets are the dataset's own strata**, each with sample size and
   per-bucket metrics: `source_model`, `category`, `context`,
   `is_ai_comment`. Headline numbers are macro-averaged where a bucket
   average is meaningful and micro counts are always shown next to them.
7. **Materialization is a shared, resumable, out-of-tree cache with depth-1
   fetches and an explicitly reconstructed diff base.** Per repository: `git
   init` + `git fetch --depth 1 origin <sha>` (no
   merge-base history, no full clone; a ClickHouse depth-1 fetch measured
   ~70 MB / ~7 s). `diffBase` is the merge base reported by GitHub's compare
   API for the dataset's two commits, fetched at depth 1 as well; the
   dataset's `pr_source_commit`/`pr_target_commit` are a *capture-time*
   base/head pair and a naive two-SHA diff would fold hundreds of
   base-branch commits in reverse (FreeCAD PR 19411: 366 commits of drift).
   The per-comment diff is `git diff -U3 <diffBase> <head> -- <path>`, i.e.
   exactly the PR hunk GitHub rendered when the comment was written,
   narrowed to the subject file. Every failure — unreachable repo, dead SHA,
   missing path — becomes an error row; the run never aborts. The cache
   lives under `$PIR_AACR_CACHE` (default `~/.cache/pir-aacr`), never inside
   the worktree; the materialized JSONL and the checkout scratch are
   gitignored and rebuildable.
8. **The OCR reflection prompt is ported verbatim as the second arm, with
   attribution.** `src/agents/ocr-reflection-prompt.ts` carries the upstream
   Apache-2.0 attribution and the source revision, and the same command
   serves it with `--arm ocr`: no tools, no repository access, the file diff
   as `<review_files>` and the comment as the review comment, exactly the
   material OCR's reflection call receives. Both arms run on the same
   sample, the same model id and the same scoring code, so the two rows
   share one caliber. The attribution notice is repeated in the results file
   header.
9. **Judge delegation: M0 needs no judge; M1 delegates.** M0's dependent
   variable is a supplied binary label, so a model judge would add drift,
   cost and an unaccountable layer without adding information. M1's
   free-form findings are judged by the pinned upstream
   `judge.py`/`evaluate.py`, never by a home-grown judge, so pir's numbers
   land on the same caliber as published OCR / Claude Code / Codex rows.
10. **Cost and citation obligations.** The eval surface stays behind
    `PIR_EVAL=1`, never runs a model in `npm test`, records the exact model
    id, thinking level, CLI sha256, dataset sha256 and per-task
    token/wall-clock cost in the run manifest, and states its sample limit
    in every results file. Committed artifacts (scripts, `meta.json`,
    fixtures, results, docs) carry the arXiv 2601.19494 BibTeX in their
    headers or adjacent attribution file; downloaded data and run outputs
    carry it in the JSONL header row and the results header. The dataset and
    framework are Apache-2.0 and unredistributed here: only the pin (URL +
    sha256) is committed, the body is re-downloaded on demand.
11. **Caliber is stated, not assumed.** The pir arm is a
    repository-aware verifier that may read any pinned revision; the OCR arm
    is a diff-only reflection call, which is the OCR prompt's native and
    intended material. M0 therefore measures "pir's verifier with its
    designed tool access" against "OCR's reflection prompt with its designed
    input"; a diff-only pir ablation, or a repository-aware extension of the
    OCR arm, is explicitly out of scope for M0 and recorded as an open
    question for M1.

## Consequences

- M0 produces the first verifier-level numbers on real review comments and,
  unlike a find-level score, they are attributable to the verifier alone —
  B4's protected-subject clause gets a quantitative gate (`falseKillRate`)
  instead of an argument.
- The measured population is comment-level and single-expert-labelled, with
  3/4 AI-authored comments; per-bucket `is_ai_comment` and `source_model`
  rows are the guard against extrapolating to human taste. Results are
  not comparable to M1's `balanced_score` and must not be quoted as such.
- The 2,145-record corpus is not run in this iteration: Iteration 1 ships
  `--limit 100` sampled numbers, and the full corpus plus repeats (variance)
  is Iteration 2. The results file states the limit, the seed, the exact
  model and the zero-error subset; a partial run is published as a partial
  run, never extrapolated.
- A new internal command exists in `dist`. Its blast radius is bounded by
  `PIR_EVAL=1`, `LOCAL_ONLY`, and the absence from help/skills/docs; the
  alternative — shipping the benchmark logic in an untracked script that
  re-implements the verifier — was rejected because it would measure a copy
  instead of the product (accepted knowingly).
- Materialization writes tens of gigabytes to a shared out-of-tree cache at
  full-corpus scale; the script reports cache usage per run, is resumable
  per row, and never treats a fetch failure as fatal. Disk headroom is an
  operational precondition of Iteration 2, not a correctness property of M0.
- The OCR prompt is now a vendored Apache-2.0 artifact in this repository.
  Any upstream change must be re-ported deliberately, with the pinned
  revision bumped in the same commit.
- If the dataset's host, the compare API or commit availability changes,
  the benchmark degrades into error rows and an explicitly partial
  report; it does not silently score fewer comments. `meta.json`'s sha256
  pin fails the acquisition loudly if the upstream artifact changes.
- **Measured limitation, discovered by the first `--limit 100` run
  (2026-10-19): the dataset's label and `runVerifier`'s question are not the
  same question.** Label 1 means "this comment is correct review feedback";
  the verifier answers "does a concrete, change-attributable defect exist
  here". The run's rationales show the difference directly — valid comments
  are rejected because they are "a stylistic refactoring preference with no
  concrete failure", because the finding is "pre-existing, not introduced",
  or because the claim is "subjective wording", all of which the shipped
  do-not-report contract requires. Operationally `falseKillRate` still
  counts rejected(label=1)/label=1, but it must **not** be read as "the
  verifier destroys real findings" and must not be compared with the OCR
  arm's false-kill as if the two classifiers answered the same question. The
  comparable signals are `killRate` (label-0 interception) and the
  per-category view (Maintainability concentrates the mismatch). Iteration 2
  should add a mapping variant that separates "not a defect" from "defect
  not attributable" — audit-mode `runVerifier` (current-state verification
  without change attribution) is the obvious candidate — and report both
  rows deliberately.
- **Two provenance guards came out of the re-review (dogfood F-185/F-187).**
  `--resume` refuses to mix a different model id or CLI build into a round
  already on disk: the round's provenance is one model and one build sha256,
  and a silent mix would publish numbers under a stamp that describes only
  half of them. And the sampler excludes the dataset's 11 `side: "left"`
  comments (0.5% of 2,145): their `from_line`/`to_line` refer to the deleted
  old file, which the head-anchored mapping contract cannot express, so they
  are counted out (`sample.sideExcluded`) instead of silently mis-mapped;
  `validateRecords` rejects an unknown side value and `parseTask` refuses a
  non-right task loudly.
