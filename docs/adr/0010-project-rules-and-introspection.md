# ADR 0010: Layered project rule file and rule introspection

## Status

**Accepted (2026-10-20; extended 2026-10-23; consolidated 2026-10-27).**
Two decisions about user-authored, path-scoped review guidance, delivered in
PR #146:

| Part | Decision | Source | Outcome |
| --- | --- | --- | --- |
| I | Layered project rule file | ADR 0010 | accepted |
| II | `pir rules check` — rule introspection | ADR 0019 | accepted |

Source numbers are the retired per-decision ADRs; the [consolidation
map](README.md) records the mapping.

## Part I — Layered project rule file

### Context

pir already injects three kinds of reviewer context, none of them
user-authored path guidance:

- **Language packs** are built-in, run-wide directions selected by marker
  files; the pack is chosen once for the run and reads the same for every
  file.
- **Repository memory** is learned, bounded and untrusted: revalidated
  against code, never copied into findings, not version-controlled with the
  repository.
- **Feedback decisions** are per-finding verdicts, not general guidance.

OCR's rules system fills exactly that gap: four layers (`--rule` > repo
`.opencodereview/rule.json` > global `~/.opencodereview/rule.json` >
built-in), `rules:[{path, rule, merge_system_rule}]` plus include/exclude,
declaration order as match priority, guidance files read as untrusted input
(size cap, extension allowlist, symlink and repo-escape checks), and a
`CanonicalConfig()` hash in the manifest. The load-bearing idea is that
**glob matching decides what enters the prompt, in code**, not the model.

pir's prompt is one session for the whole change set, so the translation is:
resolve rules per reviewed path in code, group by winning rule, render one
bounded section. That keeps deterministic matching while fitting the
single-session model.

Risks the design must contain: a rule file is repository content and can be
written by anyone who can open a PR, so it is untrusted and must not override
process, provenance, severity or reporting rules; a guidance file is a
filesystem read requested by repository content, so it needs containment; and
nondeterministic ordering would make prompt diffs and the manifest hash
unstable.

### Decision

1. **Three layers, first-match wins, highest layer wins.** In priority order:
   `--rule <path>` (explicit, one per invocation), the repository file
   `<root>/.pir/rule.json`, and the global file `<configDir>/rule.json`
   (default `~/.pir/rule.json`; `PIR_CONFIG_DIR` moves it). Each layer loads
   and validates independently; a missing file is absent, an invalid one is a
   hard error (never a silent fallback). For each reviewed path, layers are
   scanned in order and, within a layer, rules in declaration order: the first
   matching `path` glob wins. A lower layer can cover files a higher layer
   does not, and two layers never merge into one rule for one file.
2. **Schema (camelCase; `merge_builtin` is realized as `mergeBuiltin`, the same
   spelling mapping used for `rejection_ground`).**

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

   `include`/`exclude` are layer-local filters applied before matching
   (exclude wins; default include `**`). A rule carries exactly one of inline
   `guidance` or repo-relative `guidanceFile`; `mergeBuiltin` defaults to
   `true`. Unknown keys are rejected, because a typo such as
   `merge_builtn` would silently change review behavior. `schemaVersion`,
   when present, must be `1`.
3. **Rule content is untrusted input.** A `guidanceFile` must be
   repo-relative (no absolute path, no `..` after normalization), use
   `.md`/`.markdown`/`.txt`, resolve through `realpath` to a file inside
   the repository root, and be at most 64 KiB. The repository rule file gets
   the same containment: a committed `.pir/rule.json` must resolve inside the
   root, and a symlink to a host file is a hard error; `--rule` and the global
   layer are user-chosen paths and are read literally. Missing, oversized,
   escaping or disallowed files fail before any session starts. Rule files are
   capped at 256 KiB and 64 rules per layer. Guidance is canonicalized
   (CRLF→LF, trailing whitespace stripped per line, trimmed) so cosmetic edits
   do not change the hash and identical guidance renders identically.
4. **Injection is one deterministic `PROJECT RULES` section, reviewer prompt
   only.** It renders after the process/severity rules and immediately before
   built-in language guidance, with the memory pack last (rules → language →
   `=== REPOSITORY MEMORY ===`). It is emitted only when a rule wins for a
   reviewed, non-excluded changed path; groups sort by rule glob, then layer
   priority, then declaration order, and each group's file list is sorted, so
   the section is byte-stable. Every invocation opens with an
   evidence-not-instructions preamble: guidance cannot override process,
   provenance, severity, findings-budget or terminal-tool rules. Audit mode
   does not receive project rules in v1.
