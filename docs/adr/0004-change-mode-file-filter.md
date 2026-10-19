# ADR 0004: Change-mode file filter — one shared selection gate, previewed through the same pure function

## Status

**Accepted (2026-10-19).** Written for roadmap item B1 (Iteration 1) of the
OCR-borrow × AACR-Bench plan, `docs/roadmap-ocr-borrow-and-aacr-benchmark.md`;
B5 (layered user rule file) builds on the include/exclude seam recorded here.
The roadmap tracking file is a temporary artifact and is deleted once the
series completes — this ADR absorbs the decisions it needs.

## Context

pir's filtering is asymmetric today. `pir audit` has a versioned three-layer
policy in `src/changes/snapshot.ts` (default exclusion globs, a
binary-extension classifier, a 1MB per-file size cap) plus a
`--dry-run --list-files` preview. `pir find` has **none**: every file the
merge-base..head diff touches is, in principle, readable by the reviewer
session through `get_change`. That set routinely contains files nobody wants
reviewed — lockfiles, generated bundles, vendored trees, binary assets — and
files nobody may review: `.env`, `.ssh` material, registry credentials. The
reachable set also sizes the run: diff lines are paged 120 at a time
(`get_change`), so one generated file can eat a session's entire budget.

The research context (`docs/ocr-borrow-and-aacr-benchmark-context.md` §1.3,
comparison table §3) documents the mechanism OCR uses against exactly this:
a **six-gate pure filter** (`internal/agent/selection.go`, `whyExcluded`
:70) with a fixed order — binary → secret paths → user exclude → user
include → extension allowlist → built-in ~100 default excludes — plus two
post-gates (deleted files kept as context, single-file diff over 80% of
MAX_TOKENS → `too_large`). Entry `Agent.Run` is `internal/agent/agent.go`
:284. Three properties of that design are load-bearing here:

1. **The secret gate is not rescuable by any user rule.** Everything else is
   negotiable; a credential that reaches a model prompt cannot be recalled.
2. **`--preview` and the real run call the same `selectFiles` pure
   function** — "what you preview is what gets reviewed" is a structural
   property, not a promise to maintain two code paths in sync.
3. **Dispatched subtasks see global change metadata but not other groups'
   patches** (`dispatchSubtasks`, `internal/agent/agent.go`:629): the model
   gets `STATUS path (+N/-M)` lines, never the bodies — the same split pir
   borrows for policy-excluded files.

The counter-risk is equally clear: filtering that hides files turns "no
findings" into "not looked at". The reviewer must still know a file changed,
and the operator must be able to see which files were withheld, and why —
hence B1 combines a filter with an exclusion record and a preview.

## Decision

1. **One shared policy module, `src/changes/filter.ts`.** The default
   exclusion globs, the binary-extension set, `MAX_AUDIT_FILE_BYTES`, the
   tree-entry classifier, glob matching and include normalization move there,
   together with `FILTER_VERSION` (audit persists it as `scopeVersion`).
   `snapshot.ts` consumes the module and re-exports the pre-split names;
   `pir audit --dry-run` output is byte-identical to before (pinned by
   tests), so the two modes cannot drift on what counts as reviewable.
2. **Change mode applies four gates after `buildChangeSet()`, in this
   fixed order**, with include treated as the escape hatch for the last two:
   - **gate 1 — binary**: the binary-extension policy, checked on both sides
     of a rename. There is no text to review; not overridable.
   - **gate 2 — secret paths**: the table below; not overridable by any
     include or skip option. Renames are checked on both paths, so moving a
     key out of `.ssh/` does not launder it.
   - **include scope**: literal file/directory prefixes (audit `--path`
     semantics). A file outside a non-empty include set is `not-included`.
   - **gate 3 — skip patterns**: explicit `--skip` globs, then the default
     policy (vendored dependencies, build output, lockfiles, minified output).
   - **gate 4 — oversized single-file diff**: `MAX_DIFF_FILE_BYTES`.
   An explicitly included file bypasses gates 3 and 4 — it is an explicit
   ask — and only those: gates 1 and 2 stay absolute, which is OCR's rule.
