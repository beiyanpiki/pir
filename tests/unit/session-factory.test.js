import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import {
  PiSessionFactory,
  buildReviewSystemPrompt,
  createIsolatedResourceLoader,
  createIsolatedSessionOptions,
  createReviewSettings,
  createToolCallTracker,
  normalizeSessionUsage,
  validateStartupModel,
} from "../../dist/agents/session-factory.js";

// Never create a ModelRuntime in these tests: that would read real auth/settings.
// A synthetic model and a closed fake runtime also make accidental calls fail.
const model = {
  id: "test-model", name: "Offline test model", provider: "offline-test",
  api: "openai-completions", baseUrl: "https://invalid.invalid", reasoning: true,
  input: ["text"], contextWindow: 100000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const modelSpec = `${model.provider}/${model.id}`;
const runtime = new Proxy({
  getModels: () => [model],
  hasConfiguredAuth: () => true,
}, {
  get(target, key) {
    if (key === "then") return undefined;
    if (key in target) return target[key];
    throw new Error(`Unexpected model/auth access in offline test: ${String(key)}`);
  },
});

function config(cwd, overrides = {}) {
  return { cwd, systemRole: "code reviewer", builtinTools: ["read", "grep", "find", "ls"], tools: [], ...overrides };
}

function writeFixture(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

async function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return await fn(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeSession(overrides = {}) {
  return {
    agent: {}, model, thinkingLevel: "off", messages: [],
    subscribe: () => () => {},
    prompt: async () => {},
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, toolCalls: 0 }),
    getLastAssistantText: () => undefined,
    dispose: () => {},
    ...overrides,
  };
}

function factory(createSession, overrides = {}) {
  return new PiSessionFactory({
    createModelRuntime: async () => runtime,
    readStartupModel: () => ({ modelSpec, thinking: "off" }),
    createAgentSession: createSession,
    ...overrides,
  });
}

test("isolated loader ignores malicious global, ancestor and project resources, even on reload", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pir-isolation-test-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project", "nested");
  const agentDir = path.join(home, ".pi", "agent");
  const marker = path.join(root, "extension-executed");
  const poison = "MALICIOUS_AMBIENT_INSTRUCTION_SENTINEL";
  const extension = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); throw new Error('ambient extension was executed');`;
  try {
    mkdirSync(cwd, { recursive: true });
    for (const dir of [agentDir, path.join(root, "project", ".pi"), path.join(cwd, ".pi"), path.join(home, ".agents"), path.join(root, ".agents"), path.join(cwd, ".agents")]) {
      for (const name of ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"]) writeFixture(path.join(dir, name), poison);
      writeFixture(path.join(dir, "extensions", "evil.js"), extension);
      writeFixture(path.join(dir, "hooks", "evil.js"), extension);
      writeFixture(path.join(dir, "skills", "evil", "SKILL.md"), `---\nname: evil\ndescription: ${poison}\n---\n${poison}`);
      writeFixture(path.join(dir, "prompts", "evil.md"), poison);
      writeFixture(path.join(dir, "themes", "evil.json"), "{invalid-theme}");
      writeFixture(path.join(dir, "settings.json"), JSON.stringify({
        defaultProvider: "malicious", defaultModel: "ambient", defaultThinkingLevel: "max",
        packages: ["npm:must-never-resolve"], extensions: ["./extensions/evil.js"],
        skills: ["./skills/evil"], prompts: ["./prompts/evil.md"], defaultTools: ["bash", "write"],
        shellCommandPrefix: poison, enableSkillCommands: true, cacheWarming: "idle",
      }));
    }
    for (const dir of [home, root, path.join(root, "project"), cwd]) {
      writeFixture(path.join(dir, "AGENTS.md"), poison);
      writeFixture(path.join(dir, "SYSTEM.md"), poison);
    }
    await withEnv({ HOME: home, PI_CODING_AGENT_DIR: agentDir }, async () => {
      const options = createIsolatedSessionOptions(config(cwd), { agentDir, modelRuntime: runtime, model, thinkingLevel: "off" });
      const loader = options.resourceLoader;
      for (let i = 0; i < 2; i++) {
        await loader.reload();
        loader.extendResources({
          skillPaths: [{ path: path.join(cwd, ".agents/skills/evil"), metadata: {} }],
          promptPaths: [{ path: path.join(cwd, ".pi/prompts/evil.md"), metadata: {} }],
        });
        assert.deepEqual(loader.getExtensions().extensions, []);
        assert.deepEqual(loader.getExtensions().errors, []);
        assert.deepEqual(loader.getExtensions().runtime.pendingProviderRegistrations, []);
        assert.deepEqual(loader.getSkills(), { skills: [], diagnostics: [] });
        assert.deepEqual(loader.getPrompts(), { prompts: [], diagnostics: [] });
        assert.deepEqual(loader.getThemes(), { themes: [], diagnostics: [] });
        assert.deepEqual(loader.getAgentsFiles(), { agentsFiles: [] });
        assert.deepEqual(loader.getAppendSystemPrompt(), []);
        assert.deepEqual(loader.getAppendSystemPromptSources(), []);
        assert.equal(loader.getSystemPromptSource(), undefined);
        assert.equal(loader.getSystemPrompt(), buildReviewSystemPrompt("code reviewer"));
      }
      await options.settingsManager.reload();
      assert.equal(options.settingsManager.getDefaultProvider(), undefined);
      assert.equal(options.settingsManager.getDefaultModel(), undefined);
      assert.equal(options.settingsManager.getDefaultThinkingLevel(), "off");
      assert.equal(options.settingsManager.getShellCommandPrefix(), undefined);
      assert.equal(options.settingsManager.getEnableSkillCommands(), false);
      assert.equal(options.settingsManager.getCacheWarmingMode(), "off");
      assert.deepEqual(options.settingsManager.getProjectSettings(), {});
      assert.deepEqual(options.settingsManager.getPackages(), []);
      const { session } = await createAgentSession(options);
      try {
        assert.match(session.systemPrompt, /You are a code reviewer operating in a read-only/);
        assert.doesNotMatch(session.systemPrompt, new RegExp(poison));
        assert.doesNotMatch(session.systemPrompt, /expert coding assistant/);
        assert.deepEqual(session.getActiveToolNames().sort(), ["find", "grep", "ls", "read"]);
        assert.equal(session.sessionFile, undefined);
        assert.equal(session.thinkingLevel, "off");
        // Capture the SDK's prepared role messages, stopping before any model loop.
        let prepared;
        session.agent.prompt = async (messages) => { prepared = messages; };
        await session.prompt("Review the supplied change.", { expandPromptTemplates: false });
        assert.equal(prepared[0].role, "system");
        assert.equal(prepared[0].sections.preamble, buildReviewSystemPrompt("code reviewer"));
        const user = prepared.find((message) => message.role === "user");
        assert.equal(user.content[0].text, "Review the supplied change.");
      } finally { session.dispose(); }
      assert.equal(existsSync(marker), false);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("configuration is explicit, memory-only, read-only, and keeps collector tools serial", async () => {
  const custom = {
    name: "finish_round", description: "Finish after collecting evidence",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ text: "done", terminate: true }),
  };
  const options = createIsolatedSessionOptions(config("/not-read/project", { tools: [custom] }), {
    agentDir: "/not-read/global", modelRuntime: runtime, model, thinkingLevel: "off",
  });
  assert.equal(options.modelRuntime, runtime);
  assert.equal(options.model, model);
  assert.equal(options.agentDir, "/not-read/global");
  assert.equal(options.cwd, "/not-read/project");
  assert.equal(options.thinkingLevel, "off");
  assert.equal(options.noTools, "all");
  assert.deepEqual(options.scopedModels, []);
  assert.deepEqual(options.tools, ["read", "grep", "find", "ls", "finish_round"]);
  assert.equal(options.customTools[0].executionMode, "sequential");
  const result = await options.customTools[0].execute("test", {});
  assert.equal(result.terminate, true);
  assert.equal(result.content[0].text, "done");
  assert.equal(options.settingsManager.isProjectTrusted(), false);
  assert.equal(options.settingsManager.getEnableInstallTelemetry(), false);
  assert.equal(options.settingsManager.getEnableAnalytics(), false);
  assert.equal(options.sessionManager.getSessionFile(), undefined);
  for (const name of ["bash", "powershell", "edit", "write", "unknown"]) {
    assert.throws(() => createIsolatedSessionOptions(config("/unused", { builtinTools: [name] }), { agentDir: "/unused", modelRuntime: runtime }), /cannot enable builtin/);
  }
  assert.notEqual(createIsolatedResourceLoader("reviewer").getExtensions().runtime, options.resourceLoader.getExtensions().runtime);
  const settings = createReviewSettings();
  settings.setDefaultProvider("in-memory-only");
  assert.equal(createReviewSettings().getDefaultProvider(), undefined);
  assert.equal(createReviewSettings().getDefaultThinkingLevel(), "medium");
});

test("startup model validation accepts only supported thinking values and preserves off", () => {
  for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.deepEqual(validateStartupModel({ modelSpec: `  ${modelSpec}  `, thinking }), { modelSpec, thinking });
  }
  for (const thinking of ["HIGH", "arbitrary", 7, null, {}]) {
    assert.deepEqual(validateStartupModel({ modelSpec: 42, thinking }), { modelSpec: undefined, thinking: undefined });
  }
  assert.equal(validateStartupModel({ modelSpec: "   " }).modelSpec, undefined);
});

test("usage normalization sums disjoint cache buckets without adding reasoning twice", () => {
  const stats = { tokens: { input: 10, output: 7, cacheRead: 20, cacheWrite: 3, total: 40, reasoning: 6 }, cost: 0.25, toolCalls: 4 };
  assert.deepEqual(normalizeSessionUsage(stats, 120, { toolCalls: 3, repeatedToolCalls: 1 }), {
    inputTokens: 10, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 3, totalTokens: 40,
    cost: 0.25, durationMs: 120, toolCalls: 4, repeatedToolCalls: 1,
  });
  assert.deepEqual(normalizeSessionUsage(undefined, 120, { toolCalls: 2, repeatedToolCalls: 1 }), {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
    cost: 0, durationMs: 120, toolCalls: 2, repeatedToolCalls: 1,
  });
});

test("SDK accounting includes pre-compaction messages, compaction and standalone usage", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pir-usage-test-"));
  const usage = (input, output, cacheRead, cacheWrite, cost) => ({
    input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  });
  let session;
  try {
    ({ session } = await createAgentSession(createIsolatedSessionOptions(config(root), { agentDir: root, modelRuntime: runtime, model })));
    session.sessionManager.appendMessage({ role: "user", content: "old context", timestamp: 1 });
    session.sessionManager.appendMessage({
      role: "assistant", provider: model.provider, model: model.id, api: model.api, stopReason: "toolUse", timestamp: 2,
      content: [{ type: "thinking", thinking: "already billed in output" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }],
      usage: usage(10, 6, 20, 4, 0.01),
    });
    session.sessionManager.appendCompaction("replacement context", null, 40, undefined, false, usage(5, 2, 3, 1, 0.02));
    session.sessionManager.appendUsage("summary-retry", model.provider, model.id, usage(2, 1, 0, 0, 0.03));
    session.refreshContext();
    assert.equal(session.messages.some((message) => message.role === "assistant"), false);
    const normalized = normalizeSessionUsage(session.getSessionStats(), 10);
    assert.deepEqual(normalized, { inputTokens: 17, outputTokens: 9, cacheReadTokens: 23, cacheWriteTokens: 5, totalTokens: 54, cost: 0.06, durationMs: 10, toolCalls: 1, repeatedToolCalls: 0 });
  } finally { session?.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("tool tracker counts identical read/search executions, not collector calls or event updates", () => {
  const tracker = createToolCallTracker();
  const observe = (toolName, args) => tracker.observe({ type: "tool_execution_start", toolName, args });
  observe("read_code", { path: "a.ts", range: { start: 1, end: 4 } });
  observe("read_code", { range: { end: 4, start: 1 }, path: "a.ts" });
  observe("read_code", { path: "a.ts", range: { start: 2, end: 4 } });
  observe("search_text", { query: "needle" });
  observe("search_text", { query: "needle" });
  observe("record_candidate", { title: "candidate" });
  observe("record_candidate", { title: "candidate" });
  tracker.observe({ type: "tool_execution_end", toolName: "read_code" });
  assert.deepEqual(tracker.snapshot(), { toolCalls: 7, repeatedToolCalls: 2 });
  assert.deepEqual(createToolCallTracker().snapshot(), { toolCalls: 0, repeatedToolCalls: 0 });
});

test("factory preserves explicit off and runtime, captures creation time and safe metadata", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pir-factory-test-"));
  const transcriptFile = path.join(root, "transcript.json");
  let sessionOptions;
  let listener;
  let disposed = 0;
  let unsubscribed = 0;
  let receivedPrompt;
  const sdk = fakeSession({
    subscribe: (fn) => { listener = fn; return () => { unsubscribed++; }; },
    prompt: async (...args) => {
      receivedPrompt = args;
      listener({ type: "tool_execution_start", toolName: "read", args: { path: "evidence.ts" } });
      listener({ type: "tool_execution_start", toolName: "read", args: { path: "evidence.ts" } });
      await delay(10);
    },
    getSessionStats: () => ({ tokens: { input: 10, output: 7, cacheRead: 20, cacheWrite: 3, total: 40 }, cost: 0.25, toolCalls: 2 }),
    dispose: () => { disposed++; },
  });
  let handle;
  try {
    const sessions = factory(async (options) => { sessionOptions = options; await delay(20); return { session: sdk }; }, {
      createModelRuntime: async () => { await delay(20); return runtime; },
    });
    handle = await sessions.createSession(config(root, { model: modelSpec, transcriptFile }));
    assert.equal(sessionOptions.modelRuntime, runtime);
    assert.equal(sessionOptions.thinkingLevel, "off");
    assert.equal(sdk.agent.toolExecution, "sequential");
    assert.ok(existsSync(sessionOptions.agentDir));
    await handle.prompt("review only");
    assert.deepEqual(receivedPrompt, ["review only", { expandPromptTemplates: false }]);
    const measured = handle.getUsage();
    assert.ok(measured.durationMs >= 40, `creation was omitted: ${measured.durationMs}`);
    assert.equal(measured.totalTokens, 40);
    assert.equal(measured.repeatedToolCalls, 1);
    const captured = JSON.parse(readFileSync(transcriptFile, "utf8"));
    assert.equal(captured.capture, "session-messages");
    assert.equal(captured.usageAvailable, true);
    assert.deepEqual(captured.usage, measured);
    assert.equal(captured.effectiveConfig.model, modelSpec);
    assert.equal(captured.effectiveConfig.thinkingLevel, "off");
    assert.equal(captured.effectiveConfig.resources, "isolated");
    assert.ok(Date.parse(captured.sessionStartedAt) <= Date.parse(captured.startedAt));
    assert.deepEqual(Object.keys(captured.effectiveConfig).sort(), ["builtinTools", "customTools", "model", "resources", "settings", "systemPrompt", "thinkingLevel", "toolExecution"]);
    await delay(5);
    assert.deepEqual(handle.getUsage(), measured, "settled duration must not keep growing");
    handle.dispose();
    handle.dispose();
    assert.equal(disposed, 1);
    assert.equal(unsubscribed, 1);
    assert.equal(existsSync(sessionOptions.agentDir), false);
    assert.deepEqual(handle.getUsage(), measured);
    await assert.rejects(handle.prompt("late"), /disposed/);
  } finally { handle?.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("factory cleans temporary directory and session when initialization fails", async () => {
  for (const failure of ["sdk", "subscribe"]) {
    let agentDir;
    let disposed = 0;
    const sessions = factory(async (options) => {
      agentDir = options.agentDir;
      assert.ok(existsSync(agentDir));
      if (failure === "sdk") throw new Error("sdk init failed");
      return { session: fakeSession({
        subscribe: () => { throw new Error("subscribe init failed"); },
        dispose: () => { disposed++; },
      }) };
    });
    await assert.rejects(sessions.createSession(config("/unused", { model: modelSpec })), /init failed/);
    assert.equal(existsSync(agentDir), false);
    assert.equal(disposed, failure === "subscribe" ? 1 : 0);
  }
});

test("factory removes temp directories on runtime/model resolution failure and retries failed runtime", async () => {
  const tempSessions = () => readdirSync(tmpdir()).filter((name) => name.startsWith("pir-session-")).sort();
  const before = tempSessions();
  let attempts = 0;
  const sessions = factory(async () => ({ session: fakeSession() }), {
    createModelRuntime: async () => {
      if (++attempts === 1) throw new Error("runtime failed");
      return runtime;
    },
  });
  await assert.rejects(sessions.createSession(config("/unused", { model: modelSpec })), /runtime failed/);
  assert.deepEqual(tempSessions(), before);
  await assert.rejects(sessions.createSession(config("/unused", { model: "missing-provider/missing-model" })), /Model .* not found/);
  assert.deepEqual(tempSessions(), before);
  const handle = await sessions.createSession(config("/unused", { model: modelSpec }));
  handle.dispose();
  assert.equal(attempts, 2);
  assert.deepEqual(tempSessions(), before);
});

test("missing SDK usage is explicit in transcripts; prompt failure still records timing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pir-missing-usage-test-"));
  const transcriptFile = path.join(root, "transcript.json");
  const sessions = factory(async () => ({ session: fakeSession({
    getSessionStats: undefined,
    prompt: async () => { throw new Error("offline test failure"); },
  }) }));
  let handle;
  try {
    handle = await sessions.createSession(config(root, { model: modelSpec, transcriptFile }));
    assert.equal(handle.getUsage(), undefined);
    await assert.rejects(handle.prompt("review"), /offline test failure/);
    assert.equal(handle.getUsage(), undefined);
    const transcript = JSON.parse(readFileSync(transcriptFile, "utf8"));
    assert.equal(transcript.error, "offline test failure");
    assert.equal(transcript.usageAvailable, false);
    assert.equal(transcript.usage.totalTokens, 0);
    assert.ok(transcript.usage.durationMs >= 0);
    handle.dispose();
    assert.equal(handle.getUsage(), undefined);
  } finally { handle?.dispose(); rmSync(root, { recursive: true, force: true }); }
});
