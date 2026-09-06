// Exercise the real WASM bridge with deterministic canvas measurements. The
// synthetic shaper includes kerning so cross-paint-boundary measurements fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initSync } from "../crates/typeset-wasm/pkg/typeset_wasm.js";
import { DEFAULT_OPTIONS, DEFAULT_THEME, initEngine, Typesetter } from "../src/engine/typeset.js";

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
console.log("ok   real WASM preserves style boundaries, measured widths and source offsets");
