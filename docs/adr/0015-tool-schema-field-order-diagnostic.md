# ADR 0015: Tool-schema field order diagnostic (S1) — reorder stays undecided

## Status

**Accepted (2026-10-22), scope: diagnostic only.** This ADR pins the field order `submit_verdict` declares and the order that actually reaches the provider wire; it does **not** decide the reorder. `submit_verdict` keeps `verdict` before `rationale`, no production tool field moves, and `src/` is unchanged. The M0 point comparison that could justify a reorder is scheduled for Iteration 2 of the OCR second-pass series, not for this change.

## Context

**The hypothesis.** OCR's two filter tools deliberately declare `analysis` before `comment_ids` (`internal/agent/agent.go:1572-1597` in OCR, pinned `375f64c`), after session replays showed the model committing to the ids before reasoning about them. The borrowing question is whether the same mechanism applies to `submit_verdict`, which currently declares `verdict` first and `rationale` second (`src/tools/collector-tools.ts:343-358`). That OCR evidence is for **a different tool on a different task**: a filter that keeps or drops supplied comments, not a verifier that decides whether a finding is real.

**The expected direction.** If a schema's field order nudges generation order, then a rationale-before-verdict schema would make the model reason before committing, and the cost side of the verifier would fall — `falseKillRate` (72.0% on the locked M0 baseline) — without collapsing the north star `killRate` (82.7%) or `interceptPrecision` (32.9%). The baseline and its caliber caveats live in [`tests/eval/aacr/results/RESULTS.md`](../../tests/eval/aacr/results/RESULTS.md) and [ADR 0007](0007-aacr-verifier-offline-benchmark.md); this ADR adds no new measurement.

