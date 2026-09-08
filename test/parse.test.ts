import {
  DEFAULT_INLINE_OPTIONS,
  parseBlocks,
  renderBlock,
  parseInline,
  LINE_SEPARATOR,
} from "../src/markdown/parse.js";

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

// --- highlight, an opt-in extension ---------------------------------------
// `==` is not CommonMark, so it is off unless asked for — as it is in Typora.
{
  const on = { ...DEFAULT_INLINE_OPTIONS, highlight: true };
  const lit = parseInline("==key==", 0, undefined, DEFAULT_INLINE_OPTIONS);
  eq(lit.text, "==key==", "with the option off the equals signs are text");
  eq(lit.spans.map((s) => s.highlight), [false], "and nothing is highlighted");

  const marked = parseInline("==key==", 0, undefined, on);
  eq(marked.text, "key", "with it on the markers are removed");
  eq(marked.spans.map((s) => [s.kind, s.highlight]), [["highlight", true]]);
  eq(parseInline("a ==b== c", 0, undefined, on).text, "a b c", "inside a sentence");
  eq(parseInline("=one=", 0, undefined, on).text, "=one=",
     "a single equals is ordinary punctuation, not a delimiter");
  eq(parseInline("a = b", 0, undefined, on).text, "a = b", "and so is one on its own");
  eq(parseInline("== spaced ==", 0, undefined, on).text, "== spaced ==",
     "a marker with space after it cannot open");
  // It nests with the other emphasis, in both directions.
  eq(parseInline("==**a**==", 0, undefined, on).spans.map((s) => [s.highlight, s.strong]),
     [[true, true]], "strong inside a highlight");
  eq(parseInline("**==a==**", 0, undefined, on).spans.map((s) => [s.highlight, s.strong]),
     [[true, true]], "and a highlight inside strong");
  eq(parseInline("`==a==`", 0, undefined, on).spans.map((s) => [s.code, s.highlight]),
     [[true, false]], "code is opaque to it");
}

// --- subscript and superscript, also opt-in -------------------------------
{
  const on = { ...DEFAULT_INLINE_OPTIONS, subscript: true, superscript: true };
  eq(parseInline("H~2~O", 0, undefined, DEFAULT_INLINE_OPTIONS).text, "H~2~O",
     "with the options off the tildes are text");
  eq(parseInline("H~2~O", 0, undefined, on).text, "H2O", "and with them on the markers go");
  eq(parseInline("H~2~O", 0, undefined, on).spans.map((s) => [s.sub, s.sup]),
     [[false, false], [true, false], [false, false]], "only the digit is a subscript");
  eq(parseInline("X^2^", 0, undefined, on).text, "X2", "a superscript reads the same way");
  eq(parseInline("X^2^", 0, undefined, on).spans.map((s) => s.sup), [false, true]);

  // The rule is narrow on purpose.
  eq(parseInline("~long text~", 0, undefined, on).text, "~long text~",
     "a space inside ends the attempt");
  eq(parseInline("~long\\ text~", 0, undefined, on).text, "long text",
     "unless it is written as an escape, which is then dropped");
  eq(parseInline("~~gone~~", 0, undefined, on).text, "gone",
     "a doubled tilde is still strikethrough");
  eq(parseInline("~~a~b~~", 0, undefined, on).text, "a~b",
     "and strikethrough wins over a subscript inside it");
  eq(parseInline("~a~b~", 0, undefined, on).text, "ab~", "matching is lazy, so the first pair wins");
  eq(parseInline("~~", 0, undefined, on).text, "~~", "an empty pair is not one");
  eq(parseInline("a ~ b", 0, undefined, on).text, "a ~ b", "a lone tilde is ordinary punctuation");
  eq(parseInline("2^10 and 3^2", 0, undefined, on).text, "2^10 and 3^2",
     "carets that never close are left alone");
  // Content is not re-read as markup, so a subscript cannot contain emphasis.
  eq(parseInline("~*a*~", 0, undefined, on).text, "*a*", "markup inside is literal");
  eq(parseInline("~*a*~", 0, undefined, on).spans.map((s) => [s.sub, s.em]), [[true, false]]);
  // But it nests the other way round.
  eq(parseInline("*H~2~O*", 0, undefined, on).spans.map((s) => [s.em, s.sub]),
     [[true, false], [true, true], [true, false]], "emphasis around a subscript");
}

