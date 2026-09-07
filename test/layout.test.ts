// Exercise the real WASM bridge with deterministic canvas measurements. The
// synthetic shaper includes kerning so cross-paint-boundary measurements fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initSync } from "../crates/typeset-wasm/pkg/typeset_wasm.js";
import { DEFAULT_OPTIONS, DEFAULT_THEME, initEngine, Typesetter } from "../src/engine/typeset.js";
import { Editor } from "../src/editor/editor.js";
import { EMPTY_GEOMETRY } from "../src/engine/math.js";

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
            (c === " " ? (code ? 9 : 4) : (bold ? 12 : 10)), 0) -
            (text.includes("AV") ? 3 : 0);
          return { width, fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 4 };
        },
      }),
    }),
  },
});
initSync({ module: readFileSync("crates/typeset-wasm/pkg/typeset_wasm_bg.wasm") });
await initEngine();
const typesetter = new Typesetter({ ...DEFAULT_THEME }, {
  ...DEFAULT_OPTIONS, inline: { ...DEFAULT_OPTIONS.inline }, justify: false, protrusion: false,
});
await typesetter.ready;
const layout = (source: string) => typesetter.layoutDocument(source, 1000, -1).blocks[0];
const runs = (source: string) => layout(source).lines.flatMap((line) => line.runs);

assert.deepEqual(runs("x**y**z").map((r) => [r.text, r.style.weight]),
  [["x", 400], ["y", 700], ["z", 400]]);
assert.deepEqual(runs("[a](/)b").map((r) => [r.text, r.style.color]),
  [["a", DEFAULT_THEME.accentColor], ["b", DEFAULT_THEME.color]]);
assert.deepEqual(runs("a[b](/)").map((r) => [r.text, r.style.color]),
  [["a", DEFAULT_THEME.color], ["b", DEFAULT_THEME.accentColor]]);
const colored = layout("A[V](/)").lines[0];
assert.deepEqual(colored.runs.map((r) => [r.text, r.x + 0]), [["A", 0], ["V", 10]]);
assert.equal(colored.width, 20, "separately painted spans must not borrow whole-word kerning");
assert.equal(runs("extraordinary").length, 1, "unbroken syllables within one span still coalesce");
assert.deepEqual(runs("😀**é**z").map((r) => [r.text, r.docStart]),
  [["😀", 0], ["é", 4], ["z", 7]]);
assert.deepEqual(runs("e\u0301**x**").map((r) => r.text), ["e\u0301", "x"]);
assert.equal(layout("`a b`").lines[0].width, 29, "code-space measurement reaches the core");

// A separate deterministic shaper makes punctuation narrower than letters
// and kerns it against its neighbours. Exercise the real measurement -> WASM
// -> coalescing path, including styled discretionary hyphens.
const optical = new Typesetter({ ...DEFAULT_THEME }, {
  ...DEFAULT_OPTIONS, inline: { ...DEFAULT_OPTIONS.inline }, justify: false,
  protrusion: true, maxExpand: 0,
});
(optical as any).measurer.width = (text: string, style: { weight: number }) => {
  const bold = style.weight === 700;
  return Array.from(text).reduce((width, c) => width +
    (c === '"' || c === "“" || c === "”" ? 4 : c === "." ? 2 :
      c === "-" ? (bold ? 13 : 7) : c === " " ? 4 : (bold ? 12 : 10)), 0) -
    (text.includes('"H') || text.includes("“H") ? 1 : 0) -
    (text.includes("o.") ? 0.5 : 0);
};
for (const source of ['"Hello.', "“Hello.”", "Hello."]) {
  const line = optical.layoutDocument(source, 1000, -1).blocks[0].lines[0];
  assert.equal(line.runs.length, 1, "punctuation tokens rejoin to preserve platform kerning");
  const run = line.runs[0];
  assert.equal(run.text, source);
  assert.equal(run.x + 0, source === "Hello." ? 0 : -2, "only half the opening quote hangs");
  assert.ok(Math.abs(line.width - (run.x + optical.measureText(run.text, run.style, run.styleKey))) < 0.0001,
    "kerned punctuation and text reserve precisely their drawn width");
}
const opticalStyled = optical.layoutDocument('"**Hello**.', 1000, -1).blocks[0].lines[0];
assert.deepEqual(opticalStyled.runs.map((r) => [r.text, r.style.weight]),
  [['"', 400], ["Hello", 700], [".", 400]], "punctuation cannot erase style boundaries");
