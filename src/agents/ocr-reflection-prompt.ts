/**
 * OCR comment-reflection prompt — the AACR-Bench verifier-benchmark comparison arm.
 *
 * Evaluation apparatus, NOT product prompt text. Ported from
 * alibaba/open-code-review @ 8eb83340a487b1150af00701b94f01af97e4b4d6 (Apache-2.0):
 *   - internal/config/template/prompts/review_filter_task_system.md (verbatim)
 *   - internal/config/template/prompts/review_filter_task_user.md (verbatim, except the
 *     trailing Output section: upstream forces a choice between the tools
 *     report_incorrect_comments / approve_all_comments, while this port asks for one JSON
 *     object with the same two outcomes because the eval driver has no tool-choice channel)
 * The comment payload shape (JSON array of {id, path, content}) and the <file path="...">
 * diff wrapper reproduce upstream's buildGroupFilterCommentsJSON / buildConcatenatedDiffs
 * (internal/agent/agent.go:1616, :1926). Attribution also lives in
 * tests/eval/aacr/LICENSE-attribution.md and in every results file this arm feeds.
 *
 * Only `pir _verify-comment --arm ocr` imports this module; it is unreachable from any
 * stable command, and the module itself has no side effects.
 */

export const OCR_REFLECTION_ATTRIBUTION = {
  project: "alibaba/open-code-review",
  repo: "https://github.com/alibaba/open-code-review",
  commit: "8eb83340a487b1150af00701b94f01af97e4b4d6",
  license: "Apache-2.0",
  systemPrompt: "internal/config/template/prompts/review_filter_task_system.md",
  userPrompt: "internal/config/template/prompts/review_filter_task_user.md",
} as const;

export const OCR_REFLECTION_SYSTEM_PROMPT = "You are a fact-checker for code review comments.\n\nThese review comments come from an Agent that could invoke tools to read the full codebase. You can see only the diffs of the files it reviewed together. Anything you cannot see, the Agent may well have seen.\n\nYour task is narrow: remove only the comments that this diff **proves** to be factually wrong. You are not judging whether a comment is useful, well-prioritized, or worth a reviewer's time.\n\nThe two mistakes available to you are not equally bad:\n\n- Keeping an incorrect comment costs a reviewer a few seconds of attention.\n- Removing a correct comment silently destroys a real finding. It never reaches anyone, and nobody learns that it was dropped.\n\nSo when your evidence falls short of proof, approve. \"Suspicious\", \"I cannot verify this\", \"low value\", \"the flagged code looks fine to me\", and \"I would not have raised this\" all mean approve.";

