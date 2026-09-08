// Source transformations behind the editing commands.
//
// These run on strings alone: given a document and a selection, what does the
// document become? Keeping them pure is what makes the awkward cases — a
// selection with a space on the end, markup already there, a formula caught in
// the middle — cheap to pin down.
import assert from "node:assert/strict";
import { clearFormat, setHeading, stepHeading, toggleInline, toggleLink, toggleList, toggleQuote, unwrapFenced, wrapFenced } from "../src/markdown/edit.js";

let failures = 0;
function shows(text: string, sel: [number, number], edit: ReturnType<typeof toggleInline> | null, label: string, expected: string) {
  // Render the result with | for a collapsed caret and [ ] around a selection.
  let out: string;
  if (!edit) out = text;
  else {
    out = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
    const s = edit.select ?? { start: edit.from + edit.insert.length, end: edit.from + edit.insert.length };
    out = s.start === s.end
      ? out.slice(0, s.start) + "|" + out.slice(s.start)
      : out.slice(0, s.start) + "[" + out.slice(s.start, s.end) + "]" + out.slice(s.end);
  }
  if (out !== expected) {
    failures++;
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(out)}`);
  }
}

const wrap = (text: string, start: number, end: number, open: string, close = open) =>
  toggleInline(text, { start, end }, open, close);

// --- wrapping -------------------------------------------------------------
shows("one two", [0, 3], wrap("one two", 0, 3, "**"), "a selection is wrapped and stays selected", "**[one]** two");
shows("one two", [4, 7], wrap("one two", 4, 7, "*"), "emphasis too", "one *[two]*");
shows("", [0, 0], wrap("", 0, 0, "`"), "an empty selection gives an empty pair", "`|`");
shows("ab", [0, 2], wrap("ab", 0, 2, "<u>", "</u>"), "an asymmetric pair", "<u>[ab]</u>");

// CommonMark will not close emphasis against a space, so the space is left out.
shows("one two", [0, 4], wrap("one two", 0, 4, "**"), "trailing space stays outside the pair", "**[one]** two");
shows("one two", [3, 7], wrap("one two", 3, 7, "**"), "and a leading one", "one **[two]**");
shows("  ", [0, 2], wrap("  ", 0, 2, "**"), "a selection of nothing but space still wraps", "**[  ]**");

// --- unwrapping -----------------------------------------------------------
shows("**one** two", [2, 5], wrap("**one** two", 2, 5, "**"), "the pair around the selection comes off", "[one] two");
shows("**one** two", [0, 7], wrap("**one** two", 0, 7, "**"), "and so does one inside it", "[one] two");
shows("*a*", [0, 3], wrap("*a*", 0, 3, "*"), "a one-character pair", "[a]");
shows("**a**", [2, 3], wrap("**a**", 2, 3, "*"),
  "emphasis inside strong nests rather than unwrapping", "**\*[a]\***");
shows("~~x~~", [2, 3], wrap("~~x~~", 2, 3, "~~"), "strikethrough", "[x]");

// A run of three is the two emphasis markers written together, so toggling
// either one takes back its own share and leaves the other standing.
shows("***a***", [3, 4], wrap("***a***", 3, 4, "*"), "italic off, bold stays", "**[a]**");
shows("***a***", [3, 4], wrap("***a***", 3, 4, "**"), "bold off, italic stays", "*[a]*");
shows("```a```", [3, 4], wrap("```a```", 3, 4, "`"), "but a run of backticks is not emphasis", "````[a]````");

// Toggling twice returns the document to where it started.
{
  const first = wrap("word", 0, 4, "**");
  const text = "**word**";
  const back = toggleInline(text, first.select!, "**");
  assert.equal(text.slice(0, back.from) + back.insert + text.slice(back.to), "word",
    "wrapping and unwrapping is a round trip");
}

// --- headings -------------------------------------------------------------
const head = (text: string, level: number, start = 0, end = start) =>
  setHeading(text, { start, end }, level);
const apply = (text: string, edit: ReturnType<typeof setHeading>) =>
  edit ? text.slice(0, edit.from) + edit.insert + text.slice(edit.to) : text;

assert.equal(apply("title", head("title", 2)), "## title", "a paragraph becomes a heading");
assert.equal(apply("## title", head("## title", 3)), "### title", "and a heading changes level");
assert.equal(apply("## title", head("## title", 2)), "title", "asking for the level it has takes it off");
assert.equal(apply("- item", head("- item", 1)), "# item", "a list marker goes with the change");
assert.equal(apply("- [ ] task", head("- [ ] task", 1)), "# task", "checkbox and all");
assert.equal(apply("> quoted", head("> quoted", 1)), "> # quoted", "but a quote keeps its marker");
assert.equal(apply("  nested", head("  nested", 1)), "  # nested", "and so does indentation");
assert.equal(apply("#hash", head("#hash", 1)), "# #hash", "a hash with no space was never a heading");
assert.equal(head("title", 0), null, "a paragraph asked to be a paragraph is already one");
assert.equal(apply("## title", head("## title", 0)), "title", "level 0 takes the heading off");

// A selection covering several lines makes each of them a heading.
assert.equal(apply("a\nb", head("a\nb", 2, 0, 3)), "## a\n## b");
assert.equal(apply("a\nb", head("a\nb", 2, 0, 0)), "## a\nb", "a caret only affects its own line");

// The caret keeps its distance from the end of the line, so the words do not
// slide out from under it.
{
  const edit = head("title", 2, 3);
  assert.deepEqual(edit!.select, { start: 6, end: 6 }, "the caret stays between the same letters");
}

const step = (text: string, dir: 1 | -1, at = 0) => apply(text, stepHeading(text, { start: at, end: at }, dir));
assert.equal(step("### x", 1), "## x", "promoting makes the heading bigger");
assert.equal(step("# x", 1), "# x", "and stops at the top");
assert.equal(step("x", 1), "###### x", "a paragraph promotes to the smallest heading");
assert.equal(step("### x", -1), "#### x", "demoting makes it smaller");
assert.equal(step("###### x", -1), "x", "and falls out to a paragraph");
assert.equal(step("x", -1), "x", "which has nowhere further to go");

// --- fenced blocks --------------------------------------------------------
{
  const fence = (text: string, start = 0, end = text.length) =>
    apply(text, wrapFenced(text, { start, end }, "```", "```"));
  assert.equal(fence("code"), "```\ncode\n```", "the selection goes inside a fence");
  assert.equal(fence("a\nb"), "```\na\nb\n```", "however many lines");
  assert.equal(fence(""), "```\n\n```", "and an empty line still gets one");
  assert.deepEqual(wrapFenced("", { start: 0, end: 0 }, "$$", "$$").select, { start: 3, end: 3 },
    "with the caret on the line between the halves");

  const unwrap = (text: string) => apply(text, unwrapFenced(text, { start: 0, end: text.length }));
  assert.equal(unwrap("```\ncode\n```"), "code", "and comes back out");
  assert.equal(unwrap("```js\ncode\n```"), "code", "language tag and all");
  assert.equal(unwrap("~~~\ncode\n~~~"), "code", "whichever character fenced it");
  assert.equal(unwrap("$$\nx = 1\n$$"), "x = 1", "a display formula too");
  assert.equal(unwrap("$$ x = 1 $$"), "x = 1", "including one written on a single line");
  assert.equal(unwrap("```\ncode"), "code", "an unclosed fence loses the half it has");
  assert.equal(unwrapFenced("plain", { start: 0, end: 5 }), null, "and plain text has nothing to lose");
}

// --- lists ----------------------------------------------------------------
const list = (text: string, kind: "bullet" | "ordered" | "task", start = 0, end = text.length) =>
  apply(text, toggleList(text, { start, end }, kind));
assert.equal(list("a\nb", "bullet"), "- a\n- b", "lines become items");
assert.equal(list("- a\n- b", "bullet"), "a\nb", "and the same key takes the markers off");
assert.equal(list("a\nb", "ordered"), "1. a\n2. b", "a numbered list counts");
assert.equal(list("- a\n- b", "ordered"), "1. a\n2. b", "and restyles a bulleted one in place");
assert.equal(list("1. a\n2. b", "bullet"), "- a\n- b", "in both directions");
assert.equal(list("a", "task"), "- [ ] a", "a task item carries a box");
assert.equal(list("- [x] a", "task"), "a", "which comes off again, ticked or not");
assert.equal(list("- [x] a", "bullet"), "- a", "and a task list flattens to bullets");
assert.equal(list("- a", "task"), "- [ ] a", "or gains boxes");
assert.equal(list("  a", "bullet"), "  - a", "indentation is kept");
assert.equal(list("> a", "bullet"), "> - a", "and so is a quote marker");
assert.equal(list("a\n\nb", "ordered"), "1. a\n\n2. b", "blank lines are left alone but not counted");
assert.equal(list("7) x", "ordered"), "x", "an existing number is a list already, so it toggles off");
assert.equal(list("- a\n2. b", "ordered"), "1. a\n2. b", "a half-numbered range is numbered from one");
assert.equal(toggleList("", { start: 0, end: 0 }, "bullet"), null, "an empty line is nothing to list");

// --- blockquote -----------------------------------------------------------
const quote = (text: string, start = 0, end = text.length) => apply(text, toggleQuote(text, { start, end }));
assert.equal(quote("a"), "> a", "a line is quoted");
assert.equal(quote("> a"), "a", "and unquoted again");
assert.equal(quote(">a"), "a", "however tightly it was written");
assert.equal(quote("a\nb"), "> a\n> b", "every line the selection touches");
assert.equal(quote("> a\n> b"), "a\nb");
assert.equal(quote("> a\nb"), "> > a\n> b", "a partly quoted range is quoted the rest of the way");
// A blank line with no marker would end the quote, so it gets one too.
assert.equal(quote("a\n\nb"), "> a\n>\n> b", "a blank line inside the range is kept in the quote");
assert.equal(quote("> a\n>\n> b"), "a\n\nb", "and given back on the way out");
assert.equal(quote("> > deep"), "> deep", "one level at a time");

// --- links ----------------------------------------------------------------
const link = (text: string, start: number, end = start) => toggleLink(text, { start, end });
shows("read this", [5, 9], link("read this", 5, 9), "the selection becomes the label", "read [this](|)");
shows("", [0, 0], link("", 0, 0), "with nothing selected the caret goes to the destination", "[](|)");
shows("https://a.example", [0, 17], link("https://a.example", 0, 17),
  "a selected URL becomes the destination instead", "[|](https://a.example)");
shows("mailto:a@b.c", [0, 12], link("mailto:a@b.c", 0, 12), "and so does an address", "[|](mailto:a@b.c)");
shows("a [b](/c) d", [3, 4], link("a [b](/c) d", 3, 4), "a link the selection sits in comes apart", "a [b] d");
shows("a [b](/c) d", [2, 9], link("a [b](/c) d", 2, 9), "however much of it is selected", "a [b] d");
shows("a [b](/c) d", [7, 8], link("a [b](/c) d", 7, 8), "including from inside the destination", "a [b] d");
shows("![alt](/p)", [2, 5], link("![alt](/p)", 2, 5), "but an image is not a link", "![[alt](|)](/p)");

// --- clearing -------------------------------------------------------------
const clear = (text: string) => {
  const edit = clearFormat(text, { start: 0, end: text.length });
  return edit ? text.slice(0, edit.from) + edit.insert + text.slice(edit.to) : text;
};
assert.equal(clear("**bold** and *em*"), "bold and em", "emphasis markers go");
assert.equal(clear("`code` and ~~gone~~"), "code and gone");
assert.equal(clear("[text](https://example.com)"), "text", "a link keeps its text");
assert.equal(clear("plain text"), "plain text", "text with no markup is untouched");
assert.equal(clearFormat("plain", { start: 0, end: 5 }), null, "and reports that nothing changed");
assert.equal(clearFormat("", { start: 0, end: 0 }), null, "an empty selection is nothing to do");

// A formula is content rather than styling, so it survives with its
// delimiters — it renders as an object, and the source is put back.
assert.equal(clear("**a** $x^2$ *b*"), "a $x^2$ b", "a formula keeps its dollars");
assert.equal(clear("![alt](pic.png)"), "![alt](pic.png)", "and an image keeps its source");
assert.equal(clear("a **b `c` d** e"), "a b c d e", "nested markup all the way down");

// Across blocks the line structure has to survive: a newline handed to the
// inline parser is a soft break, and the CJK rule would discard it — welding
// two paragraphs into one.
assert.equal(clear("**一段**\n\n*第二段*"), "一段\n\n第二段", "blank lines between blocks are kept");
assert.equal(clear("- **a**\n- *b*"), "- a\n- b", "and so are the lines of a list");
assert.equal(clear("中文**加粗**中文"), "中文加粗中文", "with no stray space where the markers were");

console.log(failures ? `\n${failures} failing` : "all passing");
process.exit(failures ? 1 : 0);