assert.equal(opticalStyled.width, 64, "separately drawn styles do not borrow punctuation kerning");
for (const source of ["extraordinary", "**extraordinary**"]) {
  const lines = optical.layoutDocument(source, 80, -1).blocks[0].lines;
  const inserted = lines.filter((line) => line.runs.at(-1)?.synthetic);
  assert.ok(inserted.length > 0, "a narrow word exercises discretionary hyphens");
  for (const line of inserted) {
    const hyphen = line.runs.at(-1)!;
    const measured = optical.measureText("-", hyphen.style, hyphen.styleKey);
    assert.equal(measured, source.startsWith("**") ? 13 : 7);
    assert.ok(Math.abs(line.width - hyphen.x - measured * hyphen.scaleX) < 0.0001,
      "the inserted hyphen reserves the measured width of its actual font");
  }
}
assert.equal(optical.layoutDocument('"short."', 20, -1).blocks[0].lines.length, 1,
  "measuring punctuation separately never creates punctuation-only lines");
const math = runs("a$x$**b**");
assert.equal(math.at(-1)?.text, "b");
assert.equal(math.at(-1)?.style.weight, 700);
assert.equal(math.at(-1)?.docStart, 6);
for (const source of ["$$\nx+1\n$$", "---", "a\nb", "> quote", "- item"]) {
  const block = typesetter.layoutDocument(source, 1000, 0).blocks[0];
  assert.equal(block.raw, true);
  assert.equal(block.indent, 0);
  assert.equal(block.marker, "");
  assert.deepEqual(block.lines.map((line) => line.runs.map((r) => r.text).join("")), source.split("\n"));
  assert.ok(block.lines.flatMap((line) => line.runs).every((r) => !r.math));
}
for (const source of ["", "\n", "a\n", "a\n\nb", "\n\n\n", "$$\nx\n$$", "---", "```\na\n\nb\n```", "a\nb"]) {
  const editor = Object.create(Editor.prototype) as any;
  editor.typesetter = typesetter;
  editor.text = source;
  for (let position = 0; position <= source.length; position++) {
    editor.blocks = typesetter.layoutDocument(source, 1000, position).blocks;
    const found = editor.locate(position);
    assert.ok(found && Number.isFinite(found.x), `${JSON.stringify(source)} has a caret at ${position}`);
    assert.equal(editor.offsetInLine(found.block, found.line, found.x), position,
      `physical source lines round trip at ${position} in ${JSON.stringify(source)}`);
  }
}
const emptyLines = typesetter.layoutDocument("a\n\nb\n", 1000, -1).blocks.flatMap((b) => b.lines);
assert.deepEqual(emptyLines.map((line) => [line.docStart, line.docEnd]), [[0, 1], [2, 2], [3, 4], [5, 5]]);
assert.deepEqual(runs("````\na\n```").map((r) => r.text), ["a", "```"]);
assert.deepEqual(runs("```\na\n```not-close").map((r) => r.text), ["a", "```not-close"]);
assert.deepEqual(runs("~~~\na\n~~~~").map((r) => r.text), ["a"]);