export const OCR_REFLECTION_USER_TEMPLATE = "### Task\n\nBelow are the diffs of one or more related files, and a set of review comments about them. Identify only the comments that these diffs **prove** to be wrong.\n\nEvery comment carries a `path`. The `<file>` element with that same path is the comment's subject; the other files are context. They can supply the evidence a cross-file comment rests on, but they never stand in for the subject file — code present somewhere in the group is not present in the file the comment was filed against.\n\nYour default answer is to approve everything. On most reviews that is the correct answer.\n\n### The only two grounds for removal\n\n**Ground A — the comment targets code that is not in its subject file's diff.**\n\nThe symbol, statement, or construct the comment describes appears nowhere in the `<file>` whose path the comment names. This ground is judged against that file alone — the same construct appearing in a sibling file does not rescue the comment. Typical shapes:\n\n- it discusses the body of a function, on a file that only declares or references it\n- it discusses host-language logic on a file that holds none — a query, build, markup, or configuration file\n- it claims code was removed, or an error is handled, and its subject file's diff contains no such change\n\n**Ground B — a specific diff line literally contradicts the comment's central claim.**\n\nThe comment asserts a concrete fact and the diffs show the opposite in plain text. Unlike Ground A, the contradicting line may sit in any `<file>` in the group: a comment calling an identifier unused is wrong once any of these files uses it. The contradiction must be readable straight off the diff, not derived through a chain of reasoning. Typical shapes:\n\n- it says an identifier is unused, and the diff shows it in use\n- it says a check, assertion, or branch is missing, and the diff contains it\n- it says a value is hardcoded, and the diff shows it read from a variable\n- it says something is declared twice and shadows an outer name, and the diff holds exactly one declaration\n- it states a condition or type relationship that the diff's own text refutes\n\nIf you cannot point to the specific diff line that establishes Ground A or Ground B, approve the comment.\n\n### Protected subjects — never remove\n\nThese are vetoes, applied before you judge correctness at all. Whatever you conclude about the comment, approve it if its subject is:\n\n- **Memory safety** — allocation size, buffer length, index bounds, off-by-one, use-after-free, null dereference\n- **Concurrency** — locks and lock modes, atomics, data races, synchronization arguments that are not honored\n- **Linkage and declaration consistency** — `static` versus non-`static`, a declaration that disagrees with its definition, missing `extern`\n- **Behavioral or compatibility change** — a message, field, status, or default that the old code produced and the new code no longer does; an altered error path; a counter whose update moved to a different point in the lifecycle\n- **A parameter the function accepts and never uses**\n\nThese are the categories where a wrongly removed comment is most expensive, and where your own confidence is least trustworthy — including confidence that the language, compiler, or runtime does not behave the way the comment claims. On a protected subject you do not get to be confident. Approve.\n\n### Not grounds for removal\n\n- The comment is about style, formatting, naming, blank lines, the wording of a code comment, or readability — **provided what it states is true**. Low value is not incorrectness, and filtering by value is not your job.\n- The comment reasons about runtime behavior, business semantics, or code in files you cannot see. The Agent had access you do not.\n- You disagree with its recommendation, or you consider the flagged code acceptable as written.\n- You cannot confirm it. Unverifiable is not incorrect.\n- It identifies a real problem but quotes a slightly wrong line or snippet. Judge the claim, not the citation.\n- It is imprecise in passing while its central claim holds.\n\n### Method\n\nRun these steps in order for every comment. Stop at the first step that applies — do not revisit a decision a later step would have made differently.\n\n**Step 1 — protected-subject veto.** Is the comment's subject one of the protected categories above (memory safety, concurrency, linkage and declaration consistency, behavioral or compatibility change, an unused parameter)? → **approve and stop.** Do not assess whether it is correct. This veto outranks Ground A and Ground B: a comment on a protected subject stays even when you are confident it is wrong.\n\n**Step 2 — value veto.** Is the comment about style, formatting, naming, blank lines, the wording of a code comment, or readability, and is what it states true of this diff? → **approve and stop.** Its low value is not your concern.\n\n**Step 3 — Ground A.** Is the code it describes absent from its subject file's diff? → **remove it.**\n\n**Step 4 — Ground B.** Is there one diff line, in any file of the group, that literally contradicts its central claim, requiring no chain of reasoning to see? → **remove it.** Steps 3 and 4 are not optional: once a comment reaches them and qualifies, report it.\n\nBefore concluding a contradiction in Step 4, search every `<file>` for what the comment describes — not only the snippet it quoted. A comment that cites the wrong line while describing something the diffs do contain is correct, and stays.\n\n**Step 5 —** approve.\n\nReaching Step 4 and needing more than a single inferential step to reach the contradiction means there is none. Approve.\n\n### Code Diff\n\n<review_files>\n{{diff}}\n</review_files>\n\n### Review Comments\n\n{{comments}}\n\n### Output\n\nUpstream forces a choice between the tools report_incorrect_comments and approve_all_comments; this port has no tool-choice harness, so answer with exactly one JSON object and nothing else:\n\n- `{\"decision\":\"remove\",\"reason\":\"<the diff line that disproves the comment>\"}` — only for a comment meeting Ground A or Ground B, and only if you can name the diff line that disproves it.\n- `{\"decision\":\"approve\",\"reason\":\"<one line>\"}` — in every other case, including when the comment looks doubtful, unverifiable, or minor.";

