# ADR 0020: SARIF 2.1.0 output for `find` and `audit` (S6)

## Status

**Accepted (2026-10-23).** Track B item S6 of the OCR second-pass series. Output-only: `--format sarif` on `find` and `audit`. No model change, no run-loop change, no new persistence, no change to text or JSON output, and the exit-code contract is untouched.

## Context

pir reports findings as text or as a versioned JSON envelope, with stable exit codes. A SARIF consumer — GitHub Code Scanning, and every other tool that reads SARIF 2.1.0 — cannot ingest that envelope, so a CI integration today has to re-implement the mapping from JSON to SARIF itself. OCR ships a full SARIF writer (`cmd/opencodereview/sarif.go`); here the value is a mechanical mapping of facts pir already publishes, so it is Track B work with no model cost and no review-quality claim.

Three constraints decide the design. First, `--json` is a documented contract (the agent-facing envelope); adding a format must not change it. Second, the finding identity already exists — the canonical fingerprint the memory layer keys findings by — and SARIF's `partialFingerprints` is exactly the slot for it. Third, run completeness is already first-class (`incomplete`, `stoppedBecause`, coverage); a SARIF document that hid a truncated run would look more finished than the run was.

## Decision

1. **`--format text|json|sarif` on `find` and `audit`.** `--json` is the same choice as `--format json`; passing both with different values is a usage error, never a precedence rule. An unknown value is a usage error that names the accepted set. The selection is validated before transport or bundle work (client-side) and again in the command, so a typo fails fast (exit 2) instead of after a review.
2. **One SARIF run per invocation.** `tool.driver` is `{name: "pir", informationUri, version}`; `rules` is one entry per distinct finding category, sorted; `results` is one entry per reported finding, in reporting order.
3. **The mapping is mechanical.** `category` → `ruleId` (lowercased, runs of characters outside `[a-z0-9._-]` collapse to `-`, an empty category becomes `other`); severity → `level` (P0/P1 → `error`, P2 → `warning`, P3 → `note`, anything else → `warning`); the finding's `claim` → `message.text`; anchors → physical locations (the first anchor is the primary `locations` entry, the rest become `relatedLocations` with unique ids); the canonical identity fingerprint → `partialFingerprints["pirFinding/v1"]`; `properties` carries `displayId`, `severity`, `status`, `category` and `confidence` when one is on record.
4. **Locations are valid or absent.** `region.startLine` must be an integer ≥ 1 — an unusable anchor is dropped rather than clamped — and `endLine` is emitted only when it is ≥ `startLine`. URIs are percent-encoded per segment and repository-relative, never absolute or host-specific.
5. **The invocation records completeness.** `executionSuccessful` mirrors `incomplete`; the run's `stoppedBecause` becomes a `warning` notification when the run is incomplete and a `note` when it completed with a stop reason; `properties` carries `command`, `runId` and, for audits, the coverage summary.
6. **Empty is valid.** No reported findings yields `results: []` and omits `rules` (no empty rule array); the document still validates.
7. **Exit codes do not move.** SARIF changes stdout only: `--fail-on`, `--max-findings` and `incomplete` keep their existing meanings and codes.
8. **Lanes that cannot express findings refuse SARIF.** `find --preview`, `audit --dry-run` and `audit coverage` print selections or readouts, not findings, and reject `--format sarif` with a usage error instead of ignoring it.
9. **Remote mode needs a same-version server.** `--format` travels in argv like any other flag; an older server ignores the unknown flag and answers in its default format, so the README states the same-version requirement the other new flags already carry.

## Evidence

**1. The facts already exist.** The mapping is a projection of the JSON envelope: severity ranking (P0/P1 block, P2 warns, P3 notes) is the text report's ranking, the fingerprint is `buildIdentity`'s, the anchors are the persisted anchors, and `incomplete`/`stoppedBecause` are already in the envelope. The SARIF document therefore cannot disagree with `--json`; it can only carry less.

