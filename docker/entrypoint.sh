#!/bin/sh
# pir container entrypoint.
#
# Credentials and config, in priority order:
#   1. /pi-config mount (read-only pi config: settings.json, auth.json, ...)
#      seeded into a writable $HOME/.pi/agent — pi's ModelRuntime needs to
#      write the auth store, so a read-only mount cannot be used directly.
#   2. BIGMODEL_API_KEY env -> generated auth.json for the built-in
#      zai-coding-cn provider (official GLM coding endpoint).
set -e
mkdir -p "$HOME/.pi/agent"
if [ -d /pi-config ] && [ -n "$(ls -A /pi-config 2>/dev/null)" ]; then
  cp -r /pi-config/. "$HOME/.pi/agent/"
fi
if [ -n "$BIGMODEL_API_KEY" ]; then
  AUTH="$HOME/.pi/agent/auth.json"
  if [ -f "$AUTH" ]; then
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const auth = JSON.parse(fs.readFileSync(p, "utf8"));
      auth["zai-coding-cn"] = { type: "api_key", key: process.env.BIGMODEL_API_KEY };
      fs.writeFileSync(p, JSON.stringify(auth, null, 2) + "\n");
    ' "$AUTH"
  else
    printf '{"zai-coding-cn":{"type":"api_key","key":"%s"}}\n' "$BIGMODEL_API_KEY" > "$AUTH"
  fi
  chmod 600 "$AUTH"
fi
exec pir "$@"
