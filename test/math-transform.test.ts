// The transform algebra behind placing a formula's outlines.
//
// SVG's transform grammar is not CSS's — arguments carry no units and may be
// separated by spaces — so this is parsed by hand rather than handed to
// DOMMatrix. Getting it wrong does not throw; it silently draws the formula
// somewhere else, which is why it is worth pinning down.
import {
  IDENTITY,
  multiply,
  parseTransform,
  viewportTransform,
  type Matrix,
} from "../src/engine/math.js";

let failures = 0;
function close(actual: Matrix, expected: Matrix, label: string) {
  const ok = actual.every((v, i) => Math.abs(v - expected[i]) < 1e-9);
  if (!ok) {
    failures++;
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}
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

/** Apply a matrix to a point, the way the canvas will. */
const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

// --- parsing --------------------------------------------------------------
close(parseTransform(null), IDENTITY, "no transform is the identity");
close(parseTransform(""), IDENTITY, "an empty transform is the identity");
close(parseTransform("translate(10,20)"), [1, 0, 0, 1, 10, 20], "translate with a comma");
close(parseTransform("translate(10 20)"), [1, 0, 0, 1, 10, 20], "translate with a space");
close(parseTransform("translate(10)"), [1, 0, 0, 1, 10, 0], "translate with one argument");
close(parseTransform("scale(2,3)"), [2, 0, 0, 3, 0, 0], "scale with two arguments");
close(parseTransform("scale(2)"), [2, 0, 0, 2, 0, 0], "one-argument scale is uniform");
close(parseTransform("scale(1,-1)"), [1, 0, 0, -1, 0, 0], "the y-axis flip MathJax emits");
close(parseTransform("matrix(1,2,3,4,5,6)"), [1, 2, 3, 4, 5, 6], "an explicit matrix");
close(parseTransform("translate(-5.5,-0.25)"), [1, 0, 0, 1, -5.5, -0.25], "negative and fractional");
close(parseTransform("translate(1e2,0)"), [1, 0, 0, 1, 100, 0], "exponent notation");

// --- composition ----------------------------------------------------------
close(
  parseTransform("translate(10,20) scale(2)"),
  [2, 0, 0, 2, 10, 20],
  "a composed list applies left to right",
);
eq(
  apply(parseTransform("translate(10,20) scale(2)"), 3, 4),
  [16, 28],
  "translate-then-scale scales the point before translating it",
);
eq(
  apply(parseTransform("scale(2) translate(10,20)"), 3, 4),
  [26, 48],
  "the reverse order gives a different answer",
);
close(
  parseTransform("translate(1,2) translate(3,4)"),
  [1, 0, 0, 1, 4, 6],
  "two translates add",
);

// The composition MathJax actually produces for a glyph: flip the y-axis at
// the top, then translate into place. A point at TeX y=705.8 (an ascender)
// must land above the baseline, i.e. at negative canvas y.
{
  const m = multiply(parseTransform("scale(1,-1)"), parseTransform("translate(0,0)"));
  eq(apply(m, 100, 705.8), [100, -705.8], "the flip puts ascenders above the baseline");
}

// --- unknown operations are ignored, not fatal ----------------------------
close(parseTransform("nonsense(1,2)"), IDENTITY, "an unknown operation is skipped");
close(
  parseTransform("nonsense(1,2) translate(5,5)"),
  [1, 0, 0, 1, 5, 5],
  "and does not break the rest of the list",
);

// --- rotation -------------------------------------------------------------
{
  const [x, y] = apply(parseTransform("rotate(90)"), 1, 0);
  eq([Math.round(x), Math.round(y)], [0, 1], "rotate(90) takes +x to +y");
  const about = apply(parseTransform("rotate(180,5,5)"), 5, 6);
  eq([Math.round(about[0]), Math.round(about[1])], [5, 4], "rotation about a point");
}

// --- nested viewports -----------------------------------------------------
// MathJax uses a nested <svg> for stretchy constructions such as the arrow
// over \overrightarrow. Its viewBox is mapped onto its x/y/width/height box.
{
  const m = viewportTransform(0, -182, 609, 865, [152.2, -182, 609, 865]);
  eq(apply(m, 152.2, -182).map(Math.round), [0, -182], "the viewBox origin lands at the box origin");
  eq(
    apply(m, 152.2 + 609, -182 + 865).map(Math.round),
    [609, 683],
    "the far corner lands at the far corner",
  );
}
{
  // A viewBox half the size of its box is drawn at double scale.
  const m = viewportTransform(0, 0, 200, 100, [0, 0, 100, 50]);
  eq(apply(m, 50, 25), [100, 50], "a smaller viewBox scales up");
}
{
  const m = viewportTransform(7, 9, 100, 100, null);
  close(m, [1, 0, 0, 1, 7, 9], "a viewport with no viewBox is a plain translate");
}

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
