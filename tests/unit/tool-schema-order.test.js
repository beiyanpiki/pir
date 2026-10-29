import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createIsolatedSessionOptions } from "../../dist/agents/session-factory.js";
import { createSubmitVerdictTool } from "../../dist/tools/collector-tools.js";

// Field-order diagnostic (docs/adr/0007-aacr-benchmarks-and-verifier-calibration.md): does the
// property order submit_verdict declares reach the provider wire unchanged?
// Everything here is model-free: no credentials, no socket, no ModelRuntime
// (which would read real auth/settings).
const DECLARED_PROPERTY_ORDER = [
  "verdict",
  "rationale",
  "confidence",
  "priorDecisionStillApplies",
  "decisionAssessments",
  "codeFeedback",
  "rejectionGround",
  "uncertaintyReason",
];
const DECLARED_REQUIRED_ORDER = ["verdict", "rationale"];

// The zai-coding-cn/glm-5.3 registry entry sets compat.supportsStrictMode true,
// the branch where pi-ai's convertTools emits an explicit `strict: false` for a
// tool without constrainedSampling. A provider without that flag omits the key
// and receives the same parameters object (pi-ai 1.4.0 convertTools).
const model = {
  id: "test-model", name: "Offline test model", provider: "offline-test",
  api: "openai-completions", baseUrl: "http://127.0.0.1:1", reasoning: true,
  input: ["text"], contextWindow: 100000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsStrictMode: true },
};

// createAgentSession routes the turn through `modelRuntime.streamSimple`. To
// capture the real provider payload we hand it pi-ai's own openai-completions
// stream function — the module convertTools builds the wire request in — taken
// from the SDK's pinned dependency (pi-ai 1.4.0 is a dependency of
// pi-coding-agent 1.4.0, so it resolves next to it, hoisted or nested).
function openAiCompletionsStreamSimple() {
  const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const candidates = [
    new URL("../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js", sdkEntry),
    new URL("../../../@earendil-works/pi-ai/dist/api/openai-completions.js", sdkEntry),
  ];
  for (const candidate of candidates) {
    if (existsSync(fileURLToPath(candidate))) return import(candidate.href).then((module) => module.streamSimple);
  }
  throw new Error("pi-ai openai-completions not found next to @earendil-works/pi-coding-agent");
}

const offlineStream = await openAiCompletionsStreamSimple();
const runtime = new Proxy({
  getModels: () => [model],
  hasConfiguredAuth: () => true,
  streamSimple: (model_, context, options) => offlineStream(model_, context, options),
}, {
  get(target, key) {
    if (key === "then") return undefined;
    if (key in target) return target[key];
    throw new Error(`Unexpected model/auth access in offline test: ${String(key)}`);
  },
});

test("submit_verdict declares verdict first and keeps every field in the declared order", () => {
  const tool = createSubmitVerdictTool({});
  assert.deepEqual(Object.keys(tool.parameters.properties), DECLARED_PROPERTY_ORDER);
  assert.deepEqual(tool.parameters.required, DECLARED_REQUIRED_ORDER);
});

test("the adapted session tool keeps the declared order (adaptTool does not rebuild the schema)", () => {
  const tool = createSubmitVerdictTool({});
  const options = createIsolatedSessionOptions(
    { cwd: "/not-read/project", systemRole: "code reviewer", builtinTools: [], tools: [tool] },
    { agentDir: "/not-read/global", modelRuntime: runtime, model, thinkingLevel: "off" },
  );
  assert.deepEqual(Object.keys(options.customTools[0].parameters.properties), DECLARED_PROPERTY_ORDER);
  assert.deepEqual(options.customTools[0].parameters.required, DECLARED_REQUIRED_ORDER);
});

test("the provider wire carries the declared submit_verdict order with strict: false", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pir-tool-schema-order-"));
  const tool = createSubmitVerdictTool({});
  let captured;
  let turnError;
  let session;
  try {
    const options = createIsolatedSessionOptions(
      { cwd: root, systemRole: "code reviewer", builtinTools: [], tools: [tool] },
      { agentDir: root, modelRuntime: runtime, model, thinkingLevel: "off" },
    );
    ({ session } = await createAgentSession(options));
    // Two independent guards keep this test off the network: baseUrl points at
    // a closed loopback port, and the payload tap throws before the request is
    // issued, so the turn ends at the tap instead of at connect.
    session.agent.getApiKey = () => "offline-test-key";
    session.agent.onPayload = (params) => {
      captured = params;
      throw new Error("offline payload tap: stopped before the provider request");
    };
    await session.prompt("Review the supplied change.", { expandPromptTemplates: false });
    turnError = session.messages.at(-1)?.errorMessage;
  } finally {
    session?.dispose();
    rmSync(root, { recursive: true, force: true });
  }

  assert.ok(captured, "the openai-completions onPayload tap must run before any HTTP request");
  const wireTool = (captured.tools ?? []).find((entry) => entry?.function?.name === "submit_verdict");
  assert.ok(wireTool, "submit_verdict must be present in the provider tools payload");
  assert.equal(wireTool.type, "function");
  assert.equal(wireTool.function.strict, false, "a tool without constrainedSampling is sent non-strict");
  assert.deepEqual(wireTool.function.parameters, tool.parameters, "the non-strict path forwards the TypeBox schema instead of rebuilding it");
  assert.deepEqual(Object.keys(wireTool.function.parameters.properties), DECLARED_PROPERTY_ORDER);
  assert.deepEqual(wireTool.function.parameters.required, DECLARED_REQUIRED_ORDER);
  assert.match(turnError ?? "", /offline payload tap/, "the turn must fail at the tap, never at a provider request");
});
