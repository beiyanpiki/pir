import type { Memory } from "./index.js";

export type RememberScope = "project" | "feature" | "symbol";
export type RememberKind = "invariant" | "note" | "risk";

export interface RememberInput {
  scope: RememberScope;
  /** feature key or symbol key; ignored for project scope. */
  target?: string;
  kind: RememberKind;
  text: string;
  commit: string;
}

export interface RememberResult {
  scope: RememberScope;
  target?: string;
  stored: "invariants" | "conventions" | "riskAreas" | "responsibilities" | "notes";
  eventId: number;
}

/**
 * User-supplied knowledge about the code itself (not tied to a finding).
 * Stored with source=user_explicit so it outranks every agent summary and may
 * act as suppression evidence.
 */
export function rememberKnowledge(memory: Memory, input: RememberInput): RememberResult {
  if (input.scope !== "project" && !input.target) {
    throw new Error(`scope ${input.scope} requires a target`);
  }

  const eventId = memory.findings.appendFeedbackEvent({
    action: "remember",
    scope: input.scope,
    target: input.target ?? null,
    note: input.text,
  });

  if (input.scope === "project") {
    const field = input.kind === "risk" ? "riskAreas" : input.kind === "note" ? "conventions" : "invariants";
    memory.projectMemory.appendUserKnowledge(field, input.text);
    return { scope: input.scope, stored: field, eventId };
  }

  if (input.scope === "feature") {
    memory.features.appendUserKnowledge(input.target!, "invariant", input.text, input.commit);
    return { scope: input.scope, target: input.target, stored: "invariants", eventId };
  }

  memory.entities.appendUserKnowledge(input.target!, input.kind === "note" ? "note" : "invariant", input.text, input.commit);
  return { scope: input.scope, target: input.target, stored: input.kind === "note" ? "notes" : "invariants", eventId };
}
