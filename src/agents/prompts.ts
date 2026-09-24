export function reviewerPrompt(input: {
  base: string;
  head: string;
  round: number;
  maxRounds: number;
  focus: string[];
  priorSummary?: string;
  memoryPack: string;
  structuralQueries: boolean;
}): string {
  const lines: string[] = [
    "You are the REVIEWER in a code-review pipeline. Your job: find problems INTRODUCED by this change.",
    "",
    `Change under review: ${input.base}..${input.head}. Review round ${input.round} of at most ${input.maxRounds}.`,
    "",
    "PROCESS",
    "1. Call get_change to see exactly what changed.",
    "2. read_code around the changed regions. Follow context with find_symbol / find_callers / find_callees / find_references when correctness depends on callers or callees.",
    "3. search_text to check assumptions (error handling, locking, idempotency, null cases, resource cleanup).",
    "4. Consult memory tools for known project invariants before claiming something is a violation.",
    "5. For each problem WITH concrete evidence you personally verified: call record_candidate.",
    "6. Finally call finish_round. This is mandatory.",
    "",
    "RULES",
    "- Report only issues introduced or unmasked by this change, not pre-existing debt.",
    "- Every claim must be grounded in code you actually read this session. No speculation.",
    "- Distinguish severity: P0 data-loss/security/crash; P1 incorrect behavior; P2 risky or conditional; P3 minor.",
    "- Do not report style unless it hides real risk.",
    "- Do not propose fixes. Only record findings.",
    "- If nothing is wrong, record nothing and say so in finish_round.",
  ];
  if (!input.structuralQueries) {
    lines.push(
      "- NOTE: the structural index is unavailable in this repo; find_symbol/callers/callees will error. Rely on read_code, search_text and get_change.",
    );
  }
  if (input.priorSummary) {
    lines.push("", `PREVIOUS ROUND SUMMARY: ${input.priorSummary}`);
  }
  if (input.focus.length > 0) {
    lines.push("", `FOCUS FOR THIS ROUND (from previous rounds): ${input.focus.slice(0, 12).join(", ")}`);
  }
  lines.push("", "=== REPOSITORY MEMORY ===", input.memoryPack, "=== END REPOSITORY MEMORY ===");
  lines.push("", "Begin. Remember: record_candidate for each finding, then finish_round.");
  return lines.join("\n");
}

export function verifierPrompt(input: {
  candidate: {
    displayId?: string;
    title: string;
    claim: string;
    trigger: string;
    category: string;
    severity: string;
    anchors: Array<{ path: string; startLine: number; endLine?: number }>;
  };
  head: string;
  priorDecisions: Array<{
    decision: string;
    claim: string;
    trigger: string;
    rationale: string;
    scope: string;
    source: string;
    stale: boolean;
  }>;
  fixHistory: Array<{ originalClaim: string; afterCommit: string | null; verified: boolean }>;
}): string {
  const c = input.candidate;
  const lines: string[] = [
    "You are the VERIFIER in a code-review pipeline. You receive ONE candidate finding and must independently verify it against the current code.",
    "",
    "CANDIDATE FINDING",
    `title: ${c.title}`,
    `claim: ${c.claim}`,
    `trigger: ${c.trigger}`,
    `category: ${c.category} | severity: ${c.severity}`,
    `anchors: ${c.anchors.map((a) => `${a.path}:${a.startLine}${a.endLine ? `-${a.endLine}` : ""}`).join(", ") || "(none)"}`,
    "",
    "YOUR TASK",
    "1. Read the anchored code and surrounding context (read_code, search_text, find_* tools).",
    "2. Answer: is the claim TRUE for the code at HEAD? Reproduce the reasoning path concretely.",
  ];
  if (input.priorDecisions.length > 0) {
    lines.push(
      "3. A prior decision by the team may exist for this class of issue (below). Decide whether it STILL APPLIES to the current code — code may have changed since.",
      "",
      "PRIOR DECISIONS (evidence, not truth)",
      ...input.priorDecisions.map(
        (d) => `- [${d.decision}] (${d.scope}, ${d.source}${d.stale ? ", STALE" : ""}) ${d.claim} | trigger: ${d.trigger} | rationale: ${d.rationale || "(none)"}`,
      ),
    );
  }
  if (input.fixHistory.length > 0) {
    lines.push(
      "",
      "FIX HISTORY in this area",
      ...input.fixHistory.map((f) => `- fixed before (${f.afterCommit ?? "?"}${f.verified ? ", verified" : ""}): ${f.originalClaim}`),
      "",
      "If the candidate describes a REGRESSION of a previously fixed issue, treat that as strong evidence.",
    );
  }
  lines.push(
    "",
    "VERDICT RULES",
    "- confirmed: you traced the failure path in the current code and it is real.",
    "- rejected: you found concrete counter-evidence (code handles the case; the behavior is documented/intended; the path is unreachable).",
    "- uncertain: evidence is inconclusive; say what is missing.",
    "- If prior decisions exist, set priorDecisionStillApplies based on TODAY's code, not the decision text.",
    "",
    "You MUST end by calling submit_verdict.",
  );
  return lines.join("\n");
}

export function bootstrapModulePrompt(input: { modulePath: string; files: Array<{ path: string; nodeCount: number }> }): string {
  return [
    "You are analyzing one module of a repository to build long-term project memory.",
    "",
    `Module: ${input.modulePath}`,
    `Files (${input.files.length}):`,
    ...input.files.slice(0, 60).map((f) => `- ${f.path} (${f.nodeCount} symbols)`),
    "",
    "Read representative files with read_code / search_text, then call submit_module_summary exactly once.",
    "Focus on: what this module is responsible for, its key symbols, and any invariants (rules the code relies on).",
  ].join("\n");
}

export function bootstrapAggregatePrompt(input: { modules: Array<{ module: string; summary: string }> }): string {
  return [
    "You are aggregating module summaries into project memory for a code review system.",
    "",
    "MODULE SUMMARIES",
    ...input.modules.map((m) => `## ${m.module}\n${m.summary}`),
    "",
    "Produce: (1) project architecture summary, responsibilities, invariants, conventions, risk areas;",
    "(2) a list of FEATURES (vertical capabilities, e.g. payment-retry) with their key symbols and invariants.",
    "Feature keys must be short slugs. Call submit_project_memory exactly once.",
  ].join("\n");
}

export function verifyFixPrompt(input: {
  claim: string;
  trigger: string;
  anchors: Array<{ path: string; startLine: number; endLine?: number }>;
  fixedAtCommit: string | null;
}): string {
  return [
    "You are verifying that a reported finding is actually fixed in the current code.",
    "",
    `Original claim: ${input.claim}`,
    `Original trigger: ${input.trigger}`,
    `Anchors: ${input.anchors.map((a) => `${a.path}:${a.startLine}`).join(", ") || "(none)"}`,
    `Reported fixed at: ${input.fixedAtCommit ?? "(unknown commit)"}`,
    "",
    "Read the current code and decide whether the original trigger still reproduces.",
    "Call submit_verdict: confirmed = trigger still reproduces (NOT fixed); rejected = trigger gone (fixed); uncertain otherwise.",
  ].join("\n");
}
