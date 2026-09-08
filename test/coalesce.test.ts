// The rule that decides whether two adjacent runs may be drawn as one
// `fillText`. Joining is only ever correct for the pieces of a Latin word
// that hyphenation split; every CJK glyph is positioned individually, and
// squeezed punctuation is shifted inside its own em box, so handing those
// back to the platform to lay out would undo the adjustment.
import {
  isLatinWordPiece,
  spanByteBoundaries,
  Typesetter,
  type LaidRun,
} from "../src/engine/typeset.js";
import { parseInline } from "../src/markdown/parse.js";
import type { TextStyle } from "../src/engine/measure.js";

let failures = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    failures++;
    console.log(`FAIL ${label}\n  expected ${expected}\n  actual   ${actual}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

for (const piece of ["extra", "ordi", "nary", "organisation's", "café", "Ляг", "42", "re-do"]) {
  eq(isLatinWordPiece(piece), true, `joinable: ${JSON.stringify(piece)}`);
}
for (const piece of ["中", "、", "。", "（", "」", "・", "ひ", "ア", "，", "＝", "…", "“", "’"]) {
  eq(isLatinWordPiece(piece), false, `never joined: ${JSON.stringify(piece)}`);
}
eq(isLatinWordPiece("ab中"), false, "a mixed fragment is not joinable");
eq(isLatinWordPiece(""), false, "an empty fragment is not joinable");

{
  const rendered = parseInline("x**y**z", 0);
  eq(
    Array.from(spanByteBoundaries(rendered.text, rendered.spans)).join(","),
    "1,2",
    "markdown span boundaries split an ASCII word",
  );
}
{
  const rendered = parseInline("😀**é**z", 0);
  eq(
    Array.from(spanByteBoundaries(rendered.text, rendered.spans)).join(","),
    "4,6",
    "UTF-16 span boundaries become valid UTF-8 byte offsets",
  );
}

const style: TextStyle = {
  family: "serif",
  size: 16,
  weight: 400,
  italic: false,
  color: "black",
  lineHeight: 1.5,
};
const run = (text: string, x: number, start: number, end: number, spanId: number): LaidRun => ({
  x,
  text,
  docStart: start,
  docEnd: end,
  style,
  styleKey: "400 16px serif",
  spanId,
  scaleX: 1,
  synthetic: false,
});
const coalesce = (runs: LaidRun[]): LaidRun[] => {
  const method = (Typesetter.prototype as unknown as {
    coalesce(this: { measureText(text: string): number }, value: LaidRun[]): LaidRun[];
  }).coalesce;
  return method.call({ measureText: (text: string) => text.length }, runs);
};

eq(coalesce([run("a", 0, 0, 1, 0), run("b", 1, 1, 2, 0)]).length, 1, "one span may rejoin");
eq(
  coalesce([run("a", 0, 0, 1, 0), run("b", 1, 1, 2, 1)]).length,
  2,
  "different paint spans never rejoin",
);

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
