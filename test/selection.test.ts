// Word and block selection.
//
// The interesting half is 中文: a double-click has to find a boundary that no
// pattern over code points can see, which is why this goes through
// Intl.Segmenter. The rest pins down the gesture — what one, two and three
// clicks select, and that dragging afterwards keeps that granularity.
import assert from "node:assert/strict";
import { Editor } from "../src/editor/editor.js";
import { wordAt, wordBoundary } from "../src/editor/words.js";

(globalThis as any).window = Object.assign(new EventTarget(), { setInterval: () => 0 });
(globalThis as any).ResizeObserver = class { observe() {} };

// --- word boundaries ------------------------------------------------------
const span = (text: string, at: number) => {
  const { start, end } = wordAt(text, at);
  return text.slice(start, end);
};
const latin = "the quick brown fox";
assert.equal(span(latin, 5), "quick", "a click inside a word takes the word");
assert.equal(span(latin, 4), "quick", "and one on its first character");
assert.equal(span(latin, 9), "quick", "a caret on the far boundary keeps the word behind it");
assert.equal(span(latin, 10), "brown", "the boundary belongs to the word that ends there, not the space");
assert.equal(span(latin, 19), "fox", "the end of the document selects the last word");
assert.equal(span("", 0), "", "an empty document has nothing to select");
assert.deepEqual(wordAt("hello", 99), { start: 0, end: 5 }, "an offset past the end is clamped");

assert.equal(span("中文排版很好", 3), "排版",
  "Han is segmented into words, not taken as one undifferentiated run");
assert.equal(span("中文排版很好", 0), "中文", "the first word of a Han run");
assert.equal(span("说hello好", 3), "hello", "a Latin word embedded in Han");
assert.equal(span("a, b", 1), "a", "punctuation after a word does not join it");
assert.equal(span("f(x)", 2), "x", "nor brackets around one");
assert.equal(span("snake_case2", 3), "snake_case2",
  "an identifier is one word, digits and underscore included");

const stop = (text: string, at: number, dir: -1 | 1) => wordBoundary(text, at, dir);
assert.equal(stop(latin, 0, 1), 3, "moving right lands after the word ahead");
assert.equal(stop(latin, 3, 1), 9, "and then after the next");
assert.equal(stop(latin, 19, 1), 19, "the end of the document is a stop");
assert.equal(stop(latin, 5, -1), 4, "moving left lands on the start of the word around the caret");
assert.equal(stop(latin, 4, -1), 0, "and then on the one before it");
assert.equal(stop(latin, 0, -1), 0, "the start of the document is a stop");
assert.equal(stop("中文排版", 2, 1), 4, "Han moves by word too");
assert.equal(stop("中文排版", 2, -1), 0);
assert.equal(stop("word   \n\n", 4, 1), 9, "trailing whitespace is crossed to the end");

// --- the click gesture ----------------------------------------------------
// positionAt is stubbed so a click's clientX *is* the source offset: this
// exercises the gesture, not the hit testing, which layout.test.ts covers.
function gestures(text: string, ranges: Array<[number, number]>) {
  const input = Object.assign(new EventTarget(), { value: "", focus() {}, blur() {} });
  const canvas = new EventTarget();
  const editor = Object.create(Editor.prototype) as any;
  Object.assign(editor, {
    text, selStart: 0, selEnd: 0, caretAffinity: "downstream", preferredX: null,
    composing: null, undoStack: [], redoStack: [], lastEditAt: -Infinity,
    input, canvas, host: {},
    blocks: ranges.map(([start, end]) => ({ block: { start, end } })),
    invalidate() {}, scrollCaretIntoView() {},
    positionAt: (x: number) => ({ offset: x, affinity: "downstream" }),
  });
  editor.attach();
  const at = (type: string, target: EventTarget, offset: number, props = {}) =>
    target.dispatchEvent(Object.assign(new Event(type), { clientX: offset, clientY: 0, ...props }));
  return {
    editor,
    click: (offset: number, detail: number, shiftKey = false) =>
      at("mousedown", canvas, offset, { detail, shiftKey }),
    drag: (offset: number) => at("mousemove", (globalThis as any).window, offset),
    release: () => (globalThis as any).window.dispatchEvent(new Event("mouseup")),
    selection: () => [Math.min(editor.selStart, editor.selEnd), Math.max(editor.selStart, editor.selEnd)],
  };
}

{
  const g = gestures(latin, [[0, latin.length]]);
  g.click(5, 1);
  assert.deepEqual(g.selection(), [5, 5], "a single click places the caret");
  g.click(5, 2);
  assert.deepEqual(g.selection(), [4, 9], "a double click selects the word");
  g.click(5, 3);
  assert.deepEqual(g.selection(), [0, 19], "a triple click selects the block");
  g.click(12, 4);
  assert.deepEqual(g.selection(), [0, 19], "a fourth click does not widen further");
  g.release();
}
{
  // Dragging after a double click keeps whole words on both ends.
  const g = gestures(latin, [[0, latin.length]]);
  g.click(5, 2);
  g.drag(12);
  assert.deepEqual(g.selection(), [4, 15], "dragging forward extends by whole words");
  g.drag(6);
  assert.deepEqual(g.selection(), [4, 9], "and shrinks back to the word it started on");
  g.drag(1);
  assert.deepEqual(g.selection(), [0, 9], "dragging past the start covers the word behind it");
  assert.equal(g.editor.selEnd, 0, "the caret is at the end the pointer is on");
  g.release();
  g.drag(18);
  assert.deepEqual(g.selection(), [0, 9], "releasing ends the gesture");
}
{
  const text = "para one\n\npara two";
  const g = gestures(text, [[0, 9], [10, text.length]]);
  g.click(3, 3);
  assert.deepEqual(g.selection(), [0, 8], "a block selection stops before its trailing blank line");
  g.drag(12);
  assert.deepEqual(g.selection(), [0, 18], "dragging extends a block at a time");
  g.release();
}
{
  const g = gestures(latin, [[0, latin.length]]);
  g.click(4, 1);
  g.click(9, 1, true);
  assert.deepEqual(g.selection(), [4, 9], "shift-clicking still extends by character");
  g.drag(11);
  assert.deepEqual(g.selection(), [4, 11], "and dragging with it does not snap to words");
  g.release();
}

console.log("all passing");
