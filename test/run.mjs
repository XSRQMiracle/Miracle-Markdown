// The test runner.
//
// There is no framework here. A test is a TypeScript program that asserts its
// way down the file and exits non-zero when an assertion fails, so running the
// suite is bundling each one and handing it to node. That is what this script
// does, and nothing else.
//
// It exists as a script rather than as the shell loop it replaces because that
// loop was POSIX — `for f in …; do …; done` — and `npm test` on Windows runs
// under cmd.exe, where it is a syntax error rather than a test failure. A
// contributor on the platform the editor claims to support could not run the
// tests at all.
//
// The list is written out rather than discovered by globbing. The same folder
// holds scratch files that are not tests, and the order is worth reading: the
// pure functions first, then the editor, then the engine, so the first failure
// is usually the most specific thing that broke rather than the most distant
// consequence of it.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TESTS = [
  // Document text, sessions, and the markdown layer.
  "document",
  "session",
  "parse",
  "edit",
  // The editor: selection, input, history, and the caret.
  "editor-transactions",
  "selection",
  "unicode-delete",
  "caret-collapse",
  "document-switch",
  "search",
  "scroll",
  "links",
  "keymap",
  "punctuation",
  "coalesce",
  "shortcut-sheet",
  // The chrome around it.
  "outline-cache",
  // The engine, which boots WebAssembly and is the slowest of them.
  "layout",
  "math-lifecycle",
  "math-parse",
  "math-transform",
  "math-svg",
  "math-refs",
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// A named subset, so that working on one test does not mean waiting for the
// engine to compile itself every time: `npm run test:ts -- math` runs the four
// maths files and nothing else.
const wanted = process.argv.slice(2);
const chosen = wanted.length
  ? TESTS.filter((name) => wanted.some((pattern) => name.includes(pattern)))
  : TESTS;

if (!chosen.length) {
  console.error(`no test matches ${wanted.join(", ")}`);
  process.exit(1);
}

/** Run a command, inheriting stdio, and return whether it succeeded. */
function run(command, args) {
  // `shell: true` on Windows, where npx and esbuild are .cmd shims that
  // CreateProcess will not start on their own.
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(result.error.message);
    return false;
  }
  return result.status === 0;
}

const failed = [];
for (const name of chosen) {
  const bundle = join(root, "node_modules", `.test-${name}.mjs`);
  const built = run("npx", [
    "esbuild",
    join("test", `${name}.test.ts`),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${bundle}`,
    "--log-level=error",
  ]);
  if (!built || !run(process.execPath, [bundle])) {
    failed.push(name);
    // Stop at the first failure, the way the shell loop's `|| exit 1` did: a
    // wall of consequent failures buries the one that has something to say.
    break;
  }
  console.log(`  ok  ${name}`);
}

if (failed.length) {
  console.error(`\nFAILED: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\n${chosen.length} test files passed`);
