# Architecture decision records

This directory records the decisions behind pir's review engine, its CLI and
its evaluation surfaces. Each file states the context, the decision, its
consequences and the conditions that would reopen it. ADRs describe why the
code is the way it is; current behavior lives in [`docs/design.md`](../design.md)
and [`docs/for-llm.md`](../for-llm.md).

## Current records

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-shared-review-executor.md) | One target-aware review executor for change and audit modes | accepted |
| [0002](0002-web-ui-long-run-payloads.md) | Web UI payload and rendering strategy for long runs | accepted |
| [0003](0003-findings-quality-roadmap.md) | Findings-quality roadmap — evidence-gated verification, deterministic parallelism, ReviewBench | accepted; roadmap, amended with results |
| [0004](0004-change-mode-review-pipeline.md) | Change-mode review pipeline — selection, coverage, duplicate feedback and per-file attention | accepted |
| [0005](0005-snippet-anchored-location-correction.md) | Snippet-anchored location correction | accepted |
| [0006](0006-default-token-budget-with-grace.md) | Default token budget with graceful truncation | accepted |
| [0007](0007-aacr-benchmarks-and-verifier-calibration.md) | AACR benchmarks and verifier calibration | accepted; the field-order experiment not adopted |
| [0008](0008-structured-verifier-rejection-grounds.md) | Structured verifier rejection grounds | accepted |
| [0010](0010-project-rules-and-introspection.md) | Layered project rule file and rule introspection | accepted |
| [0011](0011-deferred-and-rejected-directions.md) | Deferred and rejected directions — slicing, session audit, non-borrows | accepted; slicing and session-audit rejected, non-borrows recorded |
| [0016](0016-invocation-inputs-outputs-and-long-runs.md) | Invocation inputs, outputs and long-running execution | accepted; audit resume is a no-go |

New records take the next unused number — currently **0023**. Numbers are
never reused: a superseded decision is marked as such in its own file and
linked from the replacement, and a rejected one stays with its revisit
conditions.

## Consolidation map (2026-10-27)

ADR 0004–0022 were all delivered in PR #146 but had been written as nineteen
separate files across a long-running roadmap branch. They were consolidated
by track and lightly compressed on 2026-10-27. Every decision, consequence and
revisit condition survives in the target file; evidence sections and per-file
framing were condensed, not dropped. Use this table to resolve old numbers and
old links.

| Retired | Was | Now |
| --- | --- | --- |
| 0004 | Change-mode file filter | ADR 0004, Part I |
| 0005 | Snippet-anchored location correction | unchanged (now a standalone ADR) |
| 0006 | Default token budget with grace | unchanged (now a standalone ADR) |
| 0007 | AACR verifier offline benchmark | ADR 0007, Part I |
| 0008 | Structured verifier rejection grounds | unchanged (now a standalone ADR) |
| 0009 | AACR-Bench end-to-end benchmark | ADR 0007, Part II |
| 0010 | Layered project rule file | ADR 0010, Part I |
| 0011 | Deterministic slicing of large changesets | ADR 0011, Part I |
| 0012 | Session-audit enhancements | ADR 0011, Part II |
| 0013 | Change-mode coverage manifest | ADR 0004, Part II |
| 0014 | Visible duplicate feedback in `record_candidate` | ADR 0004, Part III |
| 0015 | Tool-schema field order | ADR 0007, Part III |
| 0016 | Explicit user background for `find` | ADR 0016, Part I |
| 0017 | Per-file attention prompt | ADR 0004, Part IV |
| 0018 | Audit resume identity protocol | ADR 0016, Part II |
| 0019 | `pir rules check` | ADR 0010, Part II |
| 0020 | SARIF 2.1.0 output | ADR 0016, Part III |
| 0021 | OCR second-pass non-borrows | ADR 0011, Part III |
| 0022 | Local detached execution | ADR 0016, Part IV |

Old file names, for links that point at the historical paths:

| Old path | New path |
| --- | --- |
| `0004-change-mode-file-filter.md` | `0004-change-mode-review-pipeline.md` |
| `0007-aacr-verifier-offline-benchmark.md` | `0007-aacr-benchmarks-and-verifier-calibration.md` |
| `0009-m1-end-to-end-benchmark.md` | `0007-aacr-benchmarks-and-verifier-calibration.md` |
| `0010-layered-project-rule-file.md` | `0010-project-rules-and-introspection.md` |
| `0011-large-changeset-slicing-decision.md` | `0011-deferred-and-rejected-directions.md` |
| `0012-session-audit-enhancements-decision.md` | `0011-deferred-and-rejected-directions.md` |
| `0013-change-coverage-manifest-decision.md` | `0004-change-mode-review-pipeline.md` |
| `0014-duplicate-feedback-in-record-candidate.md` | `0004-change-mode-review-pipeline.md` |
| `0015-tool-schema-field-order-diagnostic.md` | `0007-aacr-benchmarks-and-verifier-calibration.md` |
| `0016-user-background-for-find.md` | `0016-invocation-inputs-outputs-and-long-runs.md` |
| `0017-per-file-attention-prompt.md` | `0004-change-mode-review-pipeline.md` |
| `0018-audit-resume-identity-protocol.md` | `0016-invocation-inputs-outputs-and-long-runs.md` |
| `0019-project-rules-check.md` | `0010-project-rules-and-introspection.md` |
| `0020-sarif-output.md` | `0016-invocation-inputs-outputs-and-long-runs.md` |
| `0021-ocr-second-pass-non-borrows.md` | `0011-deferred-and-rejected-directions.md` |
| `0022-local-detached-execution.md` | `0016-invocation-inputs-outputs-and-long-runs.md` |

## Writing a new record

Keep the shape the existing records use: **Status** (accepted, superseded,
rejected, no-go, with the date), **Context**, **Decision**, **Consequences**,
**Revisit conditions**, **References**. A decision that is not adopted stays
in the record with its trigger; "we decided not to build this" is a decision
worth keeping. One ADR may cover several tightly related decisions when they
share a context and were delivered together, as the consolidated records do —
use parts with local decision numbers and an index table, not a new number
per item.
