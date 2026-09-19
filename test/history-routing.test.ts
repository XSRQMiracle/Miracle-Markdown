// Two histories, and which one a command means.
//
// The document's history is the editor's own: the text lives in the engine, so
// there is nothing in the DOM for the platform to undo. Every ordinary field
// in the chrome keeps the platform's history, which is what anyone typing in a
// search box expects. The native Edit menu has one Undo, so something has to
// decide, and the ⌘Z that reaches that menu never reaches the page.
//
// The other half is the route the menu does not own. A host command that
// drives the webview's editing history arrives at the hidden textarea as a
// `beforeinput`, and that textarea is a keystroke collector emptied after
// every input — its history holds fragments of typing, not the document. That
// is what used to put "KK" back into a document whose last edit was
// "UNDO-CHECK".
import assert from "node:assert/strict";
import { DEFAULT_EDITING_OPTIONS, Editor } from "../src/editor/editor.js";
import { historyTargetFor } from "../src/ui/native-edit.js";

(globalThis as any).window = Object.assign(new EventTarget(), { setInterval: () => 0 });
(globalThis as any).ResizeObserver = class { observe() {} };

// --- which history a menu command means ------------------------------------
{
  assert.equal(historyTargetFor({ tagName: "TEXTAREA" }, true), "document",
    "the editor's own surface is the document, whatever kind of element it is");

  for (const tag of ["INPUT", "TEXTAREA", "input", "textarea"]) {
    assert.equal(historyTargetFor({ tagName: tag }, false), "field",
      `a focused ${tag} keeps the platform's history, as anyone typing in one expects`);
  }
  assert.equal(historyTargetFor({ tagName: "DIV", isContentEditable: true }, false), "field",
    "and so does anything else the platform considers editable");

  assert.equal(historyTargetFor({ tagName: "DIV" }, false), "document",
    "focus resting on something that is not a text field means the document");
  assert.equal(historyTargetFor({ tagName: "BUTTON" }, false), "document",
    "a button is not a history");
  assert.equal(historyTargetFor(null, false), "document",
    "and with nothing focused at all — after a dialog closes — the document is what the window is for");
}

// --- a host history command reaches the document's history ------------------
function editing(text: string) {
  const input = Object.assign(new EventTarget(), { value: "", focus() {}, blur() {} });
  const editor = Object.create(Editor.prototype) as any;
  Object.assign(editor, {
    text: "", selStart: 0, selEnd: 0, caretAffinity: "downstream", preferredX: null,
    composing: null, undoStack: [], redoStack: [], lastEditAt: -Infinity,
    input, canvas: new EventTarget(), host: {}, blocks: [],
    typesetter: { theme: { bodySize: 18 } },
    editingOptions: { ...DEFAULT_EDITING_OPTIONS },
    invalidate() {}, scrollCaretIntoView() {}, schedule() {},
  });
  editor.attach();
  // Typed rather than assigned, so the document's history has real entries in
  // it and the textarea has the native history that used to be undone instead.
  for (const chunk of text.match(/./g) ?? []) {
    input.value = chunk;
    input.dispatchEvent(Object.assign(new Event("input"), { inputType: "insertText", isComposing: false }));
    editor.lastEditAt = -Infinity;   // each chunk its own entry, as a pause would give
  }
  return {
    editor,
    input,
    history(inputType: string) {
      let prevented = false;
      input.dispatchEvent(Object.assign(new Event("beforeinput"), {
        inputType,
        preventDefault() { prevented = true; },
      }));
      return prevented;
    },
  };
}

{
  const s = editing("UNDO-CHECK");
  assert.equal(s.editor.text, "UNDO-CHECK", "the document holds what was typed");

  assert.equal(s.history("historyUndo"), true,
    "a host undo is claimed, so the platform does not also undo the textarea");
  assert.equal(s.editor.text, "UNDO-CHEC",
    "and it takes back the document's last edit, which is what ⌘Z takes back");

  assert.equal(s.history("historyRedo"), true, "a host redo is claimed too");
  assert.equal(s.editor.text, "UNDO-CHECK",
    "and puts back exactly what the undo took, rather than a fragment of an old keystroke");
}
{
  // Undo all the way out, then back, alternating the two routes — the report's
  // acceptance is that the menu and the keyboard drive one history.
  const s = editing("abcdefgh");
  s.editor.undo();
  assert.equal(s.history("historyUndo"), true, "the host route continues where the keyboard left off");
  s.editor.undo();
  assert.equal(s.editor.text, "abcde",
    "three undos, taken alternately from the keyboard and from the menu, take three edits back");
  s.editor.redo();
  assert.equal(s.history("historyRedo"), true, "and redo alternates the same way");
  assert.equal(s.editor.text, "abcdefg", "walking back up the one stack they share");
}
{
  const s = editing("x");
  assert.equal(s.input.value, "", "the collector is empty between keystrokes");
  s.history("historyUndo");
  assert.equal(s.input.value, "",
    "and an undo leaves it empty rather than restoring a keystroke into it");
}
{
  const s = editing("abc");
  assert.equal(s.history("insertText"), false,
    "an ordinary input is not a history command and is left alone");
  assert.equal(s.editor.text, "abc", "so nothing is undone by it");
}

console.log("all passing");
