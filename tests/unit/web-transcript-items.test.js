import { test } from "node:test";
import assert from "node:assert/strict";
// Type-stripped import: transcript-items.ts is the pure (React-free) half of
// TranscriptView, so this suite drives message flattening without a DOM.
import { buildItems } from "../../web/src/components/session/transcript-items.ts";

const messages = [
  { role: "system", content: "", sections: { preamble: "You are a code reviewer…" } },
  { role: "user", content: [{ type: "text", text: "review this diff" }] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "plan the review", redacted: false },
      { type: "text", text: "Starting with the diff." },
      { type: "toolCall", id: "call-1", name: "get_change", arguments: { path: "lib.ts" } },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "get_change",
    isError: false,
    content: [{ type: "text", text: '## "lib.ts" [modified] (+1/-1); hunks: 1' }],
  },
  { role: "user", content: [{ type: "text", text: "continue" }] },
];

test("buildItems: SDK system message is dropped instead of rendered as a raw JSON row", () => {
  const items = buildItems(messages);
  assert.ok(
    items.every((item) => item.type !== "raw"),
    "no raw JSON rows for system plumbing",
  );
  assert.ok(!items.some((item) => item.type === "raw" && item.label === "message (system)"));
});

test("buildItems: toolCall is paired with its toolResult", () => {
  const items = buildItems(messages);
  const tool = items.find((item) => item.type === "tool");
  assert.ok(tool, "tool item present");
  assert.equal(tool.call.name, "get_change");
  assert.deepEqual(tool.call.arguments, { path: "lib.ts" });
  assert.equal(tool.result.text, '## "lib.ts" [modified] (+1/-1); hunks: 1');
  assert.equal(tool.result.isError, false);
});

test("buildItems: the leading user prompt is dropped, later user messages render", () => {
  const items = buildItems(messages);
  const users = items.filter((item) => item.type === "user");
  assert.deepEqual(users.map((item) => item.text), ["continue"]);
});

test("buildItems: thinking and text blocks flatten in order", () => {
  const items = buildItems(messages).map((item) => item.type);
  assert.deepEqual(items, ["thinking", "text", "tool", "user"]);
});

test("buildItems: unknown roles still surface as raw rows", () => {
  const items = buildItems([{ role: "developer", content: "note" }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "raw");
  assert.equal(items[0].label, "message (developer)");
});