**2. Result identity is stable across runs.** `partialFingerprints["pirFinding/v1"]` is the same sha256 the memory layer uses for finding identity (feature, entity, normalized category, claim and trigger), so a consumer can correlate a result across runs without trusting `displayId`, which is per-project and sequential.

**3. The schema surface is small and checked.** `tests/unit/sarif.test.js` validates the subset this output uses — required top-level fields, the level and rule-id vocabularies, rule-id uniqueness, location regions (startLine ≥ 1, endLine ≥ startLine), related-location id uniqueness, fingerprint shape, invocation shape — against rich, empty, incomplete and audit documents. The output is asserted to be JSON-round-trippable and deterministic.

**4. Nothing else changes.** The text and `--json` branches are the same code paths as before; the new branch is reached only when the resolved format is `sarif`. The existing envelope and text tests pass unchanged.

## Acceptance mapping

- **A1 — the output validates against the SARIF 2.1.0 schema subset used.** `assertValidSarif` in `tests/unit/sarif.test.js` covers every required field and vocabulary used, and runs against a document containing rules, results, related locations and fingerprints.
- **A2 — empty and incomplete runs are valid.** Dedicated tests: no findings gives `results: []` (and no `rules`); an incomplete run gives `executionSuccessful: false` with a warning notification while its results stay intact; an audit carries coverage on the invocation.
- **A3 — JSON/text outputs are unchanged.** The default remains `text`, `--json` selects the same envelope branch as before, and the new CLI tests assert only the `--format` surface (validation, contradictions, preview/readout refusals, help text); the existing output tests are not modified.

## Consequences

- A CI pipeline can consume findings without a custom mapper: files and lines from anchors, severity from levels, and a stable identity from fingerprints.
- `--format` is the one selector; `--json` keeps working and now has a documented equivalent. Contradictory invocations fail loudly instead of silently picking one.
- A truncated run is visible in the document (an unsuccessful invocation plus a notification), so a consumer cannot mistake a stopped audit for a clean scan.
- Remote mode follows the usual same-version rule; nothing is silently downgraded on the client because the flag is forwarded and the server either understands it or the output is not SARIF.
- The document is derived from the envelope's facts, so a future envelope field that matters to SARIF has one obvious place to be added (`properties`), not a parallel model.

## Revisit conditions

- **A SARIF consumer needs a field this mapping omits** (for example `artifactLocation.uriBaseId`, rule metadata beyond a short description, or fix suggestions): extend `properties`/rule metadata deliberately and record it here.
- **GitHub Code Scanning rejects the document** for a field this subset validator does not check: capture the exact rejection, add the check to the validator first, then fix the output.
- **Findings appear without anchors.** They currently omit `locations`; if a consumer requires a location, decide between a placeholder URI and dropping the result — do not invent a file.
- **`--format` is wanted on another lane** (for example `findings list`): design it against that lane's payload instead of reusing the result mapping.

## References

- Standard: SARIF 2.1.0 (OASIS); `$schema` uses `https://json.schemastore.org/sarif-2.1.0.json`.
- Implementation: [`src/app/sarif.ts`](../../src/app/sarif.ts) (the pure builder), [`src/cli/executor.ts`](../../src/cli/executor.ts) (`resolveOutputFormat`, the find/audit emit branches).
- Tests: [`tests/unit/sarif.test.js`](../../tests/unit/sarif.test.js), [`tests/unit/output-format.test.js`](../../tests/unit/output-format.test.js), [`tests/integration/sarif-cli.test.js`](../../tests/integration/sarif-cli.test.js).
- Related decisions: [ADR 0007](0007-aacr-verifier-offline-benchmark.md) and [ADR 0009](0009-m1-end-to-end-benchmark.md) (the identity/provenance discipline the fingerprint follows), [ADR 0013](0013-change-coverage-manifest-decision.md) (the coverage vocabulary an audit invocation carries).
- External mechanism: OCR `alibaba/open-code-review` @ `375f64c` (Apache-2.0), `cmd/opencodereview/sarif.go` — the mapping precedent, not a parity target.
- Roadmap: `docs/roadmap-ocr-second-pass.md` §3, item S6.
