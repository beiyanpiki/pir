# ADR 0010: Layered project rule file (B5)

## Status

**Accepted (2026-10-20).** Roadmap item B5 of
`docs/roadmap-ocr-borrow-and-aacr-benchmark.md` (borrow track, P1) in
Iteration 3. A repository (or a user, or a single invocation) can declare
path-scoped review guidance in a small JSON rule file; find injects the
guidance that actually applies to the reviewed paths into the reviewer
prompt, records a canonical hash of it in the run manifest, and lets
`pir config show` print it. It depends on B1 (ADR-0004): the glob matcher and
the exclusion-aware file list come from that change.

## Context

pir already injects three kinds of reviewer context, and none of them is
user-authored path guidance:

- **Language packs** (`plugins/`, `--plugins`) are built-in, run-wide
  directions selected by marker files. They are trusted review directions and
  cannot express "in `src/web/**`, never mutate props after mount" — the pack
  is chosen once for the run and its text is the same for every file.
- **Repository memory** is learned, bounded and explicitly untrusted: it is
  revalidated against code and never copied into findings. It cannot carry a
  rule the team wants applied before the first review, and it is not
  version-controlled with the repository.
- **Feedback decisions** (`pir feedback`) are per-finding verdicts, not
  general guidance.

OCR's rules system fills exactly that gap
(`docs/ocr-borrow-and-aacr-benchmark-context.md` §1.3): four layers
(`--rule` > repo `.opencodereview/rule.json` > global `~/.opencodereview/rule.json`
> built-in), `rules:[{path, rule, merge_system_rule}]` plus include/exclude,
declaration order as match priority, guidance file references read as
untrusted input (size cap, extension allowlist, symlink and repo-escape
checks), and a `CanonicalConfig()` hash into the manifest so a run can be
reproduced. The load-bearing idea is that **glob matching decides what enters
the prompt, in code**, rather than stuffing a standards document into the
system prompt and expecting the model to sort out which parts apply.

pir's prompt is one session for the whole change set, not one per file, so the
borrowing needs one deliberate translation: rules are resolved per reviewed
path in code, grouped by winning rule, and rendered as one bounded section.
That keeps the deterministic matching OCR has while fitting pir's single
reviewer session.

Risks this ADR has to contain: a rule file is repository content and can be
written by anyone who can open a PR, so it is untrusted evidence and must not
be able to override the process, provenance, severity or reporting rules; a
guidance file reference is a filesystem read requested by repository content,
so it needs the same containment OCR applies; and any nondeterministic
ordering would make prompt diffs and the manifest hash unstable.

## Decision

1. **Three layers, first-match wins, highest layer wins.** The layers are, in
   priority order: `--rule <path>` (explicit, one per invocation), the
   repository file `<root>/.pir/rule.json`, and the global file
   `<configDir>/rule.json` (default `~/.pir/rule.json`; `PIR_CONFIG_DIR`
   moves it, matching the rest of the client config). Each layer is loaded
   and validated independently; a missing file is simply absent, a present
   but invalid file is a hard error (never a silent fallback). For each
   reviewed path, the layers are scanned in that order and, within a layer,
   the rules in declaration order: the first rule whose `path` glob matches
   wins. A lower layer can still cover files the higher layers do not match,
   and two layers never merge into one rule for one file.
2. **Schema (camelCase, per the repository's JSON convention; the roadmap's
   `merge_builtin` spelling is realized as `mergeBuiltin`, the same mapping
   B4 recorded for `rejection_ground`).**

   ```json
   {
     "schemaVersion": 1,
     "include": ["src/**"],
     "exclude": ["**/*.test.ts"],
     "rules": [
       { "path": "src/**/*.ts", "guidance": "…", "mergeBuiltin": true },
       { "path": "src/web/**", "guidanceFile": "docs/web-rules.md", "mergeBuiltin": false }
     ]
   }
   ```

   `include`/`exclude` are layer-local file filters applied before rule
   matching (exclude wins; the default include is `**`). A rule carries
   exactly one of inline `guidance` or a repo-relative `guidanceFile`;
   `mergeBuiltin` defaults to `true`. Unknown keys are rejected, because a
   typo such as `merge_builtn` would otherwise silently change review
   behavior. `schemaVersion`, when present, must be `1`.
3. **Rule content is untrusted input.** A `guidanceFile` must be
   repo-relative (no absolute path, no `..` segment after normalization), use
   one of `.md`, `.markdown`, `.txt`, resolve — through `realpath`, so a
   symlink cannot escape — to a file inside the repository root, and be at
   most 64 KiB. The repository rule file itself gets the same containment: a
   committed `.pir/rule.json` is repository content, so its real path must
   stay inside the repository root and a symlink to a host file is a hard
   error; the `--rule` and global layers are paths the user chose explicitly
   and are read literally. Missing, oversized, escaping or disallowed files
   fail the run before any session starts. Rule files themselves are capped at
   256 KiB, and at most 64 rules are accepted per layer. Guidance text is
   canonicalized (CRLF→LF, trailing whitespace stripped per line, trimmed) so
   cosmetic edits do not change the hash and byte-identical guidance produces
   a byte-identical section.
4. **Injection is one deterministic `PROJECT RULES` section, in the reviewer
   prompt only.** The section is rendered after the process/severity rules and
   immediately before the built-in language guidance, with the repository
   memory pack last (the order is: rules → built-in language guidance →
   `=== REPOSITORY MEMORY ===`). It is emitted only when at least one rule
   wins for a reviewed, non-excluded changed path; the groups are sorted by
   rule glob (then layer priority, then declaration order) and each group's
   file list is sorted, so the section is byte-stable. Every invocation opens
   with an evidence-not-instructions preamble: the guidance cannot override
   the process, provenance, severity, findings-budget or terminal-tool rules.
   Audit mode does not receive project rules in v1: its prompt is a separate
   adoption decision, and rules are declared per changed path.