// Source layout keeps every character and physical newline, while fitting
// ordinary words and even an unbroken URL into the editing column.
const longSource = "long paragraph ".repeat(30) + "\n" + "x".repeat(70) + "  end";
const narrow = typesetter.layoutDocument(longSource, 240, 0).blocks[0];
assert.ok(narrow.lines.length > 2, "focused source soft-wraps inside physical lines");
assert.ok(narrow.lines.every((line) => line.width <= 240), "source remains inside the editing column");
assert.equal(narrow.lines.map((line) => longSource.slice(line.docStart, line.docEnd)).join(""),
  longSource.replaceAll("\n", ""), "soft wraps preserve whitespace and all source characters");
assert.ok(narrow.lines.some((line) => longSource[line.docEnd] === "\n"), "physical LF still ends a visual line");
for (const line of narrow.lines) {
  assert.equal(line.runs.map((run) => run.text).join(""), longSource.slice(line.docStart, line.docEnd));
}
for (const source of ["# " + "heading ".repeat(15), "> " + "quote ".repeat(20),
  "- " + "list ".repeat(25), "$$\n" + "x + y ".repeat(25) + "\n$$",
  "```\n" + "function ".repeat(25) + "\n```", "😀e\u0301👨‍👩‍👧‍👦中".repeat(20)]) {
  const raw = typesetter.layoutDocument(source, 240, 0).blocks[0];
  const boundaries = new Set([source.length, ...Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(source), (s) => s.index,
  )]);
  assert.ok(raw.lines.every((line) => line.width <= 240));
  assert.ok(raw.lines.every((line) => boundaries.has(line.docStart) && boundaries.has(line.docEnd)),
    "soft wrapping never splits a grapheme");
  assert.equal(raw.lines.flatMap((line) => line.runs.map((run) => run.text)).join(""), source.replaceAll("\n", ""));
}

const editable = (source: string, position = 0) => {
  const editor = Object.create(Editor.prototype) as any;
  Object.assign(editor, {
    typesetter, text: source, selStart: position, selEnd: position,
    caretAffinity: "downstream", preferredX: null, hasFocus: true, interacted: true,
    scrollTop: 0, host: { clientWidth: 336, clientHeight: 10000 },
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    schedule() {},
  });
  editor.relayout();
  return editor;
};
const wrappedEditor = editable(longSource);
for (let position = 0; position <= longSource.length; position++) {
  const found = wrappedEditor.locate(position);
  assert.ok(found && found.x <= 240, `source caret ${position} is visible`);
  assert.equal(wrappedEditor.offsetInLine(found.block, found.line, found.x), position);
}
const visualLines = wrappedEditor.blocks[0].lines;
for (let i = 1; i < visualLines.length; i++) {
  wrappedEditor.moveVertical(1, false);
  assert.equal(wrappedEditor.locate(wrappedEditor.selEnd).line, visualLines[i],
    "ArrowDown reaches the following visual line, including shared source offsets");
}
for (let i = visualLines.length - 2; i >= 0; i--) {
  wrappedEditor.moveVertical(-1, false);
  assert.equal(wrappedEditor.locate(wrappedEditor.selEnd).line, visualLines[i], "ArrowUp returns through every visual line");
}
const firstLine = visualLines[0];
const endHit = wrappedEditor.positionAt(48 + firstLine.width + 1, 56 + firstLine.baseline - 5);
wrappedEditor.moveTo(endHit.offset, false, endHit.affinity);
assert.equal(wrappedEditor.locate(wrappedEditor.selEnd).line, firstLine, "clicking the wrapped line end stays on that line");
const nextLine = visualLines[1];
const startHit = wrappedEditor.positionAt(48, 56 + nextLine.baseline - 5);
wrappedEditor.moveTo(startHit.offset, false, startHit.affinity);
assert.equal(wrappedEditor.locate(wrappedEditor.selEnd).line, nextLine, "clicking the shared offset on the next line stays there");
const key = (name: string) => wrappedEditor.onKeyDown({ key: name, preventDefault() {} });
key("End");
assert.equal(wrappedEditor.selEnd, nextLine.docEnd);
assert.equal(wrappedEditor.locate(wrappedEditor.selEnd).line, nextLine, "End uses the upstream side of a wrap");
key("Home");
assert.equal(wrappedEditor.selEnd, nextLine.docStart);
assert.equal(wrappedEditor.locate(wrappedEditor.selEnd).line, nextLine, "Home uses the downstream side of a wrap");
wrappedEditor.selStart = 0;
wrappedEditor.selEnd = longSource.length;
assert.equal(wrappedEditor.selectionRects().length, visualLines.length, "selection covers every wrapped source line");

