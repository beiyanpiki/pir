import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  USER_BACKGROUND_HARD_LIMIT,
  USER_BACKGROUND_MAX_FILE_BYTES,
  USER_BACKGROUND_REDACTED,
  USER_BACKGROUND_SOFT_LIMIT,
  UserBackgroundError,
  redactUserBackgroundArgv,
  resolveUserBackground,
  sanitizeUserBackground,
  userBackgroundRecord,
} from "../../dist/core/user-background.js";

/**
 * S2 (ADR-0016) T3: every guard on the explicit user background — precedence,
 * the three caps, sanitisation, delimiter rejection, hash stability — plus the
 * no-background path that must resolve to nothing at all.
 */

function withTempDir(run) {
  const dir = mkdtempSync(path.join(tmpdir(), "pir-background-"));
  try { return run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("sanitisation canonicalises line endings, whitespace and invisible characters", () => {
  const raw = "  Title\r\n\r\n\r\n\r\nBody with trailing spaces   \r\n\u0007bell\u202Eoverride\u200Bzero\r\n";
  assert.equal(sanitizeUserBackground(raw), "Title\n\nBody with trailing spaces\nbelloverridezero");
  // Tabs survive; they are content, not a smuggling channel.
  assert.equal(sanitizeUserBackground("a\tb"), "a\tb");
  // Whitespace-only input canonicalises to nothing, which the resolver rejects.
  assert.equal(sanitizeUserBackground(" \r\n\t\u0000 "), "");
});

test("no flags resolves to no background (the default path)", () => {
  assert.equal(resolveUserBackground({ cwd: process.cwd() }), undefined);
});

test("inline text resolves to a hashed, prompt-ready record", () => {
  const resolved = resolveUserBackground({ cwd: process.cwd(), text: "Adds retention. The 30-day cap is intentional." });
  assert.equal(resolved.source, "flag");
  assert.equal(resolved.text, "Adds retention. The 30-day cap is intentional.");
  assert.equal(resolved.characters, resolved.text.length);
  assert.equal(resolved.suppliedCharacters, resolved.text.length);
  assert.equal(resolved.truncated, false);
  assert.match(resolved.sha256, /^[0-9a-f]{64}$/);
  // The persisted projection never carries the text.
  const record = userBackgroundRecord(resolved);
  assert.deepEqual(Object.keys(record).sort(), ["characters", "sha256", "source", "suppliedCharacters", "truncated"]);
  assert.equal("text" in record, false);
});

test("the hash is canonical: incidental formatting does not change it", () => {
  const lf = resolveUserBackground({ cwd: process.cwd(), text: "Goal: migrate the index.\n\nDetail." });
  const crlf = resolveUserBackground({ cwd: process.cwd(), text: "Goal: migrate the index.\r\n\r\n\r\nDetail.\r\n" });
  const trailing = resolveUserBackground({ cwd: process.cwd(), text: "Goal: migrate the index.  \n\nDetail.\t" });
  assert.equal(lf.sha256, crlf.sha256);
  assert.equal(lf.sha256, trailing.sha256);
  const other = resolveUserBackground({ cwd: process.cwd(), text: "Goal: migrate the cache." });
  assert.notEqual(lf.sha256, other.sha256);
});

test("empty, blank and delimiter-bearing text is rejected", () => {
  assert.throws(() => resolveUserBackground({ cwd: process.cwd(), text: "" }), UserBackgroundError);
  assert.throws(() => resolveUserBackground({ cwd: process.cwd(), text: " \r\n\u0000\t " }), /empty after removing control characters/);
  assert.throws(() => resolveUserBackground({ cwd: process.cwd(), text: "before <user_background> after" }), /reserved/);
  // Case-insensitive: the renderer lowercases nothing, the model may still read it as a tag.
  assert.throws(() => resolveUserBackground({ cwd: process.cwd(), text: "before </USER_BACKGROUND> after" }), /reserved/);
  assert.throws(() => resolveUserBackground({ cwd: process.cwd(), text: "kept <USER_BACKGROUND class=x>" }), /reserved/);
});

test("the soft cap warns without truncating; the hard cap truncates loudly", () => {
  const warnings = [];
  const soft = resolveUserBackground({ cwd: process.cwd(), text: "x".repeat(USER_BACKGROUND_SOFT_LIMIT), warn: (m) => warnings.push(m) });
  assert.deepEqual(warnings, []);
  const over = resolveUserBackground({ cwd: process.cwd(), text: "y".repeat(USER_BACKGROUND_SOFT_LIMIT + 1), warn: (m) => warnings.push(m) });
  assert.equal(over.truncated, false);
  assert.equal(over.characters, USER_BACKGROUND_SOFT_LIMIT + 1);
  assert.match(warnings[0], /soft limit 2000/);

  warnings.length = 0;
  const huge = "z".repeat(USER_BACKGROUND_HARD_LIMIT + 500);
  const hard = resolveUserBackground({ cwd: process.cwd(), text: huge, warn: (m) => warnings.push(m) });
  assert.equal(hard.truncated, true);
  assert.equal(hard.characters, USER_BACKGROUND_HARD_LIMIT);
  assert.equal(hard.suppliedCharacters, huge.length);
  assert.equal(hard.text.length, USER_BACKGROUND_HARD_LIMIT);
  // The hash covers the supplied text, not the truncated prompt copy.
  assert.notEqual(hard.sha256, resolveUserBackground({ cwd: process.cwd(), text: huge.slice(0, USER_BACKGROUND_HARD_LIMIT) }).sha256);
  assert.ok(warnings.some((m) => /truncated at 8000/.test(m)));
});

test("a file supplies the background, wins over inline text, and resolves relative to cwd", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "background.md"), "Goal: add SSO.\r\n\r\nThe legacy path stays.\r\n");
    const warnings = [];
    const resolved = resolveUserBackground({ cwd: dir, file: "background.md", text: "ignored", warn: (m) => warnings.push(m) });
    assert.equal(resolved.source, "file");
    assert.equal(resolved.text, "Goal: add SSO.\n\nThe legacy path stays.");
    assert.match(warnings[0], /using --background-file/);
  });
});