5. **Division of labor, and what `mergeBuiltin` means in a whole-diff
   session.** Language packs remain built-in, run-wide language guidance;
   project rules are user-declared, path-scoped and versioned with the
   repository; memory remains learned and revalidated. They do not replace
   one another. `mergeBuiltin: true` keeps the built-in pack guidance next to
   the project rule. `mergeBuiltin: false` means the project rule is
   authoritative for its paths and the built-in pack guidance is withheld for
   the run — a coarse, honest granularity: the pack is rendered once for the
   whole session, so per-file partial suppression would require per-file
   sessions. The section states the suppression explicitly, the manifest
   records it, and a diff that mixes replaced and merged rules gets the
   conservative (user-wins) behavior.
6. **The canonical rule-text hash is part of the run record.** The hash is
   `sha256` over a canonical JSON document containing the layers in priority
   order, each layer's include/exclude and each rule's path, canonicalized
   guidance text and `mergeBuiltin`; absolute file paths are deliberately
   excluded, so the same rules in a different checkout hash identically. The
   run manifest (`run.json`, change mode) gains
   `projectRules: { hash, matchedFiles, rules, builtinSuppressed, layers }`,
   and `pir config show` prints the loaded layers plus the effective rules and
   the hash (full rule text in `--json`). The hash is the reproducibility
   handle for the M2 change protocol: two runs are comparable only when it
   matches.
7. **Failure is loud and pre-session.** A malformed rule file, unknown key, a
   broken or escaping guidance reference, an over-cap file, or a rendered
   section over 48,000 characters fails find/`config show` with a usage error
   naming the file and rule before any reviewer or verifier session is
   created. There is no silent skip and no partial application: a rule file
   that cannot be applied completely is not applied at all.
8. **Scope: find in local mode.** `--rule` is a local filesystem path and is
   rejected in remote mode by the CLI before forwarding — and refused again by
   the server on `/v1/review`, because a direct API caller can send arbitrary
   argv and the path would otherwise be read on the server and fed to a model
   prompt (dogfood F-1). The repository/global layers still work remotely: the
   bundle carries the committed `.pir/rule.json` and the server's own global
   file applies. Audit rejects `--rule` and the file is not read for audit
   runs. `--preview` also rejects it, because rules shape the prompt,
   not the file selection. The rule file itself is excluded from review by
   B1's existing `.pir/**` skip pattern.

## Consequences

- Teams get review guidance that is versioned with the code, path-scoped in
  code rather than by model interpretation, reproducible through a hash, and
  auditable with `pir config show`. The cost is one more configuration
  surface: a bad rule file fails the run before it starts, which is
  deliberate but means rule editing needs the same care as editing CI
  configuration.
- The whole-diff session makes `mergeBuiltin: false` coarse (one replaced rule
  suppresses the pack for the run). This is documented in the prompt, the
  manifest and this ADR rather than hidden; per-file pack suppression is a
  future change that would need per-file sessions or a pack-splitting
  refactor.
- The hash changes whenever guidance text, a glob, ordering, include/exclude
  or `mergeBuiltin` changes, and does not change on absolute-path-only moves.
  Runs with different hashes are not comparable under M2's protocol.
- Rule content is untrusted repository input. The preamble bounds it to
  review guidance, the read path is contained, and the rules never reach the
  verifier (a verifier decides technical truth from code, not from project
  preferences).
- The section costs prompt tokens, bounded by the 48,000-character render cap
  and the 64 KiB per-file cap; a run with no rules pays nothing beyond the
  file-existence checks.

## Tests and acceptance evidence

- **A1, model-free unit tests** (`tests/unit/project-rules.test.js` and
  additions to `tests/unit/prompts.test.js`): layer precedence and
  first-match-wins; include/exclude; `mergeBuiltin` suppression and its
  prompt effect; guidance-file containment (absolute, `..`, symlink escape,
  wrong extension, oversized, missing); malformed shapes and unknown keys;
  canonical hash stability across line endings/trailing whitespace and
  sensitivity to every semantic field; byte-stable rendering (sorted groups
  and file lists, no chapter-and-verse dependence on directory order); the
  prompt position (PROJECT RULES before language guidance and before the
  memory pack) and the evidence preamble; absence on a run with no rules.
- **A2, dogfood**: find on this PR's own branch with an explicit `--rule`
  file that constrains `src/rules/**`; the transcript/manifest must show the
  rendered section and the matching hash, and the review must still pass the
  normal P0–P2 gate. Evidence is recorded in the PR's Verification section.

## References

- Roadmap: [`docs/roadmap-ocr-borrow-and-aacr-benchmark.md`](../roadmap-ocr-borrow-and-aacr-benchmark.md), §1 B5.
- Companion research: [`ocr-borrow-and-aacr-benchmark-context.md`](../ocr-borrow-and-aacr-benchmark-context.md) §1.3 (the rules system) and §3 (the user-rules gap).
- OCR sources: `internal/config/rules/system_rules.go` (layers, schema, canonical hash), `internal/session/resume_identity.go` (`rule_config_sha256`), `internal/prompt` rule injection. Upstream `alibaba/open-code-review` @ `8eb8334` (Apache-2.0).
- B1's shared filter and glob matcher: [ADR-0004](0004-change-mode-file-filter.md), `src/changes/filter.ts`.
- B4's spelling precedent: [ADR-0008](0008-structured-verifier-rejection-grounds.md) §1.