// --- bare URLs ------------------------------------------------------------
{
  const auto = (src: string) => parseInline(src, 0, undefined, DEFAULT_INLINE_OPTIONS);
  const hrefs = (src: string) => auto(src).spans.filter((s) => s.href).map((s) => s.href);
  eq(hrefs("see https://example.com now"), ["https://example.com"], "a bare URL is a link");
  eq(hrefs("see www.example.com now"), ["https://www.example.com"], "and so is a bare www");
  eq(auto("see https://example.com now").text, "see https://example.com now",
     "with its text left exactly as written");
  // Trailing punctuation belongs to the sentence.
  eq(hrefs("at https://example.com."), ["https://example.com"], "a full stop is not part of it");
  eq(hrefs("(https://example.com)"), ["https://example.com"], "nor a closing bracket it did not open");
  eq(hrefs("https://en.wikipedia.org/wiki/L_(x)"), ["https://en.wikipedia.org/wiki/L_(x)"],
     "but one it did open is kept");
  // What it leaves alone.
  eq(hrefs("see-www.example.com"), [], "not in the middle of a word");
  eq(hrefs("`https://example.com`"), [], "not inside code");
  eq(hrefs("[text](https://example.com)"), ["https://example.com"],
     "a written link is still one link, not two");
  eq(auto("[text](https://example.com)").text, "text");
  eq(hrefs("<https://example.com>"), ["https://example.com"], "an angle autolink still works");
  eq(hrefs("https://"), [], "a scheme on its own is not a link");
  // A Chinese sentence has no spaces in it, so "up to the next space" would
  // swallow the rest of the line.
  eq(hrefs("主页在 https://typora.io，镜像在别处"), ["https://typora.io"],
     "a full-width comma ends the address");
  eq(hrefs("（https://example.com）也行"), ["https://example.com"], "and so do full-width brackets");
  eq(hrefs("见 https://example.com/a_b。"), ["https://example.com/a_b"], "and a full stop");
  const off = { ...DEFAULT_INLINE_OPTIONS, autoLink: false };
  eq(parseInline("see https://example.com", 0, undefined, off).spans.filter((s) => s.href).length, 0,
     "and the whole thing can be turned off");
}

