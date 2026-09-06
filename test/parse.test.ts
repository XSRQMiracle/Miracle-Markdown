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

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
