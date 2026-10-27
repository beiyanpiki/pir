import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { USER_BACKGROUND_CLOSE, USER_BACKGROUND_OPEN, USER_BACKGROUND_TAG } from "../agents/prompts.js";

/**
 * ADR 0016 Part I: explicit user background for `find` — the user's stated goal
 * for the change, injected as untrusted context into the reviewer prompt only.
 *
 * The text is user-supplied and reaches a model, so it carries three bounds:
 * a 1 MiB raw cap on a `--background-file` read (refuse absurd input before
 * loading it), an 8,000-character hard cap on the text that reaches the prompt
 * (truncated loudly, never silently), and a 2,000-character soft cap that only
 * warns — the stated goal is the useful part, not the whole PR description.
 *
 * The reserved delimiters belong to the renderer (`src/agents/prompts.ts`), so
 * user text can never forge the section boundary.
 */
export const USER_BACKGROUND_HARD_LIMIT = 8000;
export const USER_BACKGROUND_SOFT_LIMIT = 2000;
export const USER_BACKGROUND_MAX_FILE_BYTES = 1024 * 1024;

/** A user-input error: the CLI maps it to a usage error (exit 2), never a run. */
export class UserBackgroundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserBackgroundError";
  }
}

/** Provenance-safe view of the background: the text is never persisted. */
export interface UserBackgroundRecord {
  source: "flag" | "file";
  /** Canonical sha256 of the sanitised text (before the hard cap). */
  sha256: string;
  /** Characters that reached the prompt. */
  characters: number;
  /** Characters after sanitisation, before the hard cap. */
  suppliedCharacters: number;
  truncated: boolean;
}

export interface UserBackground extends UserBackgroundRecord {
  /** Sanitised, hard-capped text. Never logged or written to run.json. */
  text: string;
}

export interface UserBackgroundInput {
  /** `--background <text>`; undefined when the flag is absent. */
  text?: string;
  /** `--background-file <path>`; undefined when the flag is absent. */
  file?: string;
  /** Directory a relative file path resolves against (the invocation cwd). */
  cwd: string;
  /** Warning sink; the CLI routes these to stderr. */
  warn?: (message: string) => void;
}

/**
 * C0/C1 controls except newline and tab, plus the invisible formatting
 * characters (zero-width, bidi overrides, BOM) that have no place in prose and
 * are a standard way to smuggle text past a human reader.
 */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/**
 * Any opening or closing user-background tag — attributes included — because
 * the model reads the delimiters, not the exact spelling the renderer emits.
 */
const RESERVED_DELIMITER = new RegExp("</?" + USER_BACKGROUND_TAG + "(?=[\\s>/]|$)", "i");

/**
 * Canonical form of the text that reaches the prompt: LF line endings, no
 * invisible characters, no trailing whitespace, at most one blank line between
 * blocks, no leading/trailing blank space. Two raw inputs that differ only in
 * that incidental formatting therefore share one hash.
 */
export function sanitizeUserBackground(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Resolve `--background` / `--background-file` into the prompt-ready record.
 * Returns undefined when neither flag is present (the default: no background,
 * byte-identical prompts). `--background-file` wins when both are given, with a
 * warning naming the ignored inline text.
 */
export function resolveUserBackground(input: UserBackgroundInput): UserBackground | undefined {
  const textGiven = input.text !== undefined;
  const fileGiven = input.file !== undefined;
  if (!textGiven && !fileGiven) return undefined;
  if (textGiven && input.text!.trim() === "") throw new UserBackgroundError("--background requires non-empty text");
  if (fileGiven && input.file!.trim() === "") throw new UserBackgroundError("--background-file requires a path");

  let source: "flag" | "file" = "flag";
  let raw: string;
  if (fileGiven) {
    if (textGiven) input.warn?.("both --background and --background-file were given; using --background-file (the inline text is ignored)");
    source = "file";
    raw = readBackgroundFile(input.file!, input.cwd);
  } else {
    raw = input.text!;
  }

  const sanitized = sanitizeUserBackground(raw);
  if (sanitized === "") {
    throw new UserBackgroundError("background is empty after removing control characters and blank lines");
  }
  if (RESERVED_DELIMITER.test(sanitized)) {
    throw new UserBackgroundError("background must not contain the reserved " + USER_BACKGROUND_OPEN + " or " + USER_BACKGROUND_CLOSE + " delimiters");
  }
  if (sanitized.length > USER_BACKGROUND_SOFT_LIMIT) {
    input.warn?.("user background is " + sanitized.length + " characters (soft limit " + USER_BACKGROUND_SOFT_LIMIT + "); state the goal and intentional behaviour changes, not the whole description");
  }
  const truncated = sanitized.length > USER_BACKGROUND_HARD_LIMIT;
  if (truncated) {
    input.warn?.("user background truncated at " + USER_BACKGROUND_HARD_LIMIT + " characters (" + sanitized.length + " supplied)");
  }
  const text = truncated ? sanitized.slice(0, USER_BACKGROUND_HARD_LIMIT) : sanitized;
  return {
    source,
    text,
    sha256: createHash("sha256").update(sanitized).digest("hex"),
    characters: text.length,
    suppliedCharacters: sanitized.length,
    truncated,
  };
}

/** What bookkeeping surfaces show instead of the text (ADR 0016 Part I). */
export const USER_BACKGROUND_REDACTED = "<background redacted>";

/**
 * ADR 0016 Part I (dogfood F-2): the background reaches the model, but it must not
 * reach any bookkeeping surface. Server error logs, the job registry and local
 * receipts echo argv, so they pass it through here first: the flag stays
 * visible (an operator can see it was used) and its value never does.
 */
export function redactUserBackgroundArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--background") {
      out.push(token, USER_BACKGROUND_REDACTED);
      i += 1; // skip the value, whatever it is
      continue;
    }
    if (token.startsWith("--background=")) {
      out.push("--background=" + USER_BACKGROUND_REDACTED);
      continue;
    }
    out.push(token);
  }
  return out;
}

/** The persisted projection: hash and sizes only, never the text (ADR 0016 Part I). */
export function userBackgroundRecord(background: UserBackground): UserBackgroundRecord {
  return {
    source: background.source,
    sha256: background.sha256,
    characters: background.characters,
    suppliedCharacters: background.suppliedCharacters,
    truncated: background.truncated,
  };
}

function readBackgroundFile(file: string, cwd: string): string {
  const resolved = path.resolve(cwd, file);
  let size: number;
  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) throw new UserBackgroundError("background file is not a regular file: " + file);
    size = stat.size;
  } catch (error) {
    if (error instanceof UserBackgroundError) throw error;
    throw new UserBackgroundError("background file not found: " + file);
  }
  if (size > USER_BACKGROUND_MAX_FILE_BYTES) {
    throw new UserBackgroundError("background file is " + size + " bytes; the raw cap is " + USER_BACKGROUND_MAX_FILE_BYTES + " bytes (1 MiB)");
  }
  try {
    return readFileSync(resolved, "utf8");
  } catch (error) {
    throw new UserBackgroundError("background file could not be read: " + file + " (" + (error instanceof Error ? error.message : String(error)) + ")");
  }
}
