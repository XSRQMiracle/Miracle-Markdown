// Where a formula starts and stops. Every markdown implementation answers
// this differently, which is why both a strict and a lenient rule exist here
// rather than one "correct" one.
import {
  parseBlocks,
  blockIndexAtPosition,
  renderBlock,
  parseInline,
  OBJECT_REPLACEMENT as OBJ,
  DEFAULT_INLINE_OPTIONS,
  type InlineOptions,
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

const strict: InlineOptions = { ...DEFAULT_INLINE_OPTIONS, strictDollar: true };
const loose: InlineOptions = { ...DEFAULT_INLINE_OPTIONS, strictDollar: false };

/** The formulas a body parses into, in order. */
const formulas = (body: string, opts = strict) =>
  parseInline(body, 0, undefined, opts)
    .spans.filter((s) => s.kind === "math")
    .map((s) => (s.display ? "[[" + s.math + "]]" : s.math));

const rendered = (body: string, opts = strict) => parseInline(body, 0, undefined, opts).text;

// --- the case every implementation is judged on ---------------------------
eq(formulas("it costs $5 and $10 total"), [], "a price is not a formula");
eq(rendered("it costs $5 and $10 total"), "it costs $5 and $10 total", "the price survives verbatim");
eq(formulas("$x$"), ["x"], "a bare formula");
eq(formulas("$x + y$"), ["x + y"], "a formula containing spaces");
eq(formulas("mass $E = mc^2$ here"), ["E = mc^2"], "a formula inside a sentence");

// --- strict adjacency -----------------------------------------------------
eq(formulas("$ x $"), [], "strict rejects a space after the opening delimiter");
eq(formulas("$ x $", loose), [" x "], "lenient accepts it");
eq(formulas("$x $y$"), ["x $y"], "strict skips a closer preceded by a space");
eq(formulas("$5-$3"), [], "strict rejects a closer followed by a digit");
eq(formulas("$5-$3", loose), ["5-"], "lenient takes the first closer it finds");

// --- placeholders and the source map --------------------------------------
eq(rendered("a $x$ b"), "a " + OBJ + " b", "a formula becomes one placeholder");
{
  const r = parseInline("a $x+y$ b", 0, undefined, strict);
  const at = r.text.indexOf(OBJ);
  eq(r.map[at], 2, "the placeholder maps to the opening delimiter");
  eq(r.map[r.text.length - 1], 8, "text after the formula still maps correctly");
  const span = r.spans.find((s) => s.kind === "math");
  eq(span ? [span.start, span.end] : null, [at, at + 1], "the math span covers just the placeholder");
}

// --- display math ---------------------------------------------------------
eq(formulas("see $$x^2$$ here"), ["[[x^2]]"], "double dollars are display math anywhere");
eq(formulas("\\(a+b\\)"), ["a+b"], "TeX inline delimiters");
eq(formulas("\\[a+b\\]"), ["[[a+b]]"], "TeX display delimiters");
eq(formulas("\\(x \\\\) y\\)"), ["x \\\\) y"], "an escaped TeX closer is skipped");
eq(
  formulas("$x$", { ...strict, inlineMath: false }),
  [],
  "dollar math can be turned off entirely",
);
eq(
  formulas("\\(a\\)", { ...strict, texDelimiters: false }),
  [],
  "TeX delimiters can be turned off entirely",
);

// --- math is opaque to markdown -------------------------------------------
eq(formulas("$a * b * c$"), ["a * b * c"], "asterisks inside math are not emphasis");
eq(formulas("$a_1 + b_2$"), ["a_1 + b_2"], "underscores inside math are not emphasis");
eq(rendered("$a*b*c$"), OBJ, "no emphasis leaks out of a formula");

// --- escaping -------------------------------------------------------------
eq(formulas("\\$x\\$"), [], "escaped dollars do not open math");
eq(rendered("\\$x\\$"), "$x$", "escaped dollar delimiters remain visible literally");
eq(formulas("$x = \\$5$"), ["x = \\$5"], "an escaped dollar inside math does not close it");
eq(formulas(String.raw`\\$x$`), ["x"], "an even slash run leaves a dollar opener active");
eq(rendered(String.raw`\\$x$`), "\\" + OBJ, "the escaped slash before dollar math remains literal");
eq(formulas(String.raw`\\(x\\)`), [], "escaped TeX opener does not start math");
eq(rendered(String.raw`\\(x\\)`), String.raw`\(x\)`, "escaped TeX delimiters remain literal");
eq(rendered(String.raw`\alpha outside math`), String.raw`\alpha outside math`,
   "a TeX-like command outside math keeps its slash");
eq(rendered("`\\$x\\$`"), "\\$x\\$", "code spans keep escaped-looking math delimiters opaque");

// --- blocks ---------------------------------------------------------------
{
  const doc = "before\n\n$$\nE = mc^2\n$$\n\nafter";
  const types = parseBlocks(doc).map((b) => b.type);
  eq(types.includes("math"), true, "a fenced display block is its own block");
  const m = parseBlocks(doc).find((b) => b.type === "math");
  eq(m ? m.math.trim() : null, "E = mc^2", "the block carries its LaTeX without delimiters");
}
{
  const doc = "```math\n\\int_0^1 x\\,dx\n```";
  const m = parseBlocks(doc).find((b) => b.type === "math");
  eq(m ? m.math.trim() : null, "\\int_0^1 x\\,dx", "a fence tagged math is display math");
}
{
  const doc = "```js\nlet x = 1\n```";
  eq(parseBlocks(doc)[0].type, "code", "an ordinary fence is still code");
}
{
  const doc = "text\n$$\nx\n$$";
  eq(parseBlocks(doc).map((b) => b.type), ["paragraph", "math"], "display math interrupts a paragraph");
}
{
  const doc = "$$ x + y $$";
  const m = parseBlocks(doc).find((b) => b.type === "math");
  eq(m ? m.math.trim() : null, "x + y", "a one-line display block");
}
{
  const doc = "$$\nx\n$$";
  const options = { ...strict, inlineMath: false };
  const blocks = parseBlocks(doc, options);
  eq(blocks.map((b) => b.type), ["paragraph"], "disabling dollar math also disables dollar blocks");
  eq(blocks[0].source, doc, "disabled dollar block syntax remains source text");
}
{
  const doc = "\\[\nx\n\\]";
  const options = { ...strict, texDelimiters: false };
  const blocks = parseBlocks(doc, options);
  eq(blocks.map((b) => b.type), ["paragraph"], "disabling TeX delimiters also disables TeX blocks");
  eq(blocks[0].source, doc, "disabled TeX block syntax remains source text");
}
{
  const doc = "```math\nx\n```";
  const options = { ...strict, inlineMath: false, texDelimiters: false };
  eq(parseBlocks(doc, options)[0].type, "math", "an explicit math fence is independent of delimiters");
}
{
  const doc = "$$x$$ trailing";
  const [b] = parseBlocks(doc);
  const r = renderBlock(b, false);
  eq(b.type, "paragraph", "a one-line formula with a suffix remains a paragraph");
  eq(r.text, OBJ + " trailing", "text after a one-line display formula is preserved");
  eq(Array.from(r.map), [0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], "its source map reaches the suffix");
}
{
  const doc = "before\n$$x$$ trailing\nafter";
  const blocks = parseBlocks(doc);
  eq(blocks.map((b) => b.type), ["paragraph"], "a suffixed formula does not interrupt a paragraph");
  eq(blocks[0].source, doc, "the surrounding paragraph remains contiguous");
}
{
  const doc = "\\[x\\] trailing";
  const [b] = parseBlocks(doc);
  eq(renderBlock(b, false).text, OBJ + " trailing", "text after TeX display delimiters is preserved");
}
{
  const doc = "$$\nx\n$$ trailing\ncontinued";
  const blocks = parseBlocks(doc);
  eq(blocks.map((b) => b.type), ["math", "paragraph"], "a multiline closer can be followed by a paragraph");
  eq(blocks[0].source, "$$\nx\n$$", "the formula ends exactly at its closer");
  eq(blocks[1].source, " trailing\ncontinued", "the suffix keeps its continuation line");
  eq(blockIndexAtPosition(blocks, blocks[1].start), 1, "the shared caret boundary belongs to the suffix");
  eq(renderBlock(blocks[1], false).text, " trailing continued", "the suffix renders without data loss");
}
{
  const doc = "  $$ x $$  ";
  const [b] = parseBlocks(doc);
  eq(b.source, doc, "trailing block whitespace stays in the raw source range");
}
{
  const doc = "$$\nx \\$$ y\n$$";
  const [b] = parseBlocks(doc);
  eq(b.math.trim(), "x \\$$ y", "an escaped delimiter does not close a math block");
}
{
  const doc = "$$\nx \\$$$ tail";
  const blocks = parseBlocks(doc);
  eq(blocks.map((b) => b.type), ["math", "paragraph"], "overlapping dollar runs find a later closer");
  eq(blocks[0].math.trim(), "x \\$", "only the escaped dollars remain in the formula");
  eq(blocks[1].source, " tail", "text after the overlapping closer is preserved");
}

// --- the focused block still shows its source -----------------------------
{
  const doc = "a $x$ b";
  const [b] = parseBlocks(doc);
  eq(renderBlock(b, true).text, doc, "raw mode shows the delimiters");
  eq(renderBlock(b, false).text, "a " + OBJ + " b", "typeset mode shows the placeholder");
}


// ---------------------------------------------------------------------------
// Soft line breaks in CJK text.
//
// CommonMark turns a newline inside a paragraph into a space. That is right
// for scripts that separate words with one and wrong for Chinese and Japanese,
// where a break in the source is only how the author wrapped the file — and
// the stray space it leaves is the most familiar complaint about writing
// Chinese in Markdown.
// ---------------------------------------------------------------------------

const cjkOn = { ...strict, softBreak: "smart" as const };
const cjkOff = { ...strict, softBreak: "space" as const };
const literal = { ...strict, softBreak: "break" as const };

eq(rendered("中文一行\n中文二行", cjkOn), "中文一行中文二行", "a break between Han characters vanishes");
eq(rendered("中文一行\n中文二行", cjkOff), "中文一行 中文二行", "and becomes a space when the rule is off");
eq(rendered("结束。\n开始", cjkOn), "结束。开始", "a break after CJK punctuation vanishes too");
eq(rendered("意思；\n继续", cjkOn), "意思；继续", "including the fullwidth semicolon");

// Latin text still needs its space — this is the case the rule must not break.
eq(rendered("one two\nthree four", cjkOn), "one two three four", "Latin keeps its space");
eq(rendered("end.\nStart", cjkOn), "end. Start", "including across a sentence boundary");

// Typora's own default is the third answer: the newline is a line break, and
// the paragraph is laid out the way it was typed.
eq(rendered("中文一行\n中文二行", literal), "中文一行\u2028中文二行", "or the break is kept as one");
eq(rendered("one two\nthree", literal), "one two\u2028three", "in Latin as well");

// A boundary with CJK on one side only. Dropping the break is right here
// because the quarter em of mixed-script spacing is inserted separately; a
// space as well would read as a mistake.
eq(rendered("中文\nEnglish", cjkOn), "中文English", "CJK then Latin: the break goes, spacing handles it");
eq(rendered("English\n中文", cjkOn), "English中文", "and Latin then CJK");
eq(rendered("中文\nEnglish", cjkOff), "中文 English", "unless the rule is off");

// An explicit space the author typed is theirs to keep.
eq(rendered("中文 \nEnglish", cjkOn), "中文 English", "a trailing space survives the dropped break");

// The break is judged on what survives into the output, not on the raw
// source: a delimiter or a formula may sit between.
eq(rendered("的意思；\n`code` 继续", cjkOn), "的意思；code 继续", "a code span after the break");
eq(rendered("的意思；\n**粗体**", cjkOn), "的意思；粗体", "an emphasis marker after the break");
eq(rendered("公式是\n$x$ 这样", cjkOn), "公式是" + OBJ + " 这样", "a formula after the break");
eq(rendered("**中文**\n继续", cjkOn), "中文继续", "an emphasis marker before the break");

// The map must still line up after a break is dropped.
{
  const r = parseInline("中文\n继续", 0, undefined, cjkOn);
  eq(r.text, "中文继续", "text");
  eq(Array.from(r.map), [0, 1, 3, 4, 5], "every character still maps to its own source position");
}

// Blockquotes join their lines the same way.
{
  const [b] = parseBlocks("> 引用第一行\n> 引用第二行");
  eq(renderBlock(b, false, cjkOn).text, "引用第一行引用第二行", "a quote joins CJK lines without a space");
  eq(renderBlock(b, false, cjkOff).text, "引用第一行 引用第二行", "and with one when the rule is off");
}
{
  const [b] = parseBlocks("> first line\n> second line");
  eq(renderBlock(b, false, cjkOn).text, "first line second line", "a Latin quote keeps its space");
}


// A continuation line's indentation is the shape of the file, not content.
eq(rendered("one two\n    three four", cjkOn), "one two three four", "leading indent is stripped");
eq(rendered("中文一行\n    中文二行", cjkOn), "中文一行中文二行", "and stripped in CJK too");
eq(rendered("中文 \n  English", cjkOn), "中文 English", "one space, however it was written");
eq(rendered("a\n\nb", cjkOn), "a b", "consecutive breaks collapse to one space");

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
