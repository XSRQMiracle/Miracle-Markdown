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
console.log("ok   real WASM preserves style boundaries, measured widths and source offsets");