**The provider caveat.** Schema order is only a **hypothesis about generation order**. pir never constrains sampling here: [`adaptTool`](../../src/agents/session-factory.ts#L383-L399) forwards `tool.parameters` and sets no `constrainedSampling`, so the SDK treats `submit_verdict` as an ordinary JSON-schema tool, not as forced structured output. A provider can receive an ordered schema and a model can still emit its arguments in any order (or reason in a different order internally), so "the provider sees the order" and "the model follows the order" are separate claims.

## Evidence

**1. The declared order.** `createSubmitVerdictTool({})` declares, in insertion order, `verdict, rationale, confidence, priorDecisionStillApplies, decisionAssessments, codeFeedback, rejectionGround, uncertaintyReason`, with `required: ["verdict", "rationale"]`. TypeBox's `Type.Object` preserves insertion order, and the adapted tool the session registers keeps it: the session-options test asserts the same order on `customTools[0].parameters`, which is the object `adaptTool` hands the SDK.

**2. The captured wire order.** [`tests/unit/tool-schema-order.test.js`](../../tests/unit/tool-schema-order.test.js) builds an isolated session whose only custom tool is the real `createSubmitVerdictTool({})`, points the synthetic model at a closed loopback `baseUrl` and installs a payload tap that throws before the request is issued, prompts once, and asserts the captured `params.tools` entry for `submit_verdict`:

- `function.strict === false`;
- `Object.keys(function.parameters.properties)` equals the declared order, and `function.parameters.required` equals `["verdict", "rationale"]`;
- `function.parameters` deep-equals the tool's schema, i.e. the non-strict path forwards it instead of rebuilding it.

The observed wire order is therefore **verdict, rationale, confidence, priorDecisionStillApplies, decisionAssessments, codeFeedback, rejectionGround, uncertaintyReason** — identical to the declared order, not a provider- or SDK-normalised variant.

**3. Why the two agree.** The path is short and every hop preserves order. `adaptTool` passes `parameters` through and installs no `constrainedSampling` (`src/agents/session-factory.ts:383-399`). In `@earendil-works/pi-ai` 0.87.1, `resolveJsonSchemaStrictSampling` (`dist/api/constrained-sampling.js:163`) returns `undefined` when a tool has no `constrainedSampling` config, so `convertTools` (`dist/api/openai-completions.js:1128`) emits `parameters: getJsonSchemaToolParameters(tool, strict)` (line 1153) and `getJsonSchemaToolParameters` (`dist/api/constrained-sampling.js:111`) returns `tool.parameters` unchanged unless `strict === true`. The explicit `strict: false` (line 1155) is the branch the production model takes: `zai-coding-cn/glm-5.3`'s registry entry sets `compat.supportsStrictMode: true`, and a provider without that flag omits the `strict` key while still receiving the same parameters object. Even the strict path that *does* rebuild the schema preserves order: `makeStrictJsonSchema` walks `Object.entries(properties)` and assigns `schema.required = propertyNames` in that same order (`dist/api/constrained-sampling.js:90-96`). The tap itself is a real seam, not a test-only invention: `openai-completions.stream` calls `options.onPayload?.(params, model)` (`dist/api/openai-completions.js:188`) before `retryProviderRequest` (line 197), the pi-agent-core `Agent` exposes `onPayload` as a settable field (`dist/agent.js:128-129`) and forwards it into the loop configuration (line 307), and `createAgentSession` wires the turn through `modelRuntime.streamSimple` (`@earendil-works/pi-coding-agent` 0.87.1 `dist/core/sdk.js:243`). The diagnostic test supplies that stream function from pi-ai's own pinned `openai-completions` module, so the payload it captures is the payload the SDK would send.

**4. The explicit limit.** This evidence proves **order visibility**, not generation order and not a verdict change. It says nothing about whether a model emits `rationale` before `verdict` when the schema is reversed, nothing about whether that changes `rejected`/`confirmed` decisions, and nothing about cost. Those are empirical questions for the M0 comparison below, and the test would keep passing if the reorder turned out to have no behavioural effect at all.

## Decision

1. **Diagnose first; no production reorder before the M0 comparison.** `submit_verdict` keeps its current field order and its current field names and semantics. The diagnostic test is now the regression guard for the order that reaches the wire, so a future change to it is visible and deliberate. No `record_candidate` reorder rides along: that is a separate decision point with its own measurement and ADR.
2. **The Iteration 2 experiment is pre-registered here, before any run.** Population: the fixed M0 100-comment sample (`--limit 100 --seed 42`, digest `74f43e2f25442f0e62f97a9b960ae46de6f05eebfe5173298e16c9838aafc07d`), one side per field order. Repeats: **at least two runs per side**, same model id and thinking level, and the same fixture and provenance pins on both sides; both sides rebuilt from one source tree except for the field order, with the CLI sha256 **and** the `dist/` build digest recorded per side (ADR 0008's lesson: a build identity that cannot see a behaviour change cannot certify a controlled comparison). Metrics: `killRate`, `falseKillRate`, accuracy and **output tokens**, read as a group rather than one at a time. Reporting: a single run per side is labelled a **point comparison**, not a variance floor; two repeats give a spread, not a confidence interval.
3. **Adoption rule, decided now.** Adopt the reorder only if `falseKillRate` falls without a comparable `killRate` collapse **and** the direction replicates across the repeats. Otherwise record "no effect" (or a negative result) in this ADR, close the item as **not adopted**, and do not escalate to a bigger sample to rescue it. If the effect is small or inconsistent, stop.

## Consequences

- The order pir intends and the order the provider receives are now both asserted by model-free tests, so the question "does the reorder even reach the model?" is answered without spending a single model call.
- The wire assertion is deliberately coupled to the pinned SDK: it names `@earendil-works/pi-coding-agent` 0.87.1 and pi-ai 0.87.1 module paths. An SDK upgrade that changes `convertTools` must fail this test loudly rather than let the ADR's evidence go stale silently.
- Nothing user-facing changes. No finding, verdict, JSON-envelope field, exit code, or prompt rendering is touched, and `npm run typecheck && npm test` remains the whole local gate for this ADR.
- If Iteration 2 records no effect, the field order stays as it is and the item closes; a future proposal to reorder would need new evidence, not a rerun of this ADR.

## References

- Baseline, caliber caveats and the M2 change protocol: [`tests/eval/aacr/results/RESULTS.md`](../../tests/eval/aacr/results/RESULTS.md); [ADR 0007](0007-aacr-verifier-offline-benchmark.md) (M0 offline benchmark); [ADR 0008](0008-structured-verifier-rejection-grounds.md) (rejection grounds, the one-comment variance datapoint and the build-digest provenance fix).
- Code under diagnosis: [`src/tools/collector-tools.ts`](../../src/tools/collector-tools.ts#L343-L358) (`submit_verdict`), [`src/agents/session-factory.ts`](../../src/agents/session-factory.ts#L383-L399) (`adaptTool`).
- Diagnostic: [`tests/unit/tool-schema-order.test.js`](../../tests/unit/tool-schema-order.test.js).
- SDK: `@earendil-works/pi-coding-agent` 0.87.1 (`dist/core/sdk.js:243`), `@earendil-works/pi-ai` 0.87.1 (`dist/api/openai-completions.js:188,1128,1153,1155`; `dist/api/constrained-sampling.js:90-96,111,163`), `@earendil-works/pi-agent-core` 0.87.1 (`dist/agent.js:128-129,307`).
- External mechanism: OCR (pinned `375f64c`) `internal/agent/agent.go:1572-1597` — a different tool on a different task; hypothesis only.
