// Find and replace.
//
// Matching runs over the markdown source, so a search finds `**bold**` and
// every match has a source range the caret can be put on. These tests cover
// the matching itself, stepping through matches with the wrap-around, and
// that replacing all of them is a single edit.
import assert from "node:assert/strict";
import { Editor } from "../src/editor/editor.js";
import { expandReplacement, findMatches } from "../src/editor/search.js";

const literal = (text: string, find: string, caseSensitive = false) =>
  findMatches(text, { text: find, caseSensitive, regex: false }).map((m) => [m.start, m.end]);

assert.deepEqual(literal("a cat and a cat", "cat"), [[2, 5], [12, 15]], "every match, in order");
assert.deepEqual(literal("Cat cat", "cat"), [[0, 3], [4, 7]], "case is ignored by default");
assert.deepEqual(literal("Cat cat", "cat", true), [[4, 7]], "and respected when asked");
assert.deepEqual(literal("a.b axb", "a.b"), [[0, 3]], "a literal query is not a pattern");
assert.deepEqual(literal("aaa", "aa"), [[0, 2]], "matches do not overlap");
assert.deepEqual(literal("anything", ""), [], "an empty query matches nothing");
assert.deepEqual(literal("中文排版中文", "中文"), [[0, 2], [4, 6]], "and it works in Han");

const pattern = (text: string, find: string) =>
  findMatches(text, { text: find, caseSensitive: false, regex: true }).map((m) => [m.start, m.end]);
assert.deepEqual(pattern("a1 b22 c", "\\d+"), [[1, 2], [4, 6]], "a regular expression matches");
assert.deepEqual(pattern("ab", "x*"), [], "a pattern that can match nothing reports no matches");
assert.deepEqual(pattern("ab", "("), [], "an unfinished pattern is not an error, just no matches");

const groups = (text: string, find: string) => findMatches(text, { text: find, caseSensitive: true, regex: true })[0];
assert.equal(expandReplacement("$2-$1", groups("2024-05", "(\\d+)-(\\d+)")), "05-2024", "groups are substituted");
assert.equal(expandReplacement("[$&]", groups("word", "w\\w+")), "[word]", "$& is the whole match");
assert.equal(expandReplacement("$$1", groups("x", "x")), "$1", "$$ is a literal dollar");
assert.equal(expandReplacement("$3", groups("x", "(x)")), "$3", "a group that does not exist is left alone");
assert.equal(expandReplacement("$100", groups("x", "x")), "$100", "and so is a price");

// --- stepping and replacing ----------------------------------------------
function editor(text: string, at = 0) {
  const e = Object.create(Editor.prototype) as any;
  Object.assign(e, {
    text, selStart: at, selEnd: at, caretAffinity: "downstream", preferredX: null,
    undoStack: [], redoStack: [], lastEditAt: -Infinity, dirty: false, blocks: [],
    search: null, matches: [], matchesFor: null, current: -1,
    invalidate() {}, scrollCaretIntoView() {}, onChange: null,
    input: { value: "", blur() {} }, composing: null,
  });
  return e;
}
const find = (text: string, at = 0) => {
  const e = editor(text, at);
  return {
    editor: e,
    open: (q: string, opts: Partial<{ regex: boolean; caseSensitive: boolean }> = {}) =>
      e.setSearch({ text: q, caseSensitive: false, regex: false, ...opts }),
    span: () => [e.selStart, e.selEnd] as const,
  };
};

{
  const f = find("a cat and a cat and a cat", 6);
  const status = f.open("cat");
  assert.deepEqual([status.matches, status.index], [3, 2], "the search starts at the match after the caret");
  assert.deepEqual(f.span(), [12, 15], "which is selected");
  assert.equal(f.editor.findNext().index, 3);
  assert.deepEqual(f.span(), [22, 25]);
  assert.equal(f.editor.findNext().index, 1, "the search wraps at the end");
  assert.deepEqual(f.span(), [2, 5]);
  assert.equal(f.editor.findNext(true).index, 3, "and at the start, going back");
  assert.deepEqual(f.span(), [22, 25]);
  assert.deepEqual([f.editor.setSearch(null).matches, f.editor.searchStatus().matches], [0, 0],
    "closing the search drops the matches");
}
{
  // A query with no match leaves the caret alone rather than jumping.
  const f = find("nothing here", 4);
  const status = f.open("absent");
  assert.deepEqual([status.matches, status.index], [0, 0]);
  assert.deepEqual(f.span(), [4, 4]);
  assert.equal(f.open("(", { regex: true }).valid, false, "an unfinished pattern reports itself");
  assert.equal(f.open("x", { regex: true }).valid, true);
}
{
  const f = find("one two one two", 0);
  f.open("one");
  f.editor.replaceCurrent("1");
  assert.equal(f.editor.getText(), "1 two one two", "the selected match is replaced");
  assert.deepEqual(f.span(), [6, 9], "and the next one is found");
  f.editor.replaceCurrent("1");
  assert.equal(f.editor.getText(), "1 two 1 two");
  assert.equal(f.editor.searchStatus().matches, 0, "with nothing left to find");
}
{
  // A replacement that contains the query must not match itself for ever.
  const f = find("cat cat", 0);
  f.open("cat");
  f.editor.replaceCurrent("cats");
  assert.equal(f.editor.getText(), "cats cat");
  assert.deepEqual(f.span(), [5, 8], "the search carries on past what was written");
}
{
  const f = find("one two one two", 0);
  f.open("one");
  const status = f.editor.replaceAll("1");
  assert.equal(f.editor.getText(), "1 two 1 two");
  assert.deepEqual([status.matches, status.index], [0, 0]);
  f.editor.undo();
  assert.equal(f.editor.getText(), "one two one two", "replacing everything is one undo step");
}
{
  const f = find("2024-05 and 1999-12", 0);
  f.open("(\\d{4})-(\\d{2})", { regex: true });
  f.editor.replaceAll("$2/$1");
  assert.equal(f.editor.getText(), "05/2024 and 12/1999", "groups reach every replacement");
}
{
  // Editing the document under an open search recounts it.
  const f = find("cat cat", 0);
  assert.equal(f.open("cat").matches, 2);
  f.editor.setText("cat cat cat");
  assert.equal(f.editor.searchStatus().matches, 3);
}

console.log("all passing");
