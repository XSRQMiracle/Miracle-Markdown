// Following a link.
//
// A plain click has to keep placing the caret — the source under it stays
// editable — so a link is followed with the platform's modifier, the same one
// that opens a link in a new tab elsewhere. Where it opens is the host's
// business, and a destination the document supplies is not to be trusted.
import assert from "node:assert/strict";
import { Editor } from "../src/editor/editor.js";
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
assert.equal(await openExternal("https://example.com"), true);
assert.equal(await openExternal("http://example.com"), true);
assert.equal(await openExternal("mailto:a@b.c"), true);
assert.deepEqual(opened, ["https://example.com", "http://example.com", "mailto:a@b.c"]);
for (const refused of [
  "javascript:alert(1)",
  " javascript:alert(1)",
  "JavaScript:alert(1)",
  "file:///etc/passwd",
  "vscode://x",
  "./relative.md",
  "#anchor",
  "",
]) {
  assert.equal(await openExternal(refused), false, `${JSON.stringify(refused)} is declined`);
}
assert.equal(opened.length, 3, "and nothing else was opened");

console.log("all passing");