for (const source of ["\n", "a\n", "```\na\n", "~~~\na\n", "$$\na\n", "```math\na\n", "```\na\n```\n"]) {
  const editor = editable(source, source.length);
  const lines = editor.blocks.flatMap((b: any) => b.lines);
  assert.equal(lines.filter((line: any) => line.docStart === source.length && line.docEnd === source.length).length,
    1, "the terminal source line has exactly one owner");
  editor.moveVertical(-1, false);
  assert.ok(editor.selEnd < source.length, `ArrowUp leaves EOF in ${JSON.stringify(source)}`);
}
const unfinished = editable("```\na\n", 6);
assert.equal(unfinished.blocks.length, 1, "an open fence retains its trailing source line");
assert.equal(unfinished.blocks[0].raw, true, "EOF keeps the open fence focused");
unfinished.moveVertical(-1, false);
assert.equal(unfinished.selEnd, 4);
unfinished.moveVertical(1, false);
assert.equal(unfinished.selEnd, 6, "vertical movement round-trips through the terminal line");

const revealEditor = editable(longSource);
revealEditor.interacted = false;
revealEditor.relayout();
revealEditor.interacted = true;
revealEditor.host.clientHeight = 120;
revealEditor.moveTo(longSource.length, false);
assert.equal(revealEditor.blocks[0].raw, true);
assert.ok(revealEditor.caretRect().x <= 240, "revealing source keeps the target caret within the column");
assert.ok(revealEditor.scrollTop > 0, "scrolling uses the newly revealed source layout");

// Inject only the external formula measurement; the real WASM still lays out
// the paragraph and the document pass still positions the following block.
const deepMathTypesetter = new Typesetter({ ...DEFAULT_THEME }, {
  ...DEFAULT_OPTIONS, inline: { ...DEFAULT_OPTIONS.inline }, justify: false,
});
(deepMathTypesetter as any).buildMathPieces = () => [{
  geometry: EMPTY_GEOMETRY, scale: 1, source: "deep", display: false,
  width: 20, height: 30, depth: 80, penaltyAfter: NaN,
}];
const deepBlocks = deepMathTypesetter.layoutDocument("last $deep$\n# Next", 1000, -1).blocks;
const deepLast = deepBlocks[0].lines.at(-1)!;
assert.equal(deepLast.depth, 80, "the core keeps the formula's actual descent");
assert.ok(deepBlocks[0].height >= deepLast.baseline + deepLast.depth,
  "a paragraph contains all of its last line's ink");
assert.ok(deepBlocks[1].y - deepBlocks[1].spaceBefore >= deepBlocks[0].y + deepLast.baseline + deepLast.depth,
  "the next block starts after the previous formula's ink");

const loadingLine = layout("a$x + y$b").lines[0];
const loadingRun = loadingLine.runs.find((r) => r.math)!;
assert.equal(loadingRun.math!.fallback?.text, "x + y");
assert.equal(loadingRun.math!.width, 48, "fallback uses the measured monospace text, not U+FFFC");
assert.equal(loadingRun.math!.height, 12);
assert.equal(loadingRun.math!.depth, 4);
assert.ok(loadingLine.runs.at(-1)!.x >= loadingRun.x + loadingRun.math!.width,
  "following text starts after the loading fallback");