3. **Secret table (versioned, in the shared module).**
   `**/.ssh/**`; `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*` (the
   SSH key families); `**/.netrc`, `**/.npmrc`, `**/.pypirc`,
   `**/.dockercfg` (credential files); `**/.env`, `**/.env.*` (dotenv).
   Basenames `.env.example`, `.env.sample` and `.env.template` are exempt:
   checked-in examples are documentation, not secrets. The `**/` prefix is
   deliberate — a no-magic glob matches from the repository root only, and
   these files are secret wherever they live. A false exclusion costs one
   unreviewed credentials-file diff that the reviewer can still see as
   metadata; a false inclusion costs a leaked credential.
4. **Excluded ≠ invisible.** An excluded file keeps every metadata field
   (path, status, additions, deletions, language) and gains `excluded` plus
   `excludedReason`; its hunks are emptied **at the source**, so the property
   belongs to the `ChangeSet` rather than to any one tool. Consequences:
   `get_change` lists the file with its reason and refuses to page a hunk of
   it ("excluded from diff review"), the coverage ledger never counts its
   hunks (no unreachable denominator, so full coverage stays achievable), and
   the reviewer knows the file changed even though it cannot read the patch.
   A change set with nothing excluded is returned unchanged, so the common
   path is behaviorally identical to pre-B1.
5. **Envelope change is purely additive.** `data.run.files[]` gains
   `excluded` (always present, boolean) and `excludedReason` (present only
   when excluded); the four pre-B1 keys keep their names and values. The run
   manifest records the same projection through one shared
   `changedFileSummary()` function, so envelope and manifest cannot drift.
   Zero consumer changes (acceptance A2).
6. **`MAX_DIFF_FILE_BYTES = 200_000`**, measured on the pageable diff body
   (hunk headers plus raw diff lines, in UTF-8 bytes). At ~4 chars/token that
   is ~50k tokens for one file, and `get_change` pages at most 120 raw lines
   per call: 200KB is ~45+ full pages, far more than a one-or-two-round
   session reads, and enough to consume its whole budget. It is deliberately
   *below* audit's `MAX_AUDIT_FILE_BYTES` (1MB) because audit spreads a file
   across work units while change mode hands it to one session. The boundary
   is exact and pinned: at the cap selected, one byte over excluded.
7. **`pir find --preview` reuses the same pure function.** The preview calls
   `buildChangeSet()` plus the very `selectChangeFiles()` that
   `applyChangeFilter()` runs, and prints the per-file result (path, status,
   churn, selected/excluded, gate, reason) as text and `--json`, with the
   policy that produced it. No run row, no model session, no writes;
   run-shaping flags (`--max-rounds`, `--max-tokens`, `--max-findings`,
   `--verify-concurrency`, `--min-confidence`, `--fail-on`, `--model`,
   `--verify-model`, `--angles`, `--plugins`) are rejected with a usage
   error rather than silently ignored — the `audit --dry-run` precedent
   (#56).
8. **No new user-facing include flag in B1.** find passes default options;
   the include/exclude parameters are the seam the B5 rule file wires into
   (roadmap dependency B1 → B5) — a behavior gate, not a configuration feature.

## Consequences

- **Positive:** change mode stops spending reviewer budget on binaries,
  lockfiles, generated output and vendored trees; secret files structurally
  cannot reach a model prompt, a transcript or a provider log; audit and
  change mode share one policy table; the coverage denominator stays
  reachable; and the selection becomes auditable *before* a run is paid for,
  through the same function the run uses. M1 measures the effect on real PRs
  (roadmap: "B1's effect measured by M1").
- **Negative:** a genuinely interesting lockfile or generated-file change is
  no longer diff-reviewed by default — a real recall trade, deliberate, but
  worth reading together with OCR's own recall stance. B5's rule file is the
  sanctioned way to include such a path explicitly. Ordinary `.npmrc`
  config changes are withheld too: the gate cannot tell a registry URL from
  an auth token. The 200KB cap can withhold a large hand-written diff; the
  reviewer can still read the *file* at head through `read_code`.
- **Neutral:** audit behavior is intentionally unchanged, so include
  semantics differ by mode — audit's `--path` narrows the scope without
  bypassing its default policy (as before), while change mode's include
  bypasses skip/size gates. Both are pinned by tests and stated in the
  preview output. Per-file terminal coverage states remain decision point
  D-B8's contract; B1 records the exclusion pair additively.
