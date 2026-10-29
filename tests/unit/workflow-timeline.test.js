import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blocksFromLive,
  blocksFromTranscript,
  classifyTool,
  outcomeTitle,
  toolHint,
} from "../../web/src/lib/workflow-timeline.ts";

const tool = (id, name, args = {}, result) => ({
  type: "tool",
  call: { type: "toolCall", id, name, arguments: args },
  ...(result ? { result } : {}),
});

test("classifyTool separates context, diffs, and outcome artifacts", () => {
  assert.equal(classifyTool("read_code"), "read");
  assert.equal(classifyTool("search_text"), "search");
  assert.equal(classifyTool("find_symbol"), "search");
  assert.equal(classifyTool("get_change"), "change");
  assert.equal(classifyTool("get_project_memory"), "memory");
  assert.equal(classifyTool("record_candidate"), "outcome");
  assert.equal(classifyTool("submit_verdict"), "outcome");
  assert.equal(classifyTool("finish_round"), "outcome");
  assert.equal(classifyTool("shell"), "other");
});

test("consecutive context tools group, outcome tools never do", () => {
  const blocks = blocksFromTranscript([
    tool("1", "read_code", { path: "web/src/App.tsx" }, { text: "a", isError: false }),
    tool("2", "read_code", { path: "web/src/main.tsx" }, { text: "b", isError: false }),
    tool("3", "record_candidate", { title: "Candidate A" }, { text: "ok", isError: false }),
    tool("4", "record_candidate", { title: "Candidate B" }, { text: "ok", isError: false }),
    tool("5", "get_change", { path: "web/src/App.tsx" }, { text: "### @@ -1 +1 @@\n-a\n+b", isError: false }),
  ]);
  assert.equal(blocks.length, 4);
  assert.equal(blocks[0].kind, "tools");
  assert.equal(blocks[0].category, "read");
  assert.equal(blocks[0].tools.length, 2);
  assert.equal(blocks[1].kind, "tools");
  assert.equal(blocks[1].category, "outcome");
  assert.equal(blocks[1].tools.length, 1);
  assert.equal(blocks[2].category, "outcome");
  assert.equal(blocks[3].category, "change");
});

test("text and thinking blocks preserve order while consecutive reasoning merges", () => {
  const blocks = blocksFromTranscript([
    { type: "thinking", text: "First thought" },
    { type: "thinking", text: "Second thought" },
    { type: "text", text: "Answer" },
    { type: "text", text: "   " },
  ]);
  assert.deepEqual(blocks.map((block) => block.kind), ["thinking", "text"]);
  assert.equal(blocks[0].text, "First thought\n\nSecond thought");
  assert.equal(blocks[1].text, "Answer");
});

test("live blocks carry streaming and tool status", () => {
  const blocks = blocksFromLive([
    { type: "thinking", text: "Working", streaming: true },
    { type: "text", text: "Partial", streaming: true },
    { type: "tool", name: "search_text", args: { query: "x" }, callId: "c1", running: true },
  ]);
  assert.equal(blocks[0].streaming, true);
  assert.equal(blocks[1].streaming, true);
  assert.equal(blocks[2].kind, "tools");
  assert.equal(blocks[2].tools[0].running, true);
});

test("tool rows carry a user-facing target and outcome summary", () => {
  assert.equal(toolHint({ name: "read_code", args: { path: "web/src/App.tsx" } }), "web/src/App.tsx");
  assert.equal(toolHint({ name: "search_text", args: { query: "sessionAnchor" } }), "sessionAnchor");
  assert.equal(outcomeTitle({ name: "record_candidate", args: { title: "Off-by-one" } }), "Candidate: Off-by-one");
  assert.equal(outcomeTitle({ name: "submit_verdict", args: { verdict: "confirmed" } }), "Verdict: confirmed");
  assert.equal(outcomeTitle({ name: "finish_round", args: { summary: "Round complete" } }), "Round finished: Round complete");
});

test("consecutive same-category tools keep their order inside one block", () => {
  const blocks = blocksFromTranscript([
    tool("1", "search_text", { query: "a" }, { text: "x", isError: false }),
    tool("2", "search_text", { query: "b" }, { text: "y", isError: false }),
  ]);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].tools.map((item) => item.args.query), ["a", "b"]);
});