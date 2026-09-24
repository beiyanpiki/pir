import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReviewCommands } from "./commands.js";
import { registerLifecycle } from "./lifecycle.js";

/**
 * pi-review extension entry point.
 *
 * Commands:
 *   /review-find [base..head options]   run the finding loop
 *   /review-memory status|bootstrap|refresh
 *   /review-feedback <id> <decision> [note]
 *   /review-remember <scope> <target> <kind> <text>
 *
 * All command semantics live in src/app (shared with the `pir` CLI); this
 * module only parses arguments and renders results to the pi UI.
 */
export default function piReviewExtension(pi: ExtensionAPI): void {
  registerReviewCommands(pi);
  registerLifecycle(pi);
}
