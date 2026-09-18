// Collapsing a selection with an arrow key.
//
// The rule is the one every text field on every platform keeps: with something
// selected and no Shift, ← puts the caret at the near edge and → at the far
// edge, and neither moves a character beyond it. The modified moves are the
// exception that rule has to live with — ⌥→ deliberately starts from the far
// edge so it passes the word *after* the selection rather than the one already
// covered — so both are pinned down here together, over all four combinations
// of selection direction and key, because the two behaviours are decided by
// the same few lines and it was the confusion between them that broke this.
import assert from "node:assert/strict";
import { Editor } from "../src/editor/editor.js";

(globalThis as any).window = Object.assign(new EventTarget(), { setInterval: () => 0 });
(globalThis as any).ResizeObserver = class { observe() {} };

const platform = (value: string) =>
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: value } });

// Enough of the editor for the keydown handler to run: no layout, because
// nothing here asks where a caret lands on screen, only which offset it takes.
function keyboard(text: string) {
  const input = Object.assign(new EventTarget(), { value: "", focus() {}, blur() {} });
  const canvas = Object.assign(new EventTarget(), {
    clientWidth: 800,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  });
  const editor = Object.create(Editor.prototype) as any;
  Object.assign(editor, {
    text, selStart: 0, selEnd: 0, caretAffinity: "downstream", preferredX: null,
    composing: null, undoStack: [], redoStack: [], lastEditAt: -Infinity,
    input, canvas,
    host: { clientHeight: 600 }, docHeight: 0, typesetter: { theme: { bodySize: 18 } },
    blocks: [{ block: { start: 0, end: text.length, task: "none" }, lines: [] }],
    invalidate() {}, scrollCaretIntoView() {},
    positionAt: (x: number) => ({ offset: x, affinity: "downstream" }),
  });
  editor.attach();
  return {
    editor,
    select(start: number, end: number) { editor.selStart = start; editor.selEnd = end; },
    // The result is reported as [anchor, caret] rather than a sorted pair:
    // which end the caret sits on is half of what these cases are about.
    key(name: string, mods: Record<string, boolean> = {}): [number, number] {
      input.dispatchEvent(Object.assign(new Event("keydown"),
        { key: name, preventDefault() {}, ...mods }));
      return [editor.selStart, editor.selEnd];
    },
  };
}

// --- collapsing -----------------------------------------------------------
{
  platform("Win32");
  const k = keyboard("abcde");

  k.select(1, 3);
  assert.deepEqual(k.key("ArrowRight"), [3, 3],
    "→ out of a forward selection collapses onto its far edge and goes no further");
  k.select(1, 3);
  assert.deepEqual(k.key("ArrowLeft"), [1, 1],
    "← out of a forward selection collapses onto its near edge");
  k.select(3, 1);
  assert.deepEqual(k.key("ArrowLeft"), [1, 1],
    "← out of a backward selection takes the smaller offset, not the one before it");
  k.select(3, 1);
  assert.deepEqual(k.key("ArrowRight"), [3, 3],
    "→ out of a backward selection takes the larger offset");
}

// --- extending and plain steps --------------------------------------------
{
  platform("Win32");
  const k = keyboard("abcde");

  k.select(1, 3);
  assert.deepEqual(k.key("ArrowRight", { shiftKey: true }), [1, 4],
    "⇧→ over a selection still pushes the caret end one character on");
  k.select(1, 3);
  assert.deepEqual(k.key("ArrowLeft", { shiftKey: true }), [1, 2],
    "⇧← still draws it one back");
  k.select(3, 1);
  assert.deepEqual(k.key("ArrowLeft", { shiftKey: true }), [3, 0],
    "and extends from whichever end the caret is on, leaving the anchor put");

  k.select(2, 2);
  assert.deepEqual(k.key("ArrowRight"), [3, 3], "with nothing selected → moves one character");
  k.select(2, 2);
  assert.deepEqual(k.key("ArrowLeft"), [1, 1], "and ← one character back");
  k.select(0, 0);
  assert.deepEqual(k.key("ArrowLeft"), [0, 0], "the start of the document is a stop");
  k.select(5, 5);
  assert.deepEqual(k.key("ArrowRight"), [5, 5], "and so is the end");
}

// --- the word moves, which start from the other edge on purpose -----------
{
  platform("MacIntel");
  const k = keyboard("the quick brown fox");

  k.select(4, 9);
  assert.deepEqual(k.key("ArrowRight", { altKey: true }), [15, 15],
    "⌥→ out of a selection passes the word after it, not the one it already covers");
  k.select(9, 4);
  assert.deepEqual(k.key("ArrowLeft", { altKey: true }), [0, 0],
    "and ⌥← the word before it, whichever end the caret was on");
  k.select(4, 9);
  assert.deepEqual(k.key("ArrowRight", { altKey: true, shiftKey: true }), [4, 15],
    "⇧⌥→ extends from the caret instead, so the anchor stays where it was");
}

// --- which visual line the collapsed caret belongs to ---------------------
{
  platform("Win32");
  const k = keyboard("abcde");

  k.select(1, 3);
  k.key("ArrowRight");
  assert.equal(k.editor.caretAffinity, "upstream",
    "collapsing rightwards leaves the caret on the line the selection ended on, " +
    "not at the head of the next one when that offset is a soft wrap");
  k.select(3, 1);
  k.key("ArrowLeft");
  assert.equal(k.editor.caretAffinity, "downstream",
    "and collapsing leftwards on the line it began on");
}

console.log("all passing");
