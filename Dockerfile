# pir — pi-based code review engine with repository memory.
#
# Two usage modes share this image:
#   docker exec:  docker run -v $PWD:/workspace pir <command...>
#                 (all state lands in <repo>/.pir/ via PIR_STATE_IN_PROJECT)
#   serve:       docker run -p 8790:8790 pir serve
#                 (HTTPS executor; call it with `pir --server https://... ...`)

FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# git: fixture/change-set plumbing; ripgrep: search_text tool;
# openssl: self-signed cert generation for `pir serve`.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'

# Optional structural index (degrades gracefully when absent at runtime).
ARG INSTALL_CODEGRAPH=1
RUN if [ "$INSTALL_CODEGRAPH" = "1" ]; then npm i -g @colbymchenry/codegraph@1.6.0 || true; fi

# Writable home for pi (model config mounted at /home/pi/.pi) plus server-side
# data roots (registered clones, centralized memory state).
RUN mkdir -p /home/pi /app /workspace /data/repos /data/state \
  && chown -R node:node /home/pi /app /workspace /data
ENV HOME=/home/pi \
    PIR_STATE_IN_PROJECT=1

COPY --from=build /build/node_modules /app/node_modules
COPY --from=build /build/dist /app/dist
COPY package.json /app/package.json
COPY docker/entrypoint.sh /usr/local/bin/pir-entrypoint
RUN chmod +x /app/dist/cli/cli.js /usr/local/bin/pir-entrypoint \
  && ln -s /app/dist/cli/cli.js /usr/local/bin/pir \
  && ln -s /app/dist/cli/cli.js /usr/local/bin/pir-review

WORKDIR /workspace
USER node
ENTRYPOINT ["pir-entrypoint"]
CMD ["--help"]
