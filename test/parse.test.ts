import { parseBlocks, renderBlock, parseInline } from "../src/markdown/parse.js";

let failures = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.log(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// --- inline delimiters -----------------------------------------------------
eq(parseInline("**bold**", 0).text, "bold", "strong markers are removed");
eq(parseInline("*em*", 0).text, "em", "emphasis markers are removed");
eq(parseInline("a **b** c", 0).text, "a b c", "strong inside a sentence");
eq(parseInline("**盒子（box）**：不可伸缩", 0).text, "盒子（box）：不可伸缩",
   "closing marker is recognised with nothing after it");
eq(parseInline("~~gone~~", 0).text, "gone", "strikethrough markers are removed");
eq(parseInline("`code`", 0).text, "code", "code ticks are removed");
eq(parseInline("[label](http://x)", 0).text, "label", "link syntax leaves the label");
{
  const body = "[x](https://a_(b))";
  const r = parseInline(body, 7);
  const link = r.spans.find((s) => s.kind === "link");
  eq(r.text, "x", "balanced parentheses remain inside a link destination");
  eq(link?.href, "https://a_(b)", "the complete balanced destination becomes the href");
  eq(Array.from(r.map), [8, 25], "a balanced link has an exact offset source map");
}
{
  const r = parseInline("[**x**](a_(b))", 0);
  const link = r.spans.find((s) => s.kind === "link");
  eq([r.text, link?.strong, link?.href], ["x", true, "a_(b)"], "link labels still parse inline formatting");
}
{
  const r = parseInline("**[a *b*](url)**", 0);
  eq(r.text, "a b", "emphasis can wrap a complete link with locally formatted label");
  eq(r.spans.every((s) => s.strong), true, "a label scope preserves its outer emphasis stack");
  eq(r.spans.at(-1)?.em, true, "local emphasis closes inside the label");
  eq(parseInline("*[a*](url)", 0).text, "*a*", "a label cannot close emphasis opened outside it");
}
{
  const body = String.raw`[x](a\)b)!`;
  const r = parseInline(body, 0);
  const link = r.spans.find((s) => s.kind === "link");
  eq(r.text, "x!", "an escaped parenthesis does not close a link destination");
  eq(link?.href, "a)b", "destination escapes are decoded after finding the source boundary");
  eq(Array.from(r.map), [1, 9, 10], "text after an escaped destination maps past its real closer");
}
{
  const body = "[x](a/$y$)!";
  const r = parseInline(body, 20);
  const link = r.spans.find((s) => s.kind === "link");
  eq(r.text, "x!", "math-like text in a destination never leaks into output");
  eq(link?.href, "a/$y$", "dollar delimiters remain literal destination content");
  eq(r.spans.some((s) => s.kind === "math"), false, "a link destination creates no math span");
  eq(Array.from(r.map), [21, 30, 31], "an opaque destination retains the exact source map");
}
{
  const cases = [
    { body: "[a$x](url$)b", text: "a$xb", map: [1, 2, 3, 11, 12], kinds: ["math"] },
    { body: "[a$$x](url$$)b", text: "a$$xb", map: [1, 2, 3, 4, 13, 14], kinds: ["math"] },
    { body: String.raw`[a\(x](url\))b`, text: "a(xb", map: [1, 3, 4, 13, 14], kinds: ["math"] },
    { body: String.raw`[a\[x](url\])b`, text: "a[xb", map: [1, 3, 4, 13, 14], kinds: ["math"] },
    { body: "[a*x](url)b*", text: "a*xb*", map: [1, 2, 3, 10, 11, 12], kinds: ["em"] },
    { body: "[a**x](url)b**", text: "a**xb**", map: [1, 2, 3, 4, 11, 12, 13, 14], kinds: ["strong"] },
    { body: "[a~~x](url)b~~", text: "a~~xb~~", map: [1, 2, 3, 4, 11, 12, 13, 14], kinds: ["strike"] },
  ];
  for (const test of cases) {
    const r = parseInline(test.body, 0);
    eq(r.text, test.text, `${test.kinds[0]} cannot close across a link-label boundary`);
    eq(
      r.spans.some((s) => test.kinds.includes(s.kind)),
      false,
      `${test.kinds[0]} creates no cross-boundary span`,
    );
    eq(Array.from(r.map), test.map, `${test.kinds[0]} fallback retains its exact source map`);
  }
}
// Link components have distinct grammars. In particular, parentheses in an
// angle destination or a quoted title never extend the link into later prose.
{
  const targets = [
    { target: "<foo(bar>", href: "foo(bar" },
    { target: "<foo)bar>", href: "foo)bar" },
    { target: "<foo bar>", href: "foo bar" },
    { target: 'url "("', href: "url" },
    { target: "url ')'", href: "url" },
    { target: "url (title)", href: "url" },
    { target: '<foo(bar> "a (title)"', href: "foo(bar" },
    { target: String.raw`<foo\>bar> "quoted \"title\""`, href: "foo>bar" },
    { target: "url\n\t'title'\n", href: "url" },
    { target: "", href: "" },
    { target: "<> 'title'", href: "" },
    { target: '"a title"', href: "" },
    { target: '"title"', href: '"title"' },
  ];
  for (const { target, href } of targets) {
    const linkSource = `[x](${target})`;
    const suffix = " prose ) tail";
    const body = linkSource + suffix;
    const rendered = parseInline(body, 7);
    eq(rendered.text, "x" + suffix, `link tail preserves prose after ${JSON.stringify(target)}`);
    eq(rendered.spans.find((s) => s.kind === "link")?.href, href, "href contains only the decoded destination");
    eq(Array.from(rendered.map), [8, ...Array.from({ length: suffix.length + 1 }, (_, i) => 7 + linkSource.length + i)],
      "source mapping skips exactly the complete link tail");
  }
  for (const body of ["[x](<foo(bar)", "[x](<foo\nbar>)", "[x](a b)", '[x](url "unfinished) tail',
    '[x](url "title" garbage) tail', "[x](url (nested (title)))", "[x](url\n\n 'title')"]) {
    const rendered = parseInline(body, 0);
    eq(rendered.spans.some((s) => s.kind === "link"), false, "malformed link tails remain source text");
  }
}
{
  const body = "[foo`](/uri)`";
  const rendered = parseInline(body, 7);
  eq(rendered.text, "[foo](/uri)", "code opacity is resolved before choosing a link label boundary");
  eq(rendered.spans.some((s) => s.kind === "link"), false, "a closing bracket inside code cannot create a link");
  const code = rendered.spans.find((s) => s.code)!;
  eq(rendered.text.slice(code.start, code.end), "](/uri)", "the entire code span stays visible");
  eq(Array.from(rendered.map), [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 13].map((i) => i + 7),
    "code/link precedence preserves exact source offsets");
  const cases = [
    { body: "[a`x](url`)b", text: "[ax](url)b", href: undefined },
    { body: "[a`]`b](url)", text: "a]b", href: "url" },
    { body: "[a``]`b``c](url)", text: "a]`bc", href: "url" },
    { body: "[a`b](url)", text: "a`b", href: "url" },
    { body: "[a`b``](url)", text: "a`b``", href: "url" },
    { body: "[`x](first)`][y](second)", text: "[x](first)]y", href: "second" },
  ];
  for (const { body, text, href } of cases) {
    const rendered = parseInline(body, 0);
    eq(rendered.text, text, `code runs and label brackets agree for ${JSON.stringify(body)}`);
    eq(rendered.spans.find((s) => s.kind === "link")?.href, href, "only brackets outside matched code close labels");
  }
  eq(parseInline("`a``b`", 0).text, "a``b", "a longer backtick run cannot close a shorter one");
}
{
  const body = "[x](a_(b)";
  const r = parseInline(body, 3);
  eq(r.text, body, "an incomplete balanced destination falls back to literal text");
  eq(r.spans.some((s) => s.kind === "link"), false, "an incomplete destination creates no link span");
  eq(Array.from(r.map), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "an incomplete link keeps an identity source map");
}
eq(parseInline("2 * 3 * 4", 0).text, "2 * 3 * 4", "lone asterisks stay literal");
eq(parseInline("a\\*b", 0).text, "a*b", "backslash escapes the marker");
eq(parseInline(String.raw`\a`, 0).text, String.raw`\a`, "backslash before a letter stays literal");
eq(parseInline(String.raw`\中`, 0).text, String.raw`\中`, "backslash before CJK stays literal");
eq(parseInline(String.raw`\。`, 0).text, String.raw`\。`, "Unicode punctuation is not escapable");
eq(
  parseInline(String.raw`C:\Users\miracle\note.md`, 0).text,
  String.raw`C:\Users\miracle\note.md`,
  "a Windows path keeps its backslashes",
);

{
  const punctuation = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
  const escaped = [...punctuation].map((c) => parseInline("\\" + c, 0).text).join("");
  eq(escaped, punctuation, "every CommonMark ASCII punctuation character is escapable");
}
{
  const literal = ["a", "0", " ", "中", "。", "é"];
  const rendered = literal.map((c) => parseInline("\\" + c, 0).text);
  eq(rendered, literal.map((c) => "\\" + c), "non-punctuation characters keep the slash");
}
eq(parseInline("`\\*`", 0).text, "\\*", "code span content is opaque to escapes");
eq(parseInline("a\\\nb", 0).text, "a b", "backslash-newline keeps the legacy soft-break fallback");

// --- the source map --------------------------------------------------------
{
  const r = parseInline("**bold** tail", 0);
  // "bold" starts at source index 2, and "tail" at 9.
  eq(r.map[0], 2, "map skips the opening delimiter");
  eq(r.map[r.text.indexOf("tail")], 9, "map accounts for the closing delimiter");
}
{
  const r = parseInline("plain", 7);
  eq(Array.from(r.map), [7, 8, 9, 10, 11, 12], "map is offset by the block base");
}
{
  const r = parseInline("a\\*b", 0);
  eq(Array.from(r.map), [0, 2, 3, 4], "map skips a valid backslash escape");
}
{
  const r = parseInline(String.raw`\a`, 7);
  eq(Array.from(r.map), [7, 8, 9], "map remains an identity for a literal backslash");
}

// --- styles carry through --------------------------------------------------
{
  const r = parseInline("a **b** c", 0);
  const strong = r.spans.find((s) => s.strong);
  eq(strong ? r.text.slice(strong.start, strong.end) : null, "b", "the strong span covers only b");
}

// --- blocks ----------------------------------------------------------------
{
  const doc = "# Title\n\npara one\n\n- item\n- item2\n\n```js\ncode()\n```\n";
  const types = parseBlocks(doc).map((b) => b.type);
  eq(types, ["heading", "blank", "paragraph", "blank", "list", "list", "blank", "code"],
     "block types in order");
}
{
  const doc = "````js\nalpha\n```\nafter";
  const blocks = parseBlocks(doc);
  eq(blocks.map((b) => b.type), ["code"], "a shorter backtick run does not close a fence");
  eq(blocks[0].source, doc, "an invalid short closer remains code content");
}
{
  const doc = "````js\nalpha\n`````\nafter";
  const blocks = parseBlocks(doc);
  eq(blocks.map((b) => b.type), ["code", "paragraph"], "a longer backtick run closes a fence");
  eq(blocks[0].source, "````js\nalpha\n`````", "the valid longer closer ends the code source");
}
{
  const doc = "~~~~\nalpha\n~~~\nafter";
  const blocks = parseBlocks(doc);
  eq(blocks.map((b) => b.type), ["code"], "a shorter tilde run does not close a fence");
}
{
  const doc = "~~~~\nalpha\n````\nafter";
  const blocks = parseBlocks(doc);
  eq(blocks.map((b) => b.type), ["code"], "the other fence character cannot close a block");
}
{
  const doc = "~~~\nalpha\n~~~~\nafter";
  const blocks = parseBlocks(doc);
  eq(blocks.map((b) => b.type), ["code", "paragraph"], "a longer tilde run closes a fence");
}
{
  const doc = "# 标题 **粗**";
  const [b] = parseBlocks(doc);
  eq(renderBlock(b, false).text, "标题 粗", "heading strips its hashes and markers");
  eq(renderBlock(b, true).text, doc, "the focused block shows raw source");
}
{
  const doc = "- **first**\n  continued normally";
  const [b] = parseBlocks(doc);
  const rendered = renderBlock(b, false);
  eq(b.type, "list", "an ordinary lazy continuation stays in its list item");
  eq(b.source, doc, "a multi-line list item retains its exact source range");
  eq(rendered.text, "first continued normally", "a multi-line bullet strips its first-line marker");
  eq(rendered.map[0], doc.indexOf("first"), "the first list character maps past the marker");
  eq(
    rendered.map[rendered.text.indexOf("continued")],
    doc.indexOf("continued"),
    "a continuation character maps to its original source position",
  );
  eq(rendered.map[rendered.map.length - 1], b.end, "the multi-line list end map matches its range");
}
{
  const doc = "12) first\ncontinuation";
  const [b] = parseBlocks(doc);
  eq(b.marker, "12)", "an ordered list retains its rendered marker");
  eq(renderBlock(b, false).text, "first continuation", "an ordered multi-line item strips its source marker");
}
{
  const doc = "- item\n> quote\n---\n$$\nx + y\n$$\nafter";
  const blocks = parseBlocks(doc);
  eq(
    blocks.map((b) => b.type),
    ["list", "quote", "rule", "math", "paragraph"],
    "quote, rule, and display math interrupt a list continuation",
  );
  eq(blocks.map((b) => b.source), ["- item", "> quote", "---", "$$\nx + y\n$$", "after"], "list interrupts preserve every block source");
  eq(
    blocks.map((b) => [b.start, b.end]),
    blocks.map((b) => [doc.indexOf(b.source), doc.indexOf(b.source) + b.source.length]),
    "list interrupts retain exact document ranges",
  );
}
{
  const doc = "- item\n\\[\nx + y\n\\]\nafter";
  const blocks = parseBlocks(doc);
  eq(blocks.map((b) => b.type), ["list", "math", "paragraph"], "TeX display math interrupts a list continuation");
  eq(blocks[1].source, "\\[\nx + y\n\\]", "the TeX display block is not swallowed by the list");
}
{
  const doc = "> quoted **text**\n> second";
  const [b] = parseBlocks(doc);
  eq(renderBlock(b, false).text, "quoted text second", "blockquote strips its markers");
}
{
  // Every rendered character must map to a real source position.
  const doc = "para with **bold** and `code` and [a link](u).";
  const [b] = parseBlocks(doc);
  const r = renderBlock(b, false);
  let ok = true;
  for (let i = 0; i < r.text.length; i++) {
    if (doc[r.map[i]] !== r.text[i]) {
      ok = false;
      console.log(`  mismatch at ${i}: rendered ${JSON.stringify(r.text[i])} maps to ${JSON.stringify(doc[r.map[i]])}`);
    }
  }
  eq(ok, true, "every rendered character maps back to the identical source character");
}


// --- ordered list numbering ------------------------------------------------
// CommonMark takes an ordered list's start from its first item and ignores
// every number after it, which is what lets an author reorder items without
// renumbering the source by hand.
const markers = (doc: string) =>
  parseBlocks(doc).filter((b) => b.type === "list").map((b) => b.marker);

eq(markers("1. a\n1. b\n1. c"), ["1.", "2.", "3."], "repeated 1. counts up");
eq(markers("1. a\n2. b\n3. c"), ["1.", "2.", "3."], "already-correct numbers are kept");
eq(markers("1. a\n7. b\n2. c"), ["1.", "2.", "3."], "later numbers are ignored");
eq(markers("5. a\n1. b"), ["5.", "6."], "the first item sets the start");
eq(markers("1) a\n1) b"), ["1)", "2)"], "the delimiter the author chose is kept");
eq(markers("- a\n- b"), ["\u2022", "\u2022"], "bullets stay bullets");

// A nested list keeps its own count, and the outer level resumes.
eq(
  markers("1. a\n  1. x\n  1. y\n1. b"),
  ["1.", "1.", "2.", "2."],
  "a nested list counts separately and the outer one carries on",
);

// Anything that is not a list ends the run.
eq(markers("1. a\n\npara\n\n1. b"), ["1.", "1."], "a paragraph between items restarts");
eq(markers("1. a\n\n1. b"), ["1.", "2."], "but a blank line alone does not");
eq(markers("1. a\n- b\n1. c"), ["1.", "\u2022", "1."], "switching to bullets restarts the count");

// The source is untouched: only the printed marker is computed.
{
  const doc = "1. first\n1. second";
  const [, second] = parseBlocks(doc).filter((b) => b.type === "list");
  eq(second.source, "1. second", "the block still holds what the author typed");
  eq(renderBlock(second, false).text, "second", "and renders its own text");
  eq(renderBlock(second, true).text, "1. second", "raw mode shows the typed number");
}


// --- autolinks -------------------------------------------------------------
// The scheme is what separates a link from markup that merely looks like one,
// so HTML sitting in a paragraph must survive untouched.
const autoHref = (body: string) =>
  parseInline(body, 0).spans.find((s) => s.kind === "link")?.href;

eq(parseInline("<https://example.com>", 0).text, "https://example.com",
   "the angle brackets are removed");
eq(autoHref("<https://example.com>"), "https://example.com", "and the URL becomes the href");
eq(autoHref("<http://a.b/c?d=e#f>"), "http://a.b/c?d=e#f", "query and fragment survive");
eq(autoHref("<ftp://host/path>"), "ftp://host/path", "any scheme qualifies");
eq(autoHref("<mailto:a@b.c>"), "mailto:a@b.c", "an explicit mailto is a URI autolink");

// Email autolinks carry no scheme; the renderer supplies it.
eq(parseInline("<user@example.com>", 0).text, "user@example.com", "an email keeps its text");
eq(autoHref("<user@example.com>"), "mailto:user@example.com", "and gains a mailto href");

// Not autolinks.
eq(autoHref("<div>"), undefined, "a bare tag has no scheme and is not a link");
eq(parseInline("<div>", 0).text, "<div>", "and survives verbatim");
eq(autoHref("<not a url>"), undefined, "spaces disqualify a candidate");
eq(autoHref("<https://a b>"), undefined, "including inside the URL");
eq(autoHref("< https://x>"), undefined, "a leading space disqualifies it");
eq(autoHref("<a:b>"), undefined, "a one-letter scheme is too short");

// Interaction with the constructs scanned around it.
eq(parseInline("`<https://x>`", 0).text, "<https://x>", "a code span stays literal");
eq(parseInline("see <https://x> now", 0).text, "see https://x now", "inside a sentence");
{
  const r = parseInline("[label](<https://x>)", 0);
  eq(r.text, "label", "an angle destination is still a destination, not an autolink");
  eq(r.spans.find((s) => s.kind === "link")?.href, "https://x", "and keeps its href");
}
{
  // CommonMark forbids a link inside a link; the outer one owns the text.
  const r = parseInline("[<https://x>](y)", 0);
  eq(r.spans.filter((s) => s.kind === "link").length >= 1, true,
     "a nested autolink does not create a second link format");
  eq(r.text, "<https://x>", "and the label keeps its literal angle brackets");
}
{
  const body = "a <https://x> b";
  const r = parseInline(body, 100);
  eq(r.map.length, r.text.length + 1, "the source map still covers every character");
  eq(r.map[r.text.indexOf("https")], 100 + body.indexOf("https"),
     "and the URL text maps past the opening bracket");
}


// --- task lists ------------------------------------------------------------
const tasks = (doc: string) =>
  parseBlocks(doc).filter((b) => b.type === "list").map((b) => b.task);

eq(tasks("- [ ] open"), ["todo"], "an empty box is a pending task");
eq(tasks("- [x] done"), ["done"], "a lowercase x ticks it");
eq(tasks("- [X] done"), ["done"], "and so does uppercase");
eq(tasks("- plain"), ["none"], "a bullet without a box is not a task");
eq(tasks("- [ ]nospace"), ["none"], "GFM requires the space after the bracket");
eq(tasks("- [y] bad"), ["none"], "only a space or an x count");
eq(tasks("1. [x] numbered"), ["none"], "a checkbox belongs to a bullet, not a number");
eq(tasks("- [ ] a\n- [x] b\n- c"), ["todo", "done", "none"], "mixed items in one list");

// The checkbox is drawn as a marker, so it leaves the text.
{
  const doc = "- [x] buy milk";
  const [b] = parseBlocks(doc);
  const r = renderBlock(b, false);
  eq(r.text, "buy milk", "the box and bullet are both stripped");
  eq(r.map[0], doc.indexOf("buy"), "the first character maps past both");
  eq(r.map.length, r.text.length + 1, "the map still covers every character");
  eq(renderBlock(b, true).text, doc, "raw mode shows the source unchanged");
}
{
  // The bracket must go before inline parsing, or it opens a link label.
  const [b] = parseBlocks("- [ ] see [docs](x) later");
  const r = renderBlock(b, false);
  eq(r.text, "see docs later", "a real link in the item still parses");
  eq(r.spans.some((s) => s.kind === "link"), true, "and keeps its link span");
}
{
  const [b] = parseBlocks("- [x] **bold** text");
  eq(renderBlock(b, false).text, "bold text", "emphasis after a checkbox still works");
}

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
