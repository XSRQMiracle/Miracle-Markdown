// The rule that decides whether two adjacent runs may be drawn as one
// `fillText`. Joining is only ever correct for the pieces of a Latin word
// that hyphenation split; every CJK glyph is positioned individually, and
// squeezed punctuation is shifted inside its own em box, so handing those
// back to the platform to lay out would undo the adjustment.
import { isLatinWordPiece } from "../src/engine/typeset.js";

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

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
