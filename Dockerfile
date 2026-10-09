# pir — pi-based code review engine with repository memory.
#
# Two usage modes share this image:
#   docker exec:  docker run -v $PWD:/workspace pir <command...>
#                 (all state lands in <repo>/.pir/ via PIR_STATE_IN_PROJECT)
#   serve:       docker run -p 8790:8790 pir serve
#                 (HTTPS executor; call it with `pir --server https://... ...`)

FROM node:22-bookworm-slim AS build
WORKDIR /build
# Workspaces: npm ci needs the web workspace manifest next to the root one.
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
# tsc (server) + vite (web SPA into dist/web, served by `pir serve --web`)
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# git: fixture/change-set plumbing; ripgrep: search_text tool;
# openssl: self-signed cert generation for `pir serve`.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'

# Optional structural index (degrades gracefully when absent at runtime).
# A failed install must fail the build: an image that silently lacks the
# binary it was asked to carry is exactly the "installed but never usable"
# trap #64 was filed against.
ARG INSTALL_CODEGRAPH=1
RUN if [ "$INSTALL_CODEGRAPH" = "1" ]; then npm i -g @colbymchenry/codegraph@1.6.0; fi

# Writable home for pi (seeded from /pi-config + PI_* env vars by the
# entrypoint) plus server-side data roots (registered clones, centralized
# memory state).
RUN mkdir -p /home/pi /app /workspace /data/repos /data/state \
  && chown -R node:node /home/pi /app /workspace /data
ENV HOME=/home/pi \
    PIR_STATE_IN_PROJECT=1

COPY --from=build /build/node_modules /app/node_modules
COPY --from=build /build/dist /app/dist
COPY package.json /app/package.json
# Built-in language packs (dist/plugins/loader.js resolves ../../plugins) and
# the shipped skill (dist/cli/executor.js resolves ../../skills) are runtime
# data, not build inputs — without them every review fails at pack loading.
COPY plugins /app/plugins
COPY skills /app/skills
COPY docker/entrypoint.sh /usr/local/bin/pir-entrypoint
COPY docker/auth-seed.cjs /usr/local/bin/pir-auth-seed
RUN chmod +x /app/dist/cli/cli.js /usr/local/bin/pir-entrypoint \
  && ln -s /app/dist/cli/cli.js /usr/local/bin/pir \
  && ln -s /app/dist/cli/cli.js /usr/local/bin/pir-review

WORKDIR /workspace
USER node
ENTRYPOINT ["pir-entrypoint"]
CMD ["--help"]
