// Following a link.
//
// A plain click has to keep placing the caret — the source under it stays
// editable — so a link is followed with the platform's modifier, the same one
// that opens a link in a new tab elsewhere. Where it opens is the host's
// business, and a destination the document supplies is not to be trusted.
import assert from "node:assert/strict";
import { Editor } from "../src/editor/editor.js";
import capability from "../src-tauri/capabilities/default.json";
import { openExternal } from "../src/platform.js";

const opened: string[] = [];
(globalThis as any).window = Object.assign(new EventTarget(), {
  setInterval: () => 0,
  open: (url: string) => { opened.push(url); },
});
(globalThis as any).ResizeObserver = class { observe() {} };

const LINK = "https://example.com/x";
function clicking() {
  const input = Object.assign(new EventTarget(), { value: "", focus() {}, blur() {} });
  const canvas = Object.assign(new EventTarget(), { style: {}, clientWidth: 800 });
  const editor = Object.create(Editor.prototype) as any;
  const followed: string[] = [];
  Object.assign(editor, {
    text: "see the site here", selStart: 0, selEnd: 0, caretAffinity: "downstream",
    preferredX: null, composing: null, undoStack: [], redoStack: [], lastEditAt: -Infinity,
    input, canvas, host: { clientHeight: 600 }, docHeight: 0, blocks: [], scrollTop: 0,
    typesetter: { theme: { bodySize: 18 } },
    invalidate() {}, scrollCaretIntoView() {}, schedule() {},
    positionAt: (x: number) => ({ offset: x, affinity: "downstream" }),
    // Standing in for the hit test, which layout.test.ts covers against a
    // real layout: everything from x=4 to x=12 is a link.
    linkAt: (x: number) => (x >= 4 && x <= 12 ? LINK : null),
    onFollowLink: (href: string) => followed.push(href),
  });
  editor.attach();
  return {
    editor,
    followed,
    click: (x: number, mods: Record<string, boolean> = {}) =>
      canvas.dispatchEvent(Object.assign(new Event("mousedown"), {
        clientX: x, clientY: 0, offsetX: x, detail: 1, ...mods,
      })),
    move: (x: number, mods: Record<string, boolean> = {}) =>
      canvas.dispatchEvent(Object.assign(new Event("mousemove"), {
        clientX: x, clientY: 0, offsetX: x, ...mods,
      })),
    cursor: () => canvas.style.cursor,
  };
}

{
  const c = clicking();
  c.click(6);
  assert.deepEqual([c.followed.length, c.editor.selEnd], [0, 6],
    "a plain click on a link places the caret, as anywhere else");
  c.click(6, { metaKey: true });
  assert.deepEqual([c.followed, c.editor.selEnd], [[LINK], 6],
    "with the modifier it is followed instead, and the caret stays put");
  c.click(6, { ctrlKey: true });
  assert.deepEqual(c.followed, [LINK, LINK], "Ctrl does the same off a Mac");
  c.click(15, { metaKey: true });
  assert.deepEqual([c.followed.length, c.editor.selEnd], [2, 15],
    "a modified click on ordinary text still places the caret");
}
{
  const c = clicking();
  c.move(6);
  assert.equal(c.cursor(), "", "hovering a link changes nothing on its own");
  c.move(6, { metaKey: true });
  assert.equal(c.cursor(), "pointer", "but with the modifier down it says the click will follow");
  c.move(20, { metaKey: true });
  assert.equal(c.cursor(), "", "and stops saying so past the link");
}

// --- what may be opened ---------------------------------------------------
//
// Two gates stand between a document and the system browser: this guard, and
// the `opener:allow-open-url` scope in src-tauri/capabilities/default.json,
// which is the one that still holds if the webview is ever subverted. They
// have to admit exactly the same set, so every case below is put through both
// rather than each side being pinned separately and trusted to keep in step.
// An empty allow list is not "no restriction" — the plugin reads it as a
// whitelist, so before it was written out every external link was dead.

const allowEntries = (capability.permissions as unknown[])
  .filter((p): p is { identifier: string; allow?: { url: string }[] } =>
    typeof p === "object" && p !== null &&
    (p as { identifier?: unknown }).identifier === "opener:allow-open-url")
  .flatMap((p) => p.allow ?? []);

assert.ok(allowEntries.length > 0,
  "opener:allow-open-url carries a url scope, since the plugin reads an empty allow list " +
  "as allowing nothing at all");

// Each pattern is a literal prefix closed by one trailing wildcard, and the
// glob the plugin matches with lets that wildcard run over slashes too.
// Holding the patterns to that shape is what lets a plain prefix test stand in
// for the real matcher without a glob implementation in the test.
const prefixes = allowEntries.map(({ url }) => {
  assert.match(url, /^[a-z]+:[^*?[\]]*\*$/,
    `the scope pattern ${JSON.stringify(url)} is a literal prefix and one trailing wildcard`);
  return url.slice(0, -1);
});
assert.deepEqual([...prefixes].sort(), ["http://", "https://", "mailto:"],
  "the capability allows exactly the schemes the product supports, and nothing else");
const inScope = (url: string) => prefixes.some((p) => url.startsWith(p));

const cases: [string, boolean][] = [
  ["https://example.com", true],
  ["http://example.com", true],
  ["mailto:a@b.c", true],
  ["https://example.com/a/b?q=1#f", true],
  ["  https://example.com/a  ", true],
  // A scheme is case-insensitive in the URL grammar, so `<HTTPS://EXAMPLE.COM>`
  // is an ordinary autolink and arrives with the author's capitals intact.
  ["HTTPS://Example.com/Path", true],
  ["MailTo:A@b.c", true],
  ["javascript:alert(1)", false],
  [" javascript:alert(1)", false],
  ["JavaScript:alert(1)", false],
  // Splitting the scheme defeats a filter looking for the word rather than for
  // the shape. An allow list never sees the word, so it does not care.
  ["java\nscript:alert(1)", false],
  ["java\tscript:alert(1)", false],
  // `trim` stops at whitespace, so a control character is still standing in
  // front of the scheme by the time the test runs.
  ["\u0001javascript:alert(1)", false],
  ["file:///etc/passwd", false],
  ["data:text/html,<script>1</script>", false],
  ["vbscript:msgbox(1)", false],
  // In the opener plugin's own default scope, but not in this product's.
  ["tel:+1", false],
  ["vscode://x", false],
  // No scheme at all: the webview would resolve this against its own origin.
  ["//evil.com", false],
  // Legal in the grammar, names nothing the shell could open, and matches no
  // pattern in the capability.
  ["https:evil.com", false],
  ["./relative.md", false],
  ["#anchor", false],
  ["", false],
];
for (const [url, admitted] of cases) {
  assert.equal(await openExternal(url), admitted,
    `${JSON.stringify(url)} is ${admitted ? "followed" : "declined"}`);
  if (!admitted) continue;
  const handed = opened[opened.length - 1] as string;
  assert.ok(inScope(handed),
    `${JSON.stringify(url)} reaches the host as ${JSON.stringify(handed)}, which the capability ` +
    "admits as well, so the frontend never hands over a url the shell will refuse");
}
assert.equal(opened.length, cases.filter(([, ok]) => ok).length,
  "and nothing that was declined was opened anyway");
assert.ok(opened.includes("https://Example.com/Path") && opened.includes("mailto:A@b.c"),
  "only the scheme is lowered on the way out, because a path or a mailbox can be case significant");

console.log("all passing");