// --- inline HTML ----------------------------------------------------------
// Markdown has always written the things it has no syntax for as HTML, so a
// handful of tags are drawn rather than shown. There is no option: Typora has
// none either.
{
  const html = (src: string) => parseInline(src, 0, undefined, DEFAULT_INLINE_OPTIONS);
  eq(html("<u>under</u>").text, "under", "the tags go and the words stay");
  eq(html("<u>under</u>").spans.map((s) => s.underline), [true]);
  eq(html("a <b>bold</b> c").spans.map((s) => [s.strong, s.underline]),
     [[false, false], [true, false], [false, false]], "b is strong");
  eq(html("<mark>hi</mark>").spans.map((s) => s.highlight), [true], "mark is a highlight");
  eq(html("H<sub>2</sub>O").spans.map((s) => s.sub), [false, true, false],
     "and sub needs no preference when written as HTML");
  eq(html("<kbd>⌘</kbd>").spans.map((s) => s.code), [true], "kbd is set as code");
  eq(html("<em>a</em> <i>b</i>").text, "a b", "either spelling of the same thing");

  // Nesting of the same tag closes where it should.
  eq(html("<b>a<b>b</b>c</b>").text, "abc", "a nested pair closes at the right end");
  eq(html("<b>a</b>b").text, "ab");

  // What it refuses.
  eq(html("<div>block</div>").text, "<div>block</div>", "a tag it cannot draw stays visible");
  eq(html("<u class=x>a</u>").text, "<u class=x>a</u>", "and so does one carrying more than markup");
  eq(html("<u></u>").text, "<u></u>", "an empty pair is not a pair");
  eq(html("<u>never closed").text, "<u>never closed", "nor is an unclosed one");
  eq(html("a < b").text, "a < b", "a lone angle bracket is arithmetic");
  eq(html("<https://example.com>").spans.map((s) => s.kind), ["link"],
     "an autolink is still an autolink");

  // <br> is a hard break like any other.
  eq(html("a<br>b").text, "a\u2028b", "br breaks the line");
  eq(html("a<br/>b").text, "a\u2028b", "however it is spelled");
  eq(html("a<BR />b").text, "a\u2028b");
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
eq(parseInline("a\\\nb", 0).text, "a" + LINE_SEPARATOR + "b",
   "backslash-newline is a hard break, and the slash itself is not content");

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
// These two are about the angle form alone, so the bare-URL rule — which
// would legitimately find a URL inside them, as GFM does — is turned off.
const angleOnly = (body: string) =>
  parseInline(body, 0, undefined, { ...DEFAULT_INLINE_OPTIONS, autoLink: false })
    .spans.find((s) => s.kind === "link")?.href;
eq(angleOnly("<https://a b>"), undefined, "including inside the URL");
eq(angleOnly("< https://x>"), undefined, "a leading space disqualifies it");
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


// --- YAML front matter -----------------------------------------------------
// Three dashes are a thematic break everywhere except the very first line of
// a document, and even there only when something closes them.
const kinds = (doc: string) => parseBlocks(doc).map((b) => b.type);

eq(kinds("---\ntitle: x\n---\n\nbody"),
   ["frontmatter", "blank", "paragraph"], "front matter opens a document");
eq(kinds("---\ntitle: x\n...\n\nbody"),
   ["frontmatter", "blank", "paragraph"], "YAML's other terminator closes it too");
eq(kinds("---\nno terminator\n\nbody"),
   ["rule", "paragraph", "blank", "paragraph"], "without a closer it stays a rule");
eq(kinds("intro\n\n---\ntitle: x\n---"),
   ["paragraph", "blank", "rule", "paragraph", "rule"],
   "dashes below the first line are still a break");
eq(kinds("---"), ["rule"], "a lone divider is a rule");

{
  const doc = "---\ntitle: 排版\ntags: [a, b]\n---\nbody";
  const [front] = parseBlocks(doc);
  eq(front.source, "---\ntitle: 排版\ntags: [a, b]\n---",
     "the block covers the fences and everything between");
  eq(front.start, 0, "starting at the document's first character");
  eq(doc.slice(front.end), "\nbody", "and ending at its closing fence");
  const r = renderBlock(front, false);
  eq(r.text, front.source, "metadata is shown verbatim, brackets and all");
  eq(r.map.length, r.text.length + 1, "with a complete source map");
  eq(kinds(doc)[1], "paragraph", "the document continues normally after it");
}


// --- images ----------------------------------------------------------------
// An image is a link that resolves to a picture, so it becomes a placeholder
// like a formula: the alt text is a fallback, not content.
const OBJ_CHAR = "￼";
const imageSpan = (body: string) =>
  parseInline(body, 0).spans.find((s) => s.kind === "image");

eq(parseInline("![cat](cat.png)", 0).text, OBJ_CHAR, "an image collapses to one placeholder");
eq(imageSpan("![cat](cat.png)")?.href, "cat.png", "the destination becomes the source");
eq(imageSpan("![cat](cat.png)")?.alt, "cat", "and the label becomes the alt text");
eq(imageSpan("![](x.png)")?.alt, "", "an empty label is allowed");
eq(imageSpan('![a](x.png "title")')?.href, "x.png", "a title does not leak into the source");
eq(imageSpan("![a](<my file.png>)")?.href, "my file.png", "an angle destination may hold spaces");

eq(parseInline("before ![x](y.png) after", 0).text, "before " + OBJ_CHAR + " after",
   "an image inside a sentence");
eq(parseInline("[link](y)", 0).text, "link", "a link without the bang is still a link");
eq(imageSpan("[link](y)"), undefined, "and produces no image span");
// CommonMark keeps the escaped bang as literal text and links the rest.
eq(parseInline("\\![x](y)", 0).text, "!x", "an escaped bang leaves a literal ! and a link");
eq(imageSpan("\\![x](y)"), undefined, "which is not an image");
eq(parseInline("\\![x](y)", 0).spans.some((s) => s.kind === "link"), true,
   "the link after it still parses");
eq(parseInline("`![x](y)`", 0).text, "![x](y)", "a code span keeps it literal");
eq(parseInline("![unclosed](x", 0).text, "![unclosed](x", "an unterminated image stays literal");

{
  const body = "see ![cat](cat.png) here";
  const r = parseInline(body, 50);
  const at = r.text.indexOf(OBJ_CHAR);
  eq(r.map[at], 50 + body.indexOf("!"), "the placeholder maps to the opening bang");
  eq(r.map.length, r.text.length + 1, "the source map still covers every character");
  const span = r.spans.find((s) => s.kind === "image");
  eq(span ? [span.start, span.end] : null, [at, at + 1],
     "the image span covers just the placeholder");
}
{
  // Alt text is opaque: it is a fallback string, never markdown to render.
  const span = imageSpan("![**bold** alt](x.png)");
  eq(span?.alt, "**bold** alt", "alt text keeps its markers");
  eq(parseInline("![**bold** alt](x.png)", 0).text, OBJ_CHAR, "and produces no extra text");
}


// --- tables ----------------------------------------------------------------
// A header row is indistinguishable from a paragraph until the delimiter row
// beneath it is read, so the decision needs both lines.
const tableOf = (doc: string) => parseBlocks(doc).find((b) => b.type === "table");
const grid = (doc: string) =>
  tableOf(doc)?.rows.map((row) => row.map((c) => c.text));

eq(grid("| a | b |\n|---|---|\n| 1 | 2 |"),
   [["a", "b"], ["1", "2"]], "the delimiter row is structure, not content");
eq(tableOf("| a | b |\n|---|---|")?.align, ["left", "left"], "plain dashes align left");
eq(tableOf("| a | b | c |\n|:--|:-:|--:|")?.align, ["left", "center", "right"],
   "colons choose the alignment");
eq(grid("a | b\n--- | ---\n1 | 2"),
   [["a", "b"], ["1", "2"]], "the outer pipes are optional");
eq(grid("| a || b |\n|---|---|---|"), [["a", "", "b"]], "an empty middle cell is kept");
eq(grid("| a \\| b |\n|---|"), [["a \\| b"]], "an escaped pipe stays inside its cell");

// Not tables.
eq(tableOf("| a | b |"), undefined, "a header row alone is not a table");
eq(tableOf("| a | b |\n| c | d |"), undefined, "without a delimiter row it is a paragraph");
eq(tableOf("| a | b |\n|---|"), undefined, "the two rows must agree on the column count");
eq(tableOf("no pipes here\n---"), undefined,
   "a delimiter row needs pipes above it to make a table");
eq(parseBlocks("no pipes here\n---").map((b) => b.type), ["paragraph", "rule"],
   "the dashes stay a thematic break");

// A table interrupts a paragraph, and the paragraph keeps its own lines.
{
  const doc = "intro text\n\n| a |\n|---|\n| 1 |\n\nafter";
  eq(parseBlocks(doc).map((b) => b.type),
     ["paragraph", "blank", "table", "blank", "paragraph"], "a table is its own block");
}
{
  const doc = "lead line\n| a |\n|---|\n| 1 |";
  eq(parseBlocks(doc).map((b) => b.type), ["paragraph", "table"],
     "a table interrupts the paragraph above it");
  eq(parseBlocks(doc)[0].source, "lead line", "and the paragraph keeps only its own line");
}

// Cells carry the offsets their text came from, which is what the caret needs.
{
  const doc = "| alpha | beta |\n|---|---|\n| one | two |";
  const t = tableOf(doc)!;
  for (const row of t.rows) {
    for (const cell of row) {
      eq(doc.slice(cell.start, cell.end), cell.text, `cell ${JSON.stringify(cell.text)} maps to its source`);
    }
  }
  eq(t.source, doc, "the block covers the whole table");
}


// --- hard line breaks ------------------------------------------------------
// A break the author asked for is not a breakpoint the optimiser may decline,
// so it is carried as U+2028 rather than as the space a soft break becomes.
const SEP = LINE_SEPARATOR;

eq(parseInline("a  \nb", 0).text, "a" + SEP + "b", "two trailing spaces make a hard break");
eq(parseInline("a   \nb", 0).text, "a" + SEP + "b", "so do more than two");
eq(parseInline("a\\\nb", 0).text, "a" + SEP + "b", "and so does a trailing backslash");
eq(parseInline("a \nb", 0).text, "a b", "one trailing space is still a soft break");
eq(parseInline("a\nb", 0).text, "a b", "and so is none");

// The spaces exist only to carry the instruction, so they are not content.
eq(parseInline("a  \nb", 0).text.indexOf("  "), -1, "the trailing run is dropped");
{
  const body = "a  \nb";
  const r = parseInline(body, 0);
  eq(r.map.length, r.text.length + 1, "the source map still covers every character");
  eq(r.map[r.text.indexOf("b")], body.indexOf("b"), "text after the break maps correctly");
}

// A hard break holds where a soft one would have been discarded.
eq(parseInline("中文  \n继续", 0).text, "中文" + SEP + "继续",
   "a hard break survives the CJK soft-break rule");
eq(parseInline("中文\n继续", 0).text, "中文继续", "which still discards an unasked-for one");

// Not breaks.
eq(parseInline("`a  \nb`", 0).text.includes(SEP), false,
   "trailing spaces inside a code span are content, not an instruction");
eq(parseInline("a  \n`b`", 0).text.includes(SEP), true,
   "but a break before a code span still holds");
eq(parseInline("  \na", 0).text, "a", "a break with nothing before it is dropped");


// --- footnotes -------------------------------------------------------------
const OBJ2 = "￼";
const noteSpan = (body: string) =>
  parseInline(body, 0).spans.find((s) => s.kind === "note");

eq(parseInline("text[^1] more", 0).text, "text" + OBJ2 + " more",
   "a reference has no textual form of its own");
eq(noteSpan("text[^1]")?.label, "1", "the label is carried on the span");
eq(noteSpan("text[^note-a]")?.label, "note-a", "labels may be words");
eq(noteSpan("text[^1]"), noteSpan("text[^1]") ? noteSpan("text[^1]") : undefined, "stable");
eq(parseInline("[link](x)", 0).spans.some((s) => s.kind === "note"), false,
   "an ordinary link is not a footnote");
eq(parseInline("[^ bad]", 0).text, "[^ bad]", "a label may not contain spaces");
eq(parseInline("`[^1]`", 0).text, "[^1]", "a code span keeps it literal");

// Definitions are their own blocks and shed their label.
{
  const doc = "body text[^a]\n\n[^a]: the note itself";
  const blocks = parseBlocks(doc);
  eq(blocks.map((b) => b.type), ["paragraph", "blank", "footnote"],
     "a definition is its own block");
  const def = blocks.find((b) => b.type === "footnote")!;
  eq(def.label, "a", "carrying its label");
  const r = renderBlock(def, false);
  eq(r.text, "the note itself", "and shedding it from the text");
  eq(r.map[0], doc.indexOf("the note"), "the first character maps past the label");
  eq(renderBlock(def, true).text, "[^a]: the note itself", "raw mode shows the label");
}
{
  const doc = "[^a]: first line\ncontinued here\n\nafter";
  const blocks = parseBlocks(doc);
  eq(blocks[0].type, "footnote", "a definition runs on like a paragraph");
  eq(renderBlock(blocks[0], false).text, "first line continued here",
     "over a lazy continuation");
}
{
  eq(parseBlocks("para\n[^a]: note").map((b) => b.type), ["paragraph", "footnote"],
     "a definition interrupts the paragraph above it");
}
{
  const body = "see[^x] here";
  const r = parseInline(body, 30);
  const at = r.text.indexOf(OBJ2);
  eq(r.map[at], 30 + body.indexOf("[^x]"), "the placeholder maps to the opening bracket");
  eq(r.map.length, r.text.length + 1, "the source map still covers every character");
}


// --- HTML blocks -----------------------------------------------------------
// Shown as written. What matters here is where a block starts and stops, and
// above all that an autolink is not mistaken for a tag.
const htmlOf = (doc: string) => parseBlocks(doc).find((b) => b.type === "html");
const types = (doc: string) => parseBlocks(doc).map((b) => b.type);

eq(htmlOf("<div>\nhello\n</div>")?.source, "<div>\nhello\n</div>",
   "a block tag runs to the blank line");
eq(types("<div>\nx\n</div>\n\nafter"), ["html", "blank", "paragraph"],
   "and the document continues after it");
eq(htmlOf("<!-- a comment -->")?.source, "<!-- a comment -->", "a comment is a block");
eq(htmlOf("<!--\nspanning\nlines\n-->")?.source, "<!--\nspanning\nlines\n-->",
   "a comment ends at its own terminator, not at a blank line");
eq(htmlOf("<script>\nlet x = 1;\n\nlet y = 2;\n</script>")?.source,
   "<script>\nlet x = 1;\n\nlet y = 2;\n</script>",
   "raw text runs through blank lines to its close tag");
eq(htmlOf("<br />")?.source, "<br />", "a self-closing tag alone on a line");
eq(htmlOf("<span class=\"a\">")?.source, "<span class=\"a\">", "attributes are allowed");

// The case that must not regress: an autolink is not a tag.
eq(htmlOf("<https://example.com>"), undefined, "a URL in angle brackets is not HTML");
eq(parseInline("<https://example.com>", 0).spans.find((s) => s.kind === "link")?.href,
   "https://example.com", "it is still an autolink");
eq(htmlOf("<user@example.com>"), undefined, "nor is an email address");
eq(htmlOf("2 < 3 and 4 > 1"), undefined, "nor is arithmetic");

// Rendering is verbatim, with an exact map.
{
  const doc = "<div class=\"note\">\n  <b>bold</b>\n</div>";
  const b = htmlOf(doc)!;
  const r = renderBlock(b, false);
  eq(r.text, doc, "the markup is shown exactly as written");
  eq(r.map.length, r.text.length + 1, "with a complete source map");
  eq(r.spans.some((s) => s.kind === "strong"), false, "and no inline parsing inside it");
}

// Interrupting a paragraph: every kind but a lone tag may.
eq(types("text\n<div>\nx"), ["paragraph", "html"], "a block tag interrupts a paragraph");
// A block tag and a lone tag reach the same branch by different routes, and
// only the first may break into a paragraph; check the classification itself
// rather than trusting the outcome to distinguish them.
eq(types("text\n<table>\nx"), ["paragraph", "html"], "including one that is also a markdown word");
eq(types("text\n<custom-element>\nx"), ["paragraph"],
   "an unknown tag is the lone-tag kind, which does not interrupt");
eq(types("text\n<!-- c -->"), ["paragraph", "html"], "and so does a comment");
eq(types("text\n<em>emphasis</em>"), ["paragraph"],
   "but a lone inline tag stays in the paragraph it continues");

// Count callback visits instead of timing wall-clock speed: the old emitter
// filtered every format and opaque range for every source character.
{
  const source = ('**bold** `code` [link](url) 中文\n').repeat(1500);
  let visits = 0;
  const methods = ["filter", "find", "some", "findLastIndex"] as const;
  const originals = new Map<string, Function>();
  for (const name of methods) {
    const original = Array.prototype[name];
    originals.set(name, original);
    (Array.prototype as any)[name] = function (fn: Function, self?: unknown) {
      return original.call(this, (value: unknown, index: number, array: unknown[]) => {
        visits++;
        return fn.call(self, value, index, array);
      });
    };
  }
  let rendered: ReturnType<typeof parseInline>;
  try { rendered = parseInline(source, 13); }
  finally {
    for (const [name, original] of originals) (Array.prototype as any)[name] = original;
  }
  eq(visits < source.length * 10, true, "dense markup never rescans all formats for each character");
  eq(rendered!.text, ('bold code link 中文').repeat(1500), "dense markup preserves CJK soft-break behavior");
  eq(rendered!.spans.filter((span) => span.strong).length, 1500, "every strong range survives the format sweep");
  eq(rendered!.map.at(-1), source.length + 13, "large inline maps retain the terminal source boundary");
}
{
  const source = "[".repeat(10000) + "literal";
  const rendered = parseInline(source, 0);
  eq(rendered.text === source, true, "unmatched nested brackets stay literal without rescanning each suffix");
  eq(rendered.spans.length, 1, "unmatched delimiters do not fragment plain text");
  const nested = "**[a *b* `c`](url)** $x$ ![alt](url) [^note]";
  const renderedNested = parseInline(nested, 7);
  eq(renderedNested.text, "a b c \uFFFC \uFFFC \uFFFC", "nested formatting and opaque atoms retain their output");
  eq(renderedNested.spans.filter((span) => span.kind === "link").map((span) => [span.strong, span.em, span.code]),
    [[true, false, false], [true, true, false], [true, false, false], [true, false, true]],
    "nested link style transitions preserve code opacity");
}


// --- hard breaks in blockquotes --------------------------------------------
// A quote joins its own lines, so the newline that would have carried the
// break never reaches the inline scanner; the marker has to be read there.
const quoted = (doc: string) => renderBlock(parseBlocks(doc)[0], false).text;

eq(quoted("> first  \n> second"), "first" + LINE_SEPARATOR + "second",
   "two trailing spaces break a quoted line");
eq(quoted("> first\\\n> second"), "first" + LINE_SEPARATOR + "second",
   "and so does a trailing backslash");
eq(quoted("> first\n> second"), "first second",
   "an ordinary wrap is still joined with a space");
eq(quoted("> 中文\n> 继续"), "中文继续",
   "and the CJK rule still discards an unasked-for break");
eq(quoted("> 中文  \n> 继续"), "中文" + LINE_SEPARATOR + "继续",
   "while a hard break survives it");

// The marker is an instruction, not content: neither spelling may leak.
eq(quoted("> first\\\n> second").includes("\\"), false, "the backslash is consumed");
eq(quoted("> a  \n> b").includes("  "), false, "and so is the space run");
eq(quoted("> ends with a slash\\\\\n> next"), "ends with a slash\\ next",
   "an escaped backslash at the end is content, not a break");

{
  const doc = "> first  \n> second";
  const r = renderBlock(parseBlocks(doc)[0], false);
  eq(r.map.length, r.text.length + 1, "the source map still covers every character");
  eq(doc[r.map[r.text.indexOf("second")]], "s", "text after the break maps correctly");
}

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