/** One comment in upstream's filter payload shape. */
export interface OcrReflectionComment {
  /** Upstream ids are c-<index>; the verifier benchmark always sends exactly one comment. */
  id: string;
  path: string;
  content: string;
}

export interface OcrReflectionInput {
  /** The subject file's diff, upstream's <review_files> body. */
  diff: string;
  comment: OcrReflectionComment;
}

/** Upstream buildGroupFilterCommentsJSON: a JSON array of {id, path, content}. */
export function renderOcrComments(comments: OcrReflectionComment[]): string {
  return JSON.stringify(comments.map((comment) => ({ id: comment.id, path: comment.path, content: comment.content })));
}

/** Upstream buildConcatenatedDiffs: <file path="...">diff</file>. */
export function renderOcrReviewFiles(files: Array<{ path: string; diff: string }>): string {
  return files.map((file) => `<file path="${file.path}">\n${file.diff}\n</file>`).join("\n\n");
}

export function buildOcrReflectionPrompt(input: OcrReflectionInput): { system: string; user: string } {
  const user = OCR_REFLECTION_USER_TEMPLATE
    .split("{{diff}}").join(renderOcrReviewFiles([{ path: input.comment.path, diff: input.diff }]))
    .split("{{comments}}").join(renderOcrComments([input.comment]));
  return { system: OCR_REFLECTION_SYSTEM_PROMPT, user };
}

export type OcrDecision = "approve" | "remove" | "parse-error";

/** First balanced top-level JSON object in free text, string-escaping aware. */
export function extractFirstJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const REMOVE_WORDS = new Set(["remove", "removed", "reject", "rejected", "kill", "delete", "删除"]);
const APPROVE_WORDS = new Set(["approve", "approved", "keep", "kept", "retain", "保留"]);

function normalizeDecisionWord(value: unknown): OcrDecision | null {
  if (typeof value !== "string") return null;
  const word = value.trim().toLowerCase().replace(/[^a-z\u4e00-\u9fff]+/g, "");
  if (!word) return null;
  if (REMOVE_WORDS.has(word)) return "remove";
  if (APPROVE_WORDS.has(word)) return "approve";
  return null;
}

/**
 * A decision is a decision: JSON is preferred, but a plain one-word reply is
 * accepted rather than thrown away as a parse error — the port has no forced
 * tool choice, so the parser must be tolerant without guessing. A reply that
 * names both outcomes, or neither, is a parse-error and is reported as such;
 * scoring never counts an invalid row as a keep or a kill.
 */
export function parseOcrDecision(text: string | undefined): { decision: OcrDecision; reason: string } {
  const raw = (text ?? "").trim();
  if (!raw) return { decision: "parse-error", reason: "empty assistant response" };
  const json = extractFirstJsonObject(raw);
  if (json && typeof json === "object") {
    const record = json as Record<string, unknown>;
    const decision = normalizeDecisionWord(record.decision) ?? normalizeDecisionWord(record.verdict);
    if (decision) {
      return { decision, reason: typeof record.reason === "string" ? record.reason.trim().slice(0, 500) : "" };
    }
  }
  const stripped = raw.replace(/[\s\S]*?(?=\b(?:approve|approve_all_comments|remove|report_incorrect_comments)\b)/i, "");
  const candidates = new Set<OcrDecision>();
  for (const match of stripped.toLowerCase().matchAll(/\b(approve|remove)\b/g)) {
    candidates.add(match[1] === "remove" ? "remove" : "approve");
  }
  if (candidates.size === 1) {
    const decision = [...candidates][0]!;
    return { decision, reason: raw.slice(0, 300) };
  }
  return { decision: "parse-error", reason: raw.slice(0, 300) };
}
