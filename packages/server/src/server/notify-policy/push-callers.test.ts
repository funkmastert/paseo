import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Every place the daemon sends a push must declare a notify level. An undeclared push still works
 * (it becomes a notice), but the call that forgot is the next source of noise nobody ranked, so
 * this fails and names it. A new sender fixes it by adding `{ level: ... }` to the call.
 */
const SERVER_ROOT = path.resolve(import.meta.dirname, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      return entry === "node_modules" || entry === "test-utils" ? [] : sourceFiles(full);
    }
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

/** The text of a call's arguments, from the opening paren to its match. */
function callArguments(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParen, i + 1);
    }
  }
  return source.slice(openParen);
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function undeclaredSends(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const relative = path.relative(SERVER_ROOT, file);
  const found: string[] = [];
  // Direct sends on a PushNotificationSender, and the private `sendPush` wrappers monitors keep.
  // A wrapper forwards the `meta` its own callers must pass, so it is checked at those callers.
  const patterns = [
    { pattern: /\b(?:pushNotificationSender|sender)\s*\.send\(/g, declared: /\b(?:level|meta)\b/ },
    { pattern: /\bthis\.sendPush\(/g, declared: /\blevel\b/ },
  ];
  for (const { pattern, declared } of patterns) {
    for (const match of source.matchAll(pattern)) {
      const openParen = match.index + match[0].length - 1;
      if (!declared.test(callArguments(source, openParen))) {
        found.push(`${relative}:${lineOf(source, match.index)}`);
      }
    }
  }
  return found;
}

describe("push callers", () => {
  test("every push sender declares a level", () => {
    const callers = sourceFiles(SERVER_ROOT).filter((file) => {
      const source = readFileSync(file, "utf8");
      return /PushNotificationSender|PushSendMeta/.test(source);
    });
    expect(callers.length).toBeGreaterThan(8);
    expect(callers.flatMap(undeclaredSends)).toEqual([]);
  });
});
