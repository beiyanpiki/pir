#!/bin/sh
# pir container entrypoint — provider-agnostic model configuration.
#
# Credentials and config, in priority order (later wins within each kind):
#   1. /pi-config mount (read-only pi config: settings.json, auth.json, ...)
#      seeded into a writable $HOME/.pi/agent — pi's ModelRuntime needs to
#      write the auth store, so a read-only mount cannot be used directly.
#   2. PI_AUTH_JSON env -> merged into auth.json (full pi auth map, e.g.
#      {"anthropic":{"type":"api_key","key":"sk-..."}}).
#   3. PI_API_KEY__<provider> env -> merged as an api_key credential for that
#      provider, e.g. -e PI_API_KEY__deepseek=sk-... (provider ids may contain
#      dashes). Useful for `docker run` / docker-exec flows.
#   4. PI_DEFAULT_PROVIDER / PI_DEFAULT_MODEL / PI_DEFAULT_THINKING env ->
#      override the default model in the seeded settings.json.
#
# Browse what a provider offers with: docker run --rm <image> models --all
set -e
mkdir -p "$HOME/.pi/agent"
if [ -d /pi-config ] && [ -n "$(ls -A /pi-config 2>/dev/null)" ]; then
  cp -r /pi-config/. "$HOME/.pi/agent/"
fi

PIR_ENTRY_AUTH_PATH="$HOME/.pi/agent/auth.json" node -e '
  const fs = require("fs");
  const path = process.env.PIR_ENTRY_AUTH_PATH;
  let auth = {};
  try { auth = JSON.parse(fs.readFileSync(path, "utf8")); } catch { /* absent */ }
  try {
    if (process.env.PI_AUTH_JSON) {
      Object.assign(auth, JSON.parse(process.env.PI_AUTH_JSON));
    }
  } catch (err) {
    console.error("pir-entrypoint: PI_AUTH_JSON is not valid JSON: " + err.message);
    process.exit(1);
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("PI_API_KEY__") && value) {
      auth[name.slice("PI_API_KEY__".length)] = { type: "api_key", key: value };
    }
  }
  if (Object.keys(auth).length > 0) {
    fs.writeFileSync(path, JSON.stringify(auth, null, 2) + "\n");
  }
'
chmod 600 "$HOME/.pi/agent/auth.json" 2>/dev/null || true

PIR_ENTRY_SETTINGS_PATH="$HOME/.pi/agent/settings.json" node -e '
  const fs = require("fs");
  const path = process.env.PIR_ENTRY_SETTINGS_PATH;
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path, "utf8")); } catch { /* absent */ }
  const overrides = {
    PI_DEFAULT_PROVIDER: "defaultProvider",
    PI_DEFAULT_MODEL: "defaultModel",
    PI_DEFAULT_THINKING: "defaultThinkingLevel",
  };
  let changed = false;
  for (const [envName, key] of Object.entries(overrides)) {
    if (process.env[envName]) { settings[key] = process.env[envName]; changed = true; }
  }
  if (changed) fs.writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
'

exec pir "$@"