const fallbackEditor = Object.create(Editor.prototype) as any;
fallbackEditor.typesetter = typesetter;
fallbackEditor.text = "a$x + y$b";
fallbackEditor.blocks = [layout(fallbackEditor.text)];
fallbackEditor.selStart = loadingRun.docStart;
fallbackEditor.selEnd = loadingRun.docEnd;
assert.equal(fallbackEditor.runWidth(loadingRun), 48);
assert.equal(fallbackEditor.offsetInRun(loadingRun, 47), loadingRun.docEnd);
assert.equal(fallbackEditor.locate(loadingRun.docEnd).x, loadingRun.x + 48);
assert.equal(fallbackEditor.selectionRects()[0].w, 48, "selection uses the same formula box");
const displayFallback = layout("$$\nx + y\n$$").lines[0];
const displayRun = displayFallback.runs[0];
assert.equal(displayRun.math!.width, 48);
assert.equal(displayFallback.width, 48);
assert.equal(displayRun.x, (1000 - 48) / 2, "display fallback is centered using its painted width");
const formulaPresentation = (geometry: typeof EMPTY_GEOMETRY, source: string) =>
  (typesetter as any).mathRun(geometry, source, false, loadingRun.style);
const badFormula = formulaPresentation({ ...EMPTY_GEOMETRY, widthEx: 99, error: "bad TeX" }, "x\n+ y");
assert.equal(badFormula.fallback.text, "x + y");
assert.equal(badFormula.width, 48, "partial error geometry cannot dictate the fallback box");
assert.equal(formulaPresentation({ ...EMPTY_GEOMETRY, error: "loading" }, "").width, 10);
const invisibleFormula = formulaPresentation({ ...EMPTY_GEOMETRY, widthEx: 2 }, "\\hphantom{x}");
assert.equal(invisibleFormula.fallback, undefined, "valid inkless formulas do not turn into source text");
assert.ok(invisibleFormula.width > 0, "valid inkless formulas retain their advance");

// --- tables ----------------------------------------------------------------
// Each cell is broken as a paragraph of its own at its column's width, so a
// table is ordinary lines whose runs happen to sit at column offsets.
const TABLE = "| head | second column |\n|:---|---:|\n| a | b |\n| a much longer cell here | c |";
{
  const t = typesetter.layoutDocument(TABLE, 1000, -1).blocks[0];
  assert.equal(t.block.type, "table");
  assert.ok(t.table, "a table block carries its column geometry");
  assert.equal(t.table!.columns, 2);
  assert.equal(t.lines.length, 3, "three rows, none of them wrapped at this measure");
  assert.deepEqual(t.table!.rowStarts, [0, 1, 2]);

  const weights = (i: number) => [...new Set(t.lines[i].runs.map((r) => r.style.weight))];
  assert.deepEqual(weights(0), [700], "the header row is bold");
  assert.ok(t.table!.widths[1] >= 148,
    "a bold header sizes its column from the face it is drawn in");
  assert.deepEqual(weights(1), [400], "and the body is not");

  // Columns do not overlap, and nothing strays past the table's own width.
  const width = t.table!.x[1] + t.table!.widths[1];
  for (const line of t.lines) {
    for (const run of line.runs) {
      assert.ok(run.x >= 0 && run.x <= width, "every run sits inside the table");
    }
  }
  assert.ok(t.table!.x[1] >= t.table!.widths[0], "the second column starts after the first");

  // Every run still maps to the source it was written from.
  for (const line of t.lines) {
    for (const run of line.runs) {
      if (run.synthetic || run.math || run.image) continue;
      assert.equal(TABLE.slice(run.docStart, run.docEnd), run.text,
        `run ${JSON.stringify(run.text)} maps to its own source`);
    }
  }
}
{
  // A right-aligned column pushes its content to the column's far edge.
  const t = typesetter.layoutDocument(TABLE, 1000, -1).blocks[0];
  const rightColumnRuns = t.lines[1].runs.filter((r) => r.x >= t.table!.x[1]);
  const rightEdge = t.table!.x[1] + t.table!.widths[1];
  const last = rightColumnRuns[rightColumnRuns.length - 1];
  assert.ok(last && last.x + 10 <= rightEdge + 1, "a right-aligned cell ends at its column edge");
  assert.ok(last!.x > t.table!.x[1], "and does not start at its left edge");
}
{
  // Narrowing the measure wraps cells rather than overflowing them.
  const wide = typesetter.layoutDocument(TABLE, 1000, -1).blocks[0];
  const narrow = typesetter.layoutDocument(TABLE, 200, -1).blocks[0];
  assert.ok(narrow.lines.length > wide.lines.length, "a narrow table wraps its cells");
  assert.ok(narrow.height > wide.height, "and grows taller for them");
  const width = narrow.table!.x[1] + narrow.table!.widths[1];
  assert.ok(width <= 200 + 1, "the table never exceeds the measure");
  for (let i = 1; i < narrow.lines.length; i++) {
    const gap = (narrow.lines[i].baseline - narrow.lines[i].height) -
      (narrow.lines[i - 1].baseline + narrow.lines[i - 1].depth);
    assert.ok(gap >= -0.01, `wrapped table lines must not overlap, gap was ${gap}`);
  }
}
{
  // A ragged row is padded, not misaligned: a missing cell leaves its column
  // empty rather than shifting the ones after it.
  const ragged = typesetter.layoutDocument("| a | b |\n|---|---|\n| only |", 1000, -1).blocks[0];
  assert.equal(ragged.block.type, "table");
  assert.equal(ragged.table!.columns, 2, "the delimiter row fixes the column count");
  assert.equal(ragged.lines.length, 2);
}
console.log("ok   tables break each cell in its own column and keep their source offsets");


