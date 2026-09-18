// Opening a document.
//
// Replacing the text is a change of subject, not an edit: the caret, the
// selection, the history and the page itself all belong to the document that
// has just arrived. The scroll offset is the piece that used to survive,
// because the only thing that ever pulled it back was the clamp at the end of
// a layout — and a second document just as long as the first offers nothing to
// clamp against, so the reader was left looking at the middle of a page whose
// caret sat at the top.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initSync } from "../crates/typeset-wasm/pkg/typeset_wasm.js";
import { DEFAULT_OPTIONS, DEFAULT_THEME, initEngine, Typesetter } from "../src/engine/typeset.js";
import { DEFAULT_EDITING_OPTIONS, Editor } from "../src/editor/editor.js";

// The assertions are about where the page sits, so the metrics only have to be
// stable, not real.
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    createElement: () => ({
      getContext: () => ({
        font: "",
        measureText(text: string) {
          const code = this.font.includes("monospace");
          const bold = this.font.startsWith("700 ");
          const width = Array.from(text).reduce((sum, c) => sum +
            (c === " " ? (code ? 9 : 4) : (bold ? 12 : 10)), 0);
          return { width, fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 4 };
        },
      }),
    }),
  },
});

initSync({ module: readFileSync("crates/typeset-wasm/pkg/typeset_wasm_bg.wasm") });
await initEngine();
const typesetter = new Typesetter({ ...DEFAULT_THEME }, {
  ...DEFAULT_OPTIONS, inline: { ...DEFAULT_OPTIONS.inline },
});
await typesetter.ready;

const VIEWPORT = 600;
const WIDTH = 800;

/** A document far taller than the window, so that it has somewhere to scroll. */
const long = (tag: string) => Array.from({ length: 120 }, (_, i) =>
  `${tag} paragraph ${i}, long enough to wrap the column more than once over.`).join("\n\n");

/**
 * An editor showing `source`, already laid out and already being edited.
 *
 * `interacted` starts true because the case under test is a reader who has
 * been working in one document and opens another; the newly opened document
 * must not inherit that.
 */
function editing(source: string) {
  const input = Object.assign(new EventTarget(), { value: "", focus() {}, blur() {}, style: {} });
  const editor = Object.create(Editor.prototype) as any;
  Object.assign(editor, {
    typesetter, text: source, selStart: 0, selEnd: 0,
    caretAffinity: "downstream", preferredX: null, hasFocus: true, interacted: true,
    composing: null, undoStack: [], redoStack: [], lastEditAt: -Infinity, input,
    editingOptions: { ...DEFAULT_EDITING_OPTIONS },
    scrollTop: 0, blocks: [], docHeight: 0, dirty: true,
    host: { clientWidth: WIDTH, clientHeight: VIEWPORT },
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    schedule() {},
  });
  editor.relayout();
  return editor;
}

/** Where the caret is painted, in window coordinates: the renderer puts a
 *  document y at `originY + y - scrollTop`, and the IME textarea with it. */
function caretTop(editor: any): number | null {
  const caret = editor.caretRect();
  return caret ? editor.originY + caret.y - editor.scrollTop : null;
}

{
  const editor = editing(long("A"));
  editor.scrollTop = editor.scrollMax;
  assert.ok(editor.scrollTop > VIEWPORT, "the document being left really is scrolled away from its top");

  editor.setText(long("B"));
  assert.equal(editor.scrollTop, 0, "opening a document puts the page back to its first line");
  assert.deepEqual([editor.selStart, editor.selEnd], [0, 0], "with the selection there too");

  // The new document is laid out only on the next frame, so the offset has to
  // survive a layout whose clamp still has plenty of room to leave it alone.
  editor.relayout();
  assert.equal(editor.scrollTop, 0, "and a document just as long does not let the old offset stand");

  const top = caretTop(editor);
  assert.ok(top !== null && top >= 0 && top <= VIEWPORT - 20,
    "so the caret about to be typed at is inside the window");
  const under = editor.positionAt(editor.gutter + 1, editor.originY + 2);
  assert.ok(under.offset <= editor.blocks[0].block.end,
    "and the text at the top of the window is the text the caret is in");
}

{
  // A short document used to come right by accident: its layout leaves nothing
  // to scroll, so the clamp dragged the offset back. Assert before that layout,
  // where the accident cannot help.
  const editor = editing(long("A"));
  editor.scrollTop = editor.scrollMax;
  editor.setText("short\n");
  assert.equal(editor.scrollTop, 0, "a short document starts at the top before it has been laid out");
  editor.relayout();
  assert.equal(editor.scrollTop, 0, "and stays there");
  assert.equal(editor.scrollMax, 0, "having nowhere to go");
}

{
  const editor = editing(long("A"));
  editor.scrollTop = editor.scrollMax;
  editor.setText("");
  assert.equal(editor.scrollTop, 0, "an empty document starts at the top");
  editor.relayout();
  const top = caretTop(editor);
  assert.ok(top !== null && top >= 0 && top <= VIEWPORT - 20,
    "and shows a caret to type the first word at");
}

{
  // The sticky column belongs to the line the reader was moving through, and
  // that line is gone. Left behind it would put the first ArrowDown in the new
  // document at a column nothing on screen ever chose.
  const editor = editing(long("A"));
  editor.preferredX = 320;
  editor.setText(long("B"));
  assert.equal(editor.preferredX, null, "vertical movement in the new document starts from its own caret");
}

{
  // `interacted` records that the reader placed the caret deliberately, and
  // nobody has placed anything in a document that has only just been opened.
  // It is what reveals a block as its own source, so left set it greets the
  // reader with the first paragraph of the new document written out in markup.
  const editor = editing(long("A"));
  editor.setText(long("B"));
  editor.relayout();
  assert.equal(editor.interacted, false, "an opened document has no deliberately placed caret");
  assert.equal(editor.blocks[0].raw, false, "so its first paragraph is typeset rather than shown as source");
}

console.log("all passing");
