// Deleting one character, when a character is not one UTF-16 code unit.
//
// Backspace has two jobs that look alike and are not: it takes back an empty
// auto-pair in one keystroke, and otherwise it removes the character behind
// the caret. The first is a lookup at `text[lo - 1]` and `text[lo]`, and at the
// end of the document the second of those reads `undefined` — which is exactly
// what the lookup yields for a character that opens nothing, so the two
// undefineds matched and an emoji was cut in half. What follows pins the
// boundary between the two jobs, and pins it on both sides: the pair deletion
// has to keep working everywhere it used to.
//
// Grapheme clusters are a separate question and deliberately not asserted
// here. Backspace steps by code point, so a flag or a family emoji comes apart
// joiner by joiner; whether it should is a policy argument, whereas a lone
// surrogate is never anything but corruption.
import assert from "node:assert/strict";
import { DEFAULT_EDITING_OPTIONS, Editor } from "../src/editor/editor.js";

(globalThis as any).window = Object.assign(new EventTarget(), { setInterval: () => 0 });
(globalThis as any).ResizeObserver = class { observe() {} };

/** An editor holding `text` with a collapsed caret at `at`, wired to nothing. */
function editing(text: string, at: number) {
  const input = Object.assign(new EventTarget(), { value: "", focus() {}, blur() {} });
  const editor = Object.create(Editor.prototype) as any;
  Object.assign(editor, {
    text, selStart: at, selEnd: at, caretAffinity: "downstream", preferredX: null,
    composing: null, undoStack: [], redoStack: [], lastEditAt: -Infinity,
    input, canvas: new EventTarget(), host: {}, blocks: [],
    typesetter: { theme: { bodySize: 18 } },
    editingOptions: { ...DEFAULT_EDITING_OPTIONS },
    invalidate() {}, scrollCaretIntoView() {}, schedule() {},
  });
  editor.attach();
  return {
    editor,
    key: (name: string) =>
      input.dispatchEvent(Object.assign(new Event("keydown"), { key: name, preventDefault() {} })),
  };
}

/** Whether a string contains a surrogate that has lost its partner. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    }
  }
  return false;
}

/** Press Backspace once and report the document, the caret, and the undo. */
function backspace(text: string, at = text.length) {
  const session = editing(text, at);
  session.key("Backspace");
  const after = session.editor.text;
  const caret = session.editor.selStart;
  const collapsed = session.editor.selStart === session.editor.selEnd;
  session.editor.undo();
  return { after, caret, collapsed, undone: session.editor.text };
}

/** Press Delete once and report the same. */
function del(text: string, at: number) {
  const session = editing(text, at);
  session.key("Delete");
  const after = session.editor.text;
  session.editor.undo();
  return { after, caret: session.editor.selStart, undone: session.editor.text };
}

const GRINNING = "\u{1F600}";
const FLAG = "\u{1F1E8}\u{1F1F3}";
const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}";

// --- a character behind the caret goes whole ------------------------------
{
  const r = backspace(GRINNING);
  assert.equal(r.after, "", "Backspace on a document of one emoji empties it");
  assert.equal(hasLoneSurrogate(r.after), false, "and leaves no half of a surrogate pair behind");
  assert.equal(r.caret, 0, "the caret lands where the emoji began");
  assert.equal(r.collapsed, true, "as a caret and not as a selection of nothing somewhere else");
  assert.equal(r.undone, GRINNING, "and undo restores the emoji whole");
  assert.equal(hasLoneSurrogate(r.undone), false, "with both its code units");
}
{
  const r = backspace("a" + GRINNING);
  assert.equal(r.after, "a", "an emoji at the end of a longer document goes whole too");
  assert.equal(r.caret, 1, "leaving the caret after the text that preceded it");
}
{
  const r = backspace("a" + GRINNING + "b", 3);
  assert.equal(r.after, "ab", "an emoji in the middle was never in doubt");
  assert.equal(r.caret, 1, "and the caret closes the gap");
}
{
  const r = backspace("(" + GRINNING);
  assert.equal(r.after, "(", "an opener before an emoji does not make the two a pair");
  assert.equal(hasLoneSurrogate(r.after), false, "so the emoji goes whole");
}
{
  const r = backspace(FLAG);
  assert.equal(hasLoneSurrogate(r.after), false,
    "a regional indicator pair comes apart by code point, never by code unit");
  assert.equal(r.after, "\u{1F1E8}", "one indicator is removed, the other stands");
}
{
  const r = backspace(FAMILY);
  assert.equal(hasLoneSurrogate(r.after), false,
    "and a joined family emoji sheds a whole code point, joiner and all left standing");
  assert.equal(r.after, "\u{1F468}‍\u{1F469}‍", "which is the girl, not half of her");
}

// --- the ordinary cases the same branch used to reach by accident ---------
{
  const r = backspace("ab");
  assert.equal(r.after, "a", "Backspace at the end of ordinary text removes one character");
  assert.equal(r.caret, 1, "with the caret behind it");
  assert.equal(r.undone, "ab", "and undo puts it back");
}
{
  const r = backspace("a");
  assert.equal(r.after, "", "a one-character document empties");
  assert.equal(r.caret, 0, "and the caret can only be at the start");
}
{
  const r = backspace("");
  assert.equal(r.after, "", "Backspace in an empty document does nothing");
  assert.equal(r.caret, 0, "and moves no caret");
  assert.equal(r.undone, "", "so there is nothing to undo");
}

// --- an empty auto-pair still goes in one keystroke -----------------------
for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"], ["`", "`"]]) {
  const pair = open + close;
  {
    const r = backspace(pair, 1);
    assert.equal(r.after, "", `an empty ${pair} typed as one keystroke is taken back in one`);
    assert.equal(r.caret, 0, `and the caret sits where the ${open} was`);
    assert.equal(r.undone, pair, `undo brings the whole ${pair} back`);
  }
  {
    const r = backspace("x" + pair + "y", 2);
    assert.equal(r.after, "xy", `an empty ${pair} inside a line goes the same way`);
    assert.equal(r.caret, 1, "and the text closes up around it");
  }
  {
    const r = backspace("x" + pair, 3);
    assert.equal(r.after, "x" + open,
      `a caret past the ${close} is behind one character, not between two`);
  }
}
{
  const r = backspace("(]", 1);
  assert.equal(r.after, "]", "a bracket that does not close the one before it is not a pair");
}
{
  const r = backspace("[)", 1);
  assert.equal(r.after, ")", "nor the other way round");
}
{
  const r = backspace("(");
  assert.equal(r.after, "", "an opener with nothing after it is just a character");
}
{
  const r = backspace(")");
  assert.equal(r.after, "", "and so is a closer with nothing before it");
}

// --- Delete goes the other way, by the same measure -----------------------
{
  const r = del(GRINNING, 0);
  assert.equal(r.after, "", "Delete takes the emoji ahead of the caret whole");
  assert.equal(hasLoneSurrogate(r.after), false, "leaving no half behind");
  assert.equal(r.undone, GRINNING, "and undo restores it");
}
{
  const r = del("a" + GRINNING + "b", 1);
  assert.equal(r.after, "ab", "in the middle of a document too");
  assert.equal(r.caret, 1, "with the caret where it was");
}
{
  const r = del("ab", 2);
  assert.equal(r.after, "ab", "Delete at the end of the document has nothing to remove");
}
{
  const r = del("()", 1);
  assert.equal(r.after, "(",
    "Delete removes the character ahead and never the pair: it is Backspace that undoes the keystroke");
}

console.log("all passing");
