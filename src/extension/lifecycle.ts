import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Lifecycle hooks. Memory connections are opened per command and closed in
 * finally blocks, so shutdown only needs to guard against future long-lived
 * resources. Handlers must stay idempotent.
 */
export function registerLifecycle(pi: ExtensionAPI): void {
  pi.on("session_shutdown", async () => {
    // Nothing long-lived to tear down today; sqlite handles are per-command.
  });
}
