# ADR 0019: `pir rules check` — project-rule introspection (S7)

## Status

**Accepted (2026-10-23).** Track B item S7 of the OCR second-pass series. A read-only CLI command: no review run, no model call, no project database, no writes.

## Context

`pir config show` prints the loaded layers, rules and hash, but not the question people actually ask while debugging a rule file: "for this path, which rule wins, from which layer, and what text would the reviewer get?" B5's resolver already computes exactly that per reviewed path — `applyProjectRules` returns `matches[]` (path, layer, rulePath, mergeBuiltin) and renders the guidance that reaches the prompt — so what was missing was a way to ask it about one arbitrary path. OCR ships `ocr rules check` for the same debugging step; that is product-direction evidence, not a parity requirement (Track B is demand-driven and costs no model tokens).

Two constraints decide the design. First, the answer must not be able to drift from the prompt: a second matcher that agrees "today" will eventually disagree, so the winning-rule lookup is a helper extracted from `applyProjectRules` and shared by both. Second, the command must be safe to run anywhere: it reads rule files, so it must not touch the project database, start a session, or write anything.

## Decision

1. **`pir rules check <path>` is a client-side command.** It never forwards to a server, whatever the configured mode is (it joins the local-only set), and it never runs the wizard.
2. **One matcher.** `matchProjectRule(set, path)` is extracted from `applyProjectRules` and is the only implementation of "layers in priority order, rules in declaration order, first match wins". `applyProjectRules` uses it (behaviour byte-identical), `checkProjectRules` adds the per-layer gate explanation on top of it, and the command answers from both: the winner and the rendered section come from the same calls `find` makes, the diagnostics from the check.
3. **Path contract.** The checked path is reported repository-relative. An absolute path is accepted when it resolves inside the repository root and is reported relative; one outside it is a usage error (exit 2), as are `..`, `.` and an empty path. The path does not have to exist — matching is pure — and a missing file is flagged (`note:` in text, `exists: false` in JSON) rather than silently answered.
4. **Text contract** (byte-stable, no host paths): `path:`, an optional `note:` for a missing file, then either `rule: "<glob>"`, `layer: <name> (<label>)`, `mergeBuiltin: <bool>`, `guidance (<source>[, file <guidanceFile>], <n> chars):` and the canonical guidance text, or `rule: none` plus one `layers:` line per loaded layer naming the gate that failed — `path not included by any include glob`, `path excluded by exclude glob "<glob>"`, `path included, no rule matched`, or, for a layer that matched, `winning rule "<glob>"` / `matches rule "<glob>" (a higher-priority layer wins)`. Every output ends with `rules hash: <sha256>`.
5. **JSON contract.** `command: "rules.check"` with `path`, `exists`, `rulesHash`, `matched`, `winner` (layer, label, glob, mergeBuiltin, guidance source/file, guidance), `layers[]` (include/exclude gates, the first matching glob, whether the layer won) and `renderedSection` — the exact PROJECT RULES prompt block this path would receive, produced by the same `applyProjectRules` call `find` makes.
6. **No host paths.** Layer labels come from `layerLabel`, the labels the prompt already uses: `.pir/rule.json`, `~/.pir/rule.json`, `--rule`. Which absolute file backs a layer stays `config show`'s job.
7. **No side effects.** No review run row, no project database or state directory, no model session, no repository or config write. `--rule` is accepted (the same flag layer `find` loads); `--repo`, `--base`, `--head`, `--branch` and `--uncommitted` are rejected with usage errors.

## Evidence

**1. The data already existed.** `applyProjectRules` returns the winning rule per reviewed path; `checkProjectRules` exposes the gates that were implicit in the matcher. The command is a rendering of computed state, not a new resolver.

**2. The drift risk is real, so the matcher is shared.** Two matching implementations would only have to disagree on one edge — a rename's `oldPath`, a layer `exclude`, declaration order — for the debug answer to send someone down the wrong path. The extraction keeps one code path, and `tests/unit/project-rules-check.test.js` asserts on every fixture path that `checkProjectRules` and `applyProjectRules` select the same layer and glob.

**3. The output is safe by construction.** The only path-like strings are repository-relative (the checked path, the rule glob, the guidance file) or fixed layer labels; `tests/integration/rules-cli.test.js` asserts that neither the repository root, the config dir nor the temp dir appears in text or JSON output, and that the output is byte-identical across runs.

## Acceptance mapping

- **A1 — output is stable and path-safe.** Byte-identical across runs, no host path in text or JSON, and the same fixture yields the same rules hash.
- **A2 — no run row, no model session.** The command never opens a project database: the test points `PIR_STATE_ROOT` at a fresh directory and asserts it is never created, with no `memory.sqlite` or `transcripts` appearing in the repository.
- **A3 — `config show` is unchanged.** The command only reads; the test compares `config show --json` before and after and asserts `rules.check`'s `rulesHash` equals `config.show`'s hash.

## Consequences

- A rule file can be debugged before a review: which layer won, which glob matched, the text the reviewer would see, and why nothing matched.
- `find` behaviour is unchanged: the matcher is the same function, now shared by export, and the existing rules tests stay green.
- The JSON `renderedSection` makes the prompt block inspectable without a transcript, and it is the same `applyProjectRules` output rather than a second renderer.
- Rules remain `find`-only. If audit ever gains project rules, nothing in this command assumes otherwise.

## Revisit conditions

- **A second consumer needs the answer programmatically** (for example a CI step failing when a path matches no rule): extend the JSON contract, not a second command.
- **Rules become mode-agnostic:** the wording that ties the rendered section to `find` must be generalized.
- **Users ask to list every path a rule applies to:** that is inverse matching, a different query; design it separately rather than overloading `check`.

## References

- Precedent and data: [ADR 0010](0010-layered-project-rule-file.md) (the layered rule file and its resolver), [`project-rules.ts`](../../src/rules/project-rules.ts).
- Implementation: [`src/cli/executor.ts`](../../src/cli/executor.ts) (`cmdRules`, `ruleCheckPath`), [`src/rules/project-rules.ts`](../../src/rules/project-rules.ts) (`matchProjectRule`, `checkProjectRules`).
- Tests: [`tests/unit/project-rules-check.test.js`](../../tests/unit/project-rules-check.test.js), [`tests/integration/rules-cli.test.js`](../../tests/integration/rules-cli.test.js).
- External mechanism: OCR `alibaba/open-code-review` @ `375f64c` (Apache-2.0), `ocr rules check` — product-direction evidence only.
- Roadmap: `docs/roadmap-ocr-second-pass.md` §3, item S7.