5. **Division of labor, and `mergeBuiltin` in a whole-diff session.**
   Language packs remain built-in run-wide guidance; project rules are
   user-declared, path-scoped and versioned; memory remains learned and
   revalidated. They do not replace one another. `mergeBuiltin: true` keeps
   the pack guidance beside the project rule. `mergeBuiltin: false` makes the
   project rule authoritative and withholds the pack guidance from **reviewer**
   sessions for the run — coarse but honest: the pack renders once per session,
   so per-file suppression would need per-file sessions. Verifier sessions are
   untouched: they never receive project rules, and their trusted language
   guidance keeps a project preference from being mistaken for technical truth
   (dogfood F-5). The section states the suppression, the manifest records it,
   and a diff mixing replaced and merged rules gets the conservative
   user-wins behavior.
6. **The canonical rule-text hash is part of the run record.** `sha256` over
   a canonical JSON document containing the layers in priority order, each
   layer's include/exclude, and each rule's path, canonicalized guidance and
   `mergeBuiltin`; absolute paths are excluded, so the same rules in another
   checkout hash identically. The run manifest gains
   `projectRules: { hash, matchedFiles, rules, builtinSuppressed, layers }`,
   and `pir config show` prints the layers, effective rules and hash (full
   text in `--json`). Two runs are comparable only when the hash matches.
7. **Failure is loud and pre-session.** A malformed file, unknown key, broken
   or escaping reference, over-cap file, or a rendered section over 48,000
   characters fails find/`config show` with a usage error naming the file and
   rule before any session is created. There is no silent skip and no partial
   application.
8. **Scope: find in local mode.** `--rule` is a local path and is rejected in
   remote mode by the CLI before forwarding — and refused again by the server
   on `/v1/review`, because a direct API caller can send arbitrary argv and
   the path would otherwise be read server-side and fed to a prompt (dogfood
   F-1). The repository/global layers still work remotely: the bundle carries
   the committed `.pir/rule.json` and the server's global file applies. Audit
   rejects `--rule` and never reads the file; `--preview` rejects it because
   rules shape the prompt, not selection. The rule file itself is excluded
   from review by the change-mode filter's `.pir/**` skip pattern.

### Tests and acceptance

- **Model-free unit tests** (`tests/unit/project-rules.test.js` and
  `tests/unit/prompts.test.js`): precedence and first-match-wins;
  include/exclude; `mergeBuiltin` suppression and its prompt effect;
  guidance-file containment (absolute, `..`, symlink escape, extension,
  oversize, missing); malformed shapes and unknown keys; hash stability and
  sensitivity; byte-stable rendering; prompt position and preamble; absence on
  a run with no rules.
- **Dogfood**: find on this PR's branch with `--rule` constraining
  `src/rules/**`; the manifest must show the section and hash, and the review
  must still pass the normal P0–P2 gate. Evidence is in the PR.

### Consequences

- Guidance is versioned with the code, path-scoped in code rather than by
  model interpretation, reproducible through a hash, and auditable with
  `config show`. The cost is one more configuration surface: a bad file fails
  the run before it starts, so rule editing needs CI-config care.
- `mergeBuiltin: false` is coarse (one replaced rule suppresses the pack for
  the run); documented in prompt, manifest and this ADR rather than hidden.
- The hash changes with guidance text, a glob, ordering, include/exclude or
  `mergeBuiltin`, and not on absolute-path-only moves; different hashes are
  not comparable under the change protocol.
- Rule content is untrusted. The preamble bounds it to review guidance, the
  read path is contained, and rules never reach the verifier.
- The section costs prompt tokens, bounded by the 48,000-character render cap
  and the 64 KiB per-file cap; a run with no rules pays only the
  file-existence checks.

## Part II — `pir rules check`

### Context

`pir config show` prints layers, rules and hash, but not the question people
ask while debugging a rule file: "for this path, which rule wins, from which
layer, and what text would the reviewer get?" Part I's resolver already
computes that — `applyProjectRules` returns `matches[]` (path, layer,
rulePath, mergeBuiltin) and renders the guidance — so what was missing was a
way to ask it about one arbitrary path. OCR ships `ocr rules check` for the
same step; that is product-direction evidence, not a parity requirement
(Track B is demand-driven and costs no model tokens).

Two constraints decide the design: the answer must not drift from the prompt,
so the winning-rule lookup is extracted from `applyProjectRules` and shared;
and the command must be safe anywhere, so it reads rule files only — no
project database, no session, no writes.

### Decision

1. **`pir rules check <path>` is client-side.** It never forwards to a
   server, whatever the configured mode is (it joins the local-only set), and
   it never runs the wizard.
2. **One matcher.** `matchProjectRule(set, path)` is extracted from
   `applyProjectRules` and is the only implementation of "layers in priority
   order, rules in declaration order, first match wins". `applyProjectRules`
   uses it (behavior byte-identical), `checkProjectRules` adds the per-layer
   gate explanation, and the command answers from both: the winner and
   rendered section come from the same calls `find` makes.
