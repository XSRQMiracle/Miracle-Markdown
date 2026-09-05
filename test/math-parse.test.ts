// Where a formula starts and stops. Every markdown implementation answers
// this differently, which is why both a strict and a lenient rule exist here
// rather than one "correct" one.
import {
  parseBlocks,
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
eq(formulas("$x = \\$5$"), ["x = \\$5"], "an escaped dollar inside math does not close it");

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

// --- the focused block still shows its source -----------------------------
{
  const doc = "a $x$ b";
  const [b] = parseBlocks(doc);
  eq(renderBlock(b, true).text, doc, "raw mode shows the delimiters");
  eq(renderBlock(b, false).text, "a " + OBJ + " b", "typeset mode shows the placeholder");
}

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
