#!/usr/bin/env node
/**
 * Backfill/sync a round's scratch transcripts into the shared state root
 * (<PIR_EVAL_STATE_ROOT>/<projectId>/transcripts/<runId>) so the pir web
 * explorer can render benchmark sessions. Idempotent; safe to run while a
 * round is in flight (skips runs whose target already exists).
 *
 * Usage: PIR_EVAL_STATE_ROOT=$HOME/.local/state/pir \
 *          node tests/eval/reviewbench/sync-transcripts.js <round>
 */
import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const round = process.argv[2];
if (!round) {
  console.error("usage: node tests/eval/reviewbench/sync-transcripts.js <round>");
  process.exit(2);
}
const stateRoot = process.env.PIR_EVAL_STATE_ROOT ?? path.join(homedir(), ".local", "state", "pir");
const scratchRoot = path.join(ROOT, "tests", "eval", "reviewbench", ".cache", "runs", round);
if (!existsSync(scratchRoot)) {
  console.error(`no scratch for round ${round}: ${scratchRoot}`);
  process.exit(1);
}
const { SqliteStore } = await import(pathToFileURL(path.join(ROOT, "dist/memory/sqlite-store.js")).href);

let copied = 0;
let skipped = 0;
for (const runLabel of readdirSync(scratchRoot)) {
  const labelDir = path.join(scratchRoot, runLabel);
  if (!statSync(labelDir).isDirectory()) continue;
  for (const key of readdirSync(labelDir)) {
    const stateDir = path.join(labelDir, key, "state");
    const dbPath = path.join(stateDir, "memory.sqlite");
    const transcriptsDir = path.join(stateDir, "transcripts");
    if (!existsSync(dbPath) || !existsSync(transcriptsDir)) continue;
    const store = SqliteStore.open(dbPath);
    let projectId;
    try {
      projectId = store.get("SELECT id FROM projects LIMIT 1")?.id;
    } finally {
      store.close();
    }
    if (!projectId) continue;
    for (const runId of readdirSync(transcriptsDir)) {
      const src = path.join(transcriptsDir, runId);
      const dst = path.join(stateRoot, projectId, "transcripts", runId);
      if (existsSync(dst)) {
        skipped += 1;
        continue;
      }
      cpSync(src, dst, { recursive: true });
      console.log(`synced ${runLabel}/${key} ${runId} → ${path.relative(stateRoot, dst)}`);
      copied += 1;
    }
  }
}
console.log(`done: ${copied} transcript dirs synced, ${skipped} already present`);