3. **Path contract.** The checked path is reported repository-relative. An
   absolute path inside the repository root is accepted and reported relative;
   one outside is a usage error (exit 2), as are `..`, `.` and an empty path.
   The path need not exist — matching is pure — and a missing file is flagged
   (`note:` in text, `exists: false` in JSON).
4. **Text contract** (byte-stable, no host paths): `path:`, an optional
   `note:` for a missing file, then either `rule: "<glob>"`,
   `layer: <name> (<label>)`, `mergeBuiltin: <bool>`,
   `guidance (<source>[, file <guidanceFile>], <n> chars):` and the guidance,
   or `rule: none` plus one `layers:` line per loaded layer naming the gate
   that failed — `path not included by any include glob`, `path excluded by
   exclude glob "<glob>"`, `path included, no rule matched`, or, for a layer
   that matched, `winning rule "<glob>"` / `matches rule "<glob>" (a
   higher-priority layer wins)`. Every output ends with
   `rules hash: <sha256>`.
5. **JSON contract.** `command: "rules.check"` with `path`, `exists`,
   `rulesHash`, `matched`, `winner` (layer, label, glob, mergeBuiltin,
   guidance source/file, guidance), `layers[]` (gates, first matching glob,
   whether the layer won) and `renderedSection` — the exact PROJECT RULES
   block this path would receive, from the same `applyProjectRules` call.
6. **No host paths.** Layer labels come from `layerLabel`: `.pir/rule.json`,
   `~/.pir/rule.json`, `--rule`. Which absolute file backs a layer stays
   `config show`'s job.
7. **No side effects.** No run row, no project database or state directory, no
   model session, no repository or config write. `--rule` is accepted (the
   same flag layer `find` loads); `--repo`, `--base`, `--head`, `--branch`
   and `--uncommitted` are usage errors.

### Evidence

**1. The data already existed.** `applyProjectRules` returns the winning rule
per reviewed path; `checkProjectRules` exposes the gates implicit in the
matcher. The command renders computed state, not a new resolver.

**2. Drift risk is real, so the matcher is shared.** Two implementations would
only have to disagree on one edge — a rename's `oldPath`, a layer
`exclude`, declaration order — for the debug answer to mislead. The
extraction keeps one code path, and
`tests/unit/project-rules-check.test.js` asserts on every fixture path that
both select the same layer and glob.

**3. Output is safe by construction.** The only path-like strings are
repository-relative or fixed layer labels;
`tests/integration/rules-cli.test.js` asserts no repository root, config dir
or temp dir appears in text or JSON, and the output is byte-identical across
runs.

### Acceptance mapping

- **Stable and path-safe.** Byte-identical runs, no host path, same fixture
  yields the same hash.
- **No run row, no session.** `PIR_STATE_ROOT` is pointed at a fresh
  directory and asserted never created; no `memory.sqlite` or `transcripts`
  appears.
- **`config show` unchanged.** The test compares `config show --json` before
  and after and asserts the two hashes are equal.

### Consequences

- A rule file can be debugged before a review: which layer won, which glob
  matched, the text the reviewer would see, and why nothing matched.
- `find` behavior is unchanged: the same matcher, now shared; existing rules
  tests stay green.
- `renderedSection` makes the prompt block inspectable without a transcript,
  from the same `applyProjectRules` output rather than a second renderer.
- Rules remain `find`-only; if audit gains them, nothing here assumes
  otherwise.

### Revisit conditions

- **A second consumer needs the answer programmatically** (e.g. CI failing
  when a path matches no rule): extend the JSON contract, not a second
  command.
- **Rules become mode-agnostic:** generalize the wording that ties the
  rendered section to `find`.
- **Users ask to list every path a rule applies to:** inverse matching is a
  different query; design it separately.

## References

- OCR: `internal/config/rules/system_rules.go` (layers, schema, canonical
  hash), `internal/session/resume_identity.go` (`rule_config_sha256`),
  `internal/prompt` injection; `alibaba/open-code-review` @ `8eb8334` and
  `375f64c` (Apache-2.0).
- The change-mode filter and glob matcher:
  [ADR 0004](0004-change-mode-review-pipeline.md), `src/changes/filter.ts`.
- The spelling precedent for `rejection_ground`:
  [ADR 0008](0008-structured-verifier-rejection-grounds.md) §1.
- Implementation: `src/rules/project-rules.ts`, `src/cli/executor.ts`,
  `src/agents/prompts.ts`, `src/agents/reviewer.ts`,
  `src/core/supervisor.ts`, `src/observability/run-events.ts`.
- Tests: `tests/unit/project-rules.test.js`,
  `tests/unit/project-rules-check.test.js`, `tests/unit/prompts.test.js`,
  `tests/integration/rules-cli.test.js`.