// --- footnotes -------------------------------------------------------------
// Numbered by first reference rather than by where the definitions sit: a
// reader meets the marks in reading order, so 1 must be the first one seen.
{
  const doc = "cites[^b] then[^a] again[^b].\n\n[^a]: note a\n\n[^b]: note b";
  const laid = typesetter.layoutDocument(doc, 1000, -1).blocks;
  const marks = laid[0].lines.flatMap((l) => l.runs).filter((r) => r.note).map((r) => r.note!.text);
  assert.deepEqual(marks, ["1", "2", "1"], "references number by first appearance");

  const defs = laid.filter((b) => b.block.type === "footnote");
  assert.deepEqual(defs.map((b) => b.block.label), ["a", "b"]);
  assert.deepEqual(defs.map((b) => b.note!.text), ["2", "1"],
    "a definition wears the number its reference earned, not its own position");
  assert.ok(defs[0].lines[0].runs[0].x > 0, "definition text is indented past its number");
  assert.ok(defs[0].note!.raise > 0, "the number is lifted off the baseline");
}
{
  // A definition nobody cites still earns a number, so editing it is not
  // confusing.
  const laid = typesetter.layoutDocument("text\n\n[^lonely]: nobody cites me", 1000, -1).blocks;
  const def = laid.find((b) => b.block.type === "footnote")!;
  assert.equal(def.note!.text, "1");
}
{
  // The mark reserves its lifted height, so the line above stays clear.
  const laid = typesetter.layoutDocument("one\n\ntwo[^a] three\n\n[^a]: n", 1000, -1).blocks;
  const withMark = laid.find((b) => b.lines.some((l) => l.runs.some((r) => r.note)) &&
    b.block.type === "paragraph")!;
  const line = withMark.lines[0];
  const mark = line.runs.find((r) => r.note)!;
  assert.ok(mark.note!.raise > 0, "the mark is lifted");
  assert.ok(line.height >= mark.note!.raise, "and the line reserves room for it");
  const plain = laid.find((b) => b.block.source === "one")!;
  assert.ok(line.height >= plain.lines[0].height,
    "a line carrying a mark is no shorter than one without");
}
console.log("ok   footnotes number by first reference and sit in their own margin");

console.log("ok   real WASM preserves style boundaries, measured widths and source offsets");
