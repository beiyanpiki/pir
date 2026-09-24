import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createAppContext } from "../app/context.js";
import { runFind, toFindingView } from "../app/find.js";
import { feedback, feedbackPriority, listFindings, memoryBootstrap, memoryRefresh, memoryStatus, remember, showFinding, verifyFix } from "../app/services.js";
import { renderFindResultText } from "../app/output.js";
import { FEEDBACK_DECISIONS } from "../memory/feedback.js";

/** Tokenize a command argument string, honoring double-quoted segments. */
export function tokenizeArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]!);
  }
  return out;
}

function extractFlag(tokens: string[], name: string): string | undefined {
  const i = tokens.indexOf(name);
  return i >= 0 ? tokens[i + 1] : undefined;
}

export function registerReviewCommands(pi: ExtensionAPI): void {
  pi.registerCommand("review-find", {
    description: "Run the pi-review finding loop on a change range (default HEAD^..HEAD)",
    getArgumentCompletions: (prefix) => {
      const options = ["--base", "--head", "--max-rounds", "--model"].filter((o) => o.startsWith(prefix));
      return options.length > 0 ? options.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = tokenizeArgs(args);
      const app = await createAppContext(ctx.cwd);
      try {
        ctx.ui.setStatus("review", "review running…");
        const result = await runFind(app, {
          base: extractFlag(tokens, "--base"),
          head: extractFlag(tokens, "--head"),
          maxRounds: extractFlag(tokens, "--max-rounds") !== undefined ? Number(extractFlag(tokens, "--max-rounds")) : undefined,
          model: extractFlag(tokens, "--model"),
        });
        const findings = result.findings.map((row) => toFindingView(app, row));
        ctx.ui.notify(renderFindResultText({ degraded: result.degraded, rounds: result.rounds, findings, stoppedBecause: result.stoppedBecause }), "info");
      } finally {
        ctx.ui.setStatus("review", undefined);
        app.memory.close();
      }
    },
  });

  pi.registerCommand("review-memory", {
    description: "Repository memory: status | bootstrap | refresh",
    getArgumentCompletions: (prefix) => {
      const options = ["status", "bootstrap", "refresh"].filter((o) => o.startsWith(prefix));
      return options.length > 0 ? options.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [sub = "status"] = tokenizeArgs(args);
      const app = await createAppContext(ctx.cwd);
      try {
        if (sub === "status") {
          const status = await memoryStatus(app);
          ctx.ui.notify(
            `project ${status.projectId.slice(0, 12)}…\ncodegraph: ${status.codeMap.kind} (${status.codeMap.nodeCount} nodes)\nfeatures ${status.counts.features} | entities ${status.counts.entities} (${status.counts.staleEntities} stale) | issue memories ${status.counts.issueMemories} | findings ${status.counts.findings}\nlast indexed: ${status.lastIndexedCommit ?? "(never)"}`,
            "info",
          );
        } else if (sub === "bootstrap") {
          ctx.ui.setStatus("review", "bootstrapping memory…");
          const result = await memoryBootstrap(app, {
            onProgress: (m) => ctx.ui.setStatus("review", m),
          });
          ctx.ui.notify(`bootstrap done: ${result.modulesSummarized} modules, ${result.featuresCreated} features, ${result.entitiesCreated} entities`, "info");
        } else if (sub === "refresh") {
          const result = await memoryRefresh(app);
          ctx.ui.notify(`refresh done: ${result.changedFiles.length} changed files, ${result.entitiesRefreshed} entities refreshed, ${result.staleMarked} marked stale`, "info");
        } else {
          ctx.ui.notify(`usage: /review-memory status|bootstrap|refresh`, "warning");
        }
      } finally {
        ctx.ui.setStatus("review", undefined);
        app.memory.close();
      }
    },
  });

  pi.registerCommand("review-feedback", {
    description: `Record feedback on a finding: /review-feedback <id> <${FEEDBACK_DECISIONS.join("|")}|priority P0-P3> [note]`,
    getArgumentCompletions: (prefix) => {
      const options = [...FEEDBACK_DECISIONS, "priority"].filter((o) => o.startsWith(prefix));
      return options.length > 0 ? options.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = tokenizeArgs(args);
      const findingId = tokens[0];
      const decision = tokens[1];
      if (!findingId || !decision) {
        ctx.ui.notify(`usage: /review-feedback <id> <${FEEDBACK_DECISIONS.join("|")}|priority> [note]`, "warning");
        return;
      }
      const app = await createAppContext(ctx.cwd);
      try {
        if (decision === "priority") {
          const priority = tokens[2] ?? "";
          if (!["P0", "P1", "P2", "P3"].includes(priority)) {
            ctx.ui.notify("priority must be P0|P1|P2|P3", "warning");
            return;
          }
          const result = feedbackPriority(app, findingId, priority, tokens.slice(3).join(" "));
          ctx.ui.notify(`${result.findingDisplayId} priority set to ${priority}`, "info");
          return;
        }
        if (!(FEEDBACK_DECISIONS as readonly string[]).includes(decision)) {
          ctx.ui.notify(`decision must be one of: ${FEEDBACK_DECISIONS.join(", ")}`, "warning");
          return;
        }
        const result = await feedback(app, { findingId, decision, note: tokens.slice(2).join(" ") });
        ctx.ui.notify(
          `${result.findingDisplayId}: ${result.previousStatus} -> ${result.newStatus}${result.issueMemoryId ? " (issue memory recorded)" : ""}${result.resolutionId ? " (resolution recorded)" : ""}`,
          "info",
        );
      } finally {
        app.memory.close();
      }
    },
  });

  pi.registerCommand("review-remember", {
    description: "Store code knowledge: /review-remember project|feature <key>|symbol <key> invariant|note|risk <text>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = tokenizeArgs(args);
      const scope = tokens[0];
      if (!scope || !["project", "feature", "symbol"].includes(scope)) {
        ctx.ui.notify("usage: /review-remember project|feature <key>|symbol <key> invariant|note|risk <text>", "warning");
        return;
      }
      let target: string | undefined;
      let kind: string;
      let text: string;
      if (scope === "project") {
        kind = tokens[1] ?? "";
        text = tokens.slice(2).join(" ");
      } else {
        target = tokens[1];
        kind = tokens[2] ?? "";
        text = tokens.slice(3).join(" ");
      }
      if (!["invariant", "note", "risk"].includes(kind) || text.length === 0 || (scope !== "project" && !target)) {
        ctx.ui.notify("usage: /review-remember project|feature <key>|symbol <key> invariant|note|risk <text>", "warning");
        return;
      }
      const app = await createAppContext(ctx.cwd);
      try {
        const result = remember(app, { scope: scope as "project", target, kind: kind as "invariant", text });
        ctx.ui.notify(`remembered (${result.scope}${result.target ? ` ${result.target}` : ""})`, "info");
      } finally {
        app.memory.close();
      }
    },
  });
}
