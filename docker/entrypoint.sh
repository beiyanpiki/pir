#!/bin/sh
# pir container entrypoint.
#
# Mount a read-only pi config (models.json / settings.json / auth.json) at
# /pi-config; pi's ModelRuntime needs a writable agent dir (auth store), so
# seed $HOME/.pi/agent from the mount before exec'ing pir.
set -e
if [ -d /pi-config ] && [ -n "$(ls -A /pi-config 2>/dev/null)" ]; then
  mkdir -p "$HOME/.pi/agent"
  cp -r /pi-config/. "$HOME/.pi/agent/"
fi
exec pir "$@"
