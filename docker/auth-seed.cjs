#!/usr/bin/env node
// pir container entrypoint helper: seed the pi auth store from PI_AUTH_JSON
// and PI_API_KEY__<provider> env vars. Invoked by docker/entrypoint.sh as
//   PIR_ENTRY_AUTH_PATH=… node pir-auth-seed
// Exits non-zero on operator input it refuses to guess about, so a bad
// PI_AUTH_JSON fails loudly at startup instead of as an obscure
// model-auth error later.
"use strict";
const fs = require("node:fs");

const target = process.env.PIR_ENTRY_AUTH_PATH;
if (!target) {
  console.error("pir-entrypoint: PIR_ENTRY_AUTH_PATH is required");
  process.exit(1);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

let auth = {};
try {
  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!isObject(parsed)) {
    // Same policy as an unreadable/corrupt file below: bad operator input
    // fails loudly at startup. "Starting clean" without rewriting the file
    // would leave the bad store in place to resurface later as an obscure
    // model-auth error.
    console.error(
      `pir-entrypoint: ${target} is not a JSON object mapping providers to credentials ` +
        '(bad /pi-config mount?) — fix or remove it',
    );
    process.exit(1);
  }
  auth = parsed;
} catch (err) {
  if (err.code !== "ENOENT") {
    console.error(`pir-entrypoint: cannot read ${target}: ${err.message}`);
    process.exit(1);
  }
}

if (process.env.PI_AUTH_JSON) {
  let parsed;
  try {
    parsed = JSON.parse(process.env.PI_AUTH_JSON);
  } catch (err) {
    console.error(`pir-entrypoint: PI_AUTH_JSON is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!isObject(parsed)) {
    console.error(
      'pir-entrypoint: PI_AUTH_JSON must be a JSON object mapping providers to credentials, ' +
        'e.g. {"anthropic":{"type":"api_key","key":"sk-..."}}',
    );
    process.exit(1);
  }
  Object.assign(auth, parsed);
}

for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith("PI_API_KEY__") && value) {
    auth[name.slice("PI_API_KEY__".length)] = { type: "api_key", key: value };
  }
}

if (Object.keys(auth).length > 0) {
  fs.writeFileSync(target, JSON.stringify(auth, null, 2) + "\n");
}