test("bookkeeping surfaces keep the flag and redact the text (dogfood F-2)", () => {
  assert.deepEqual(
    redactUserBackgroundArgv(["find", "--background", "secret goal", "--json"]),
    ["find", "--background", USER_BACKGROUND_REDACTED, "--json"],
  );
  assert.deepEqual(
    redactUserBackgroundArgv(["find", "--background=secret goal"]),
    ["find", "--background=" + USER_BACKGROUND_REDACTED],
  );
  // A dangling flag is still redacted rather than passed through.
  assert.deepEqual(redactUserBackgroundArgv(["find", "--background"]), ["find", "--background", USER_BACKGROUND_REDACTED]);
  // Everything else is untouched — including the file flag, whose value is a
  // path, and the text of other flags.
  assert.deepEqual(redactUserBackgroundArgv(["audit", "--json"]), ["audit", "--json"]);
  assert.deepEqual(redactUserBackgroundArgv(["--background-file", "x.md"]), ["--background-file", "x.md"]);
});

test("file guards: missing, directory, oversized, and empty values", () => {
  withTempDir((dir) => {
    mkdirSync(path.join(dir, "subdir"));
    assert.throws(() => resolveUserBackground({ cwd: dir, file: "missing.md" }), /not found/);
    assert.throws(() => resolveUserBackground({ cwd: dir, file: "subdir" }), /not a regular file/);
    writeFileSync(path.join(dir, "big.md"), "a".repeat(USER_BACKGROUND_MAX_FILE_BYTES + 1));
    assert.throws(() => resolveUserBackground({ cwd: dir, file: "big.md" }), /raw cap/);
    assert.throws(() => resolveUserBackground({ cwd: dir, file: "   " }), /requires a path/);
    writeFileSync(path.join(dir, "empty.md"), "  \r\n\u0000 ");
    assert.throws(() => resolveUserBackground({ cwd: dir, file: "empty.md" }), /empty after removing/);
  });
});
