/**
 * Math rendering.
 *
 * MathJax lays the formula out and emits SVG; we convert that SVG into a
 * single `Path2D` of glyph outlines and draw it ourselves. Nothing is added to
 * the DOM and no web font is loaded — the outlines are in the SVG.
 *
 * That choice follows from the rest of the engine. We already own every glyph
 * position on the page; a formula delivered as a DOM subtree would have to be
 * overlaid on the canvas and kept in sync with our own scrolling and layout,
 * and would not survive into a PDF. Outlines drawn on the canvas sit in the
 * same coordinate space as the text, scale without resampling, and reduce to
 * one fill call per formula.
 *
 * The three numbers the typesetter needs — width, height above the baseline,
 * depth below it — come straight out of the SVG's own attributes, so a formula
 * enters the horizontal list as a box like any other.
 */

/** A 2D affine transform, as SVG orders it: a b c d e f. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Compose two transforms, outer first — the order SVG nesting implies. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/**
 * Parse an SVG transform list.
 *
 * SVG's grammar is not CSS's — arguments may be separated by spaces or
 * commas and carry no units — so `new DOMMatrix(str)` cannot be trusted with
 * it. MathJax emits only translate, scale and matrix, but rotate and the skews
 * are cheap to cover and save a silent misplacement if that ever changes.
 */
export function parseTransform(source: string | null): Matrix {
  if (!source) return IDENTITY;
  let result = IDENTITY;
  const ops = source.matchAll(/(\w+)\s*\(([^)]*)\)/g);
  for (const op of ops) {
    const args = (op[2].match(NUMBER) || []).map(Number);
    result = multiply(result, operation(op[1], args));
  }
  return result;
}

function operation(name: string, a: number[]): Matrix {
  switch (name) {
    case "translate":
      return [1, 0, 0, 1, a[0] || 0, a[1] || 0];
    case "scale": {
      const sx = a[0] ?? 1;
      return [sx, 0, 0, a.length > 1 ? a[1] : sx, 0, 0];
    }
    case "matrix":
      return a.length === 6 ? (a as Matrix) : IDENTITY;
    case "rotate": {
      const r = ((a[0] || 0) * Math.PI) / 180;
      const cos = Math.cos(r);
      const sin = Math.sin(r);
      const spin: Matrix = [cos, sin, -sin, cos, 0, 0];
      if (a.length < 3) return spin;
      // Rotation about a point is a translate-rotate-translate sandwich.
      const to: Matrix = [1, 0, 0, 1, a[1], a[2]];
      const back: Matrix = [1, 0, 0, 1, -a[1], -a[2]];
      return multiply(multiply(to, spin), back);
    }
    case "skewX":
      return [1, 0, Math.tan(((a[0] || 0) * Math.PI) / 180), 1, 0, 0];
    case "skewY":
      return [1, Math.tan(((a[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
    default:
      return IDENTITY;
  }
}

/**
 * The transform a nested `<svg>` establishes: its viewBox is mapped onto the
 * rectangle given by its x/y/width/height. MathJax uses these for stretchy
 * constructions such as the arrow over `\overrightarrow`.
 */
export function viewportTransform(
  x: number,
  y: number,
  width: number,
  height: number,
  viewBox: number[] | null,
): Matrix {
  if (!viewBox || viewBox.length < 4) return [1, 0, 0, 1, x, y];
  const [vx, vy, vw, vh] = viewBox;
  const sx = vw ? width / vw : 1;
  const sy = vh ? height / vh : 1;
  return multiply([sx, 0, 0, sy, x, y], [1, 0, 0, 1, -vx, -vy]);
}

/**
 * A laid-out formula, in the SVG's own coordinate units.
 *
 * Keeping the outlines unscaled means one cache entry serves every type size:
 * the caller scales at draw time. Metrics are in `ex` for the same reason —
 * math is sized against the surrounding font's x-height, which is what makes
 * a formula look like it belongs in the sentence rather than pasted into it.
 */
export interface MathGeometry {
  path: Path2D | null;
  /** Advance width, in ex. */
  widthEx: number;
  /** Height above the baseline, in ex. */
  heightEx: number;
  /** Depth below the baseline, in ex. */
  depthEx: number;
  /** Width of the viewBox, in SVG units — the divisor for the draw scale. */
  viewBoxWidth: number;
  /** Non-null when the formula did not parse; the caller shows the source. */
  error: string | null;
}

export const EMPTY_GEOMETRY: MathGeometry = {
  path: null,
  widthEx: 0,
  heightEx: 0,
  depthEx: 0,
  viewBoxWidth: 1,
  error: null,
};

function numbers(value: string | null): number[] | null {
  if (!value) return null;
  const found = value.match(NUMBER);
  return found ? found.map(Number) : null;
}

function unit(value: string | null): number {
  if (!value) return 0;
  const found = value.match(NUMBER);
  return found ? Number(found[0]) : 0;
}

/**
 * Walk a MathJax SVG and accumulate every outline into one path.
 *
 * MathJax is configured with `fontCache: 'none'`, so glyphs arrive as literal
 * `<path>` elements rather than `<use>` references into a shared `<defs>`.
 * That duplicates path data in the SVG, which would matter if we kept the SVG
 * — but we convert once and cache the result, so the simpler tree wins.
 */
export function geometryFromSvg(svg: SVGSVGElement): MathGeometry {
  const viewBox = numbers(svg.getAttribute("viewBox"));
  const widthEx = unit(svg.getAttribute("width"));
  const heightEx = unit(svg.getAttribute("height"));
  // MathJax reports depth as a negative vertical-align, in ex.
  const depthEx = Math.abs(unit(svg.getAttribute("style")?.match(/vertical-align:\s*([^;]+)/)?.[1] ?? null));

  const path = new Path2D();
  let drew = false;

  // The path is built with the viewBox's left edge at x = 0 and the baseline
  // at y = 0, which is where the viewBox's own y origin already sits.
  const root: Matrix = viewBox ? [1, 0, 0, 1, -viewBox[0], 0] : IDENTITY;

  const walk = (node: Element, inherited: Matrix): void => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toLowerCase();
      let matrix = multiply(inherited, parseTransform(child.getAttribute("transform")));

      if (tag === "svg") {
        // A nested viewport: map its viewBox onto its x/y/width/height box.
        matrix = multiply(
          matrix,
          viewportTransform(
            unit(child.getAttribute("x")),
            unit(child.getAttribute("y")),
            unit(child.getAttribute("width")),
            unit(child.getAttribute("height")),
            numbers(child.getAttribute("viewBox")),
          ),
        );
        walk(child, matrix);
        continue;
      }

      if (tag === "path") {
        const d = child.getAttribute("d");
        if (d) {
          path.addPath(new Path2D(d), toDomMatrix(matrix));
          drew = true;
        }
        continue;
      }

      if (tag === "rect") {
        // Fraction bars, radical rules and the like.
        const w = unit(child.getAttribute("width"));
        const h = unit(child.getAttribute("height"));
        if (w > 0 && h > 0) {
          const box = new Path2D();
          box.rect(unit(child.getAttribute("x")), unit(child.getAttribute("y")), w, h);
          path.addPath(box, toDomMatrix(matrix));
          drew = true;
        }
        continue;
      }

      walk(child, matrix);
    }
  };

  walk(svg, root);

  return {
    path: drew ? path : null,
    widthEx,
    heightEx,
    depthEx,
    viewBoxWidth: viewBox && viewBox[2] ? viewBox[2] : 1,
    error: null,
  };
}

function toDomMatrix(m: Matrix): DOMMatrix2DInit {
  return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] };
}

// ---------------------------------------------------------------------------
// Breaking a formula across lines.
//
// TeX permits a line break inside inline math, after a binary operator or a
// relation, and only at the outer level of the formula — never inside a
// fraction or a subscript. The break costs \binoppenalty or \relpenalty, so
// the optimiser weighs splitting the formula against the gap that leaving it
// whole would open.
//
// Neither KaTeX nor MathJax can do this: both hand back one indivisible box.
// We can, because a formula is already a box in the same horizontal list as
// the words, and splitting it just means handing over several boxes with a
// penalty between them. No new machinery is needed — only the knowledge of
// where TeX would allow the break.
// ---------------------------------------------------------------------------

/** TeX's `\binoppenalty`. */
export const BINOP_PENALTY = 700;
/** TeX's `\relpenalty`. */
export const REL_PENALTY = 500;

/**
 * Codepoints TeX classes as Bin — binary operators.
 *
 * MathJax does not write the atom class into its SVG, because it can be
 * recovered from the operator itself; this is the same table it consults.
 */
const BIN_OPERATORS = new Set([
  0x002b, 0x2212, 0x00b1, 0x2213, 0x00d7, 0x00f7, 0x2217, 0x22c6, 0x2218,
  0x2219, 0x22c5, 0x2229, 0x222a, 0x228e, 0x2293, 0x2294, 0x2228, 0x2227,
  0x2216, 0x2240, 0x22c4, 0x25b3, 0x25bd, 0x25c1, 0x25b7, 0x2295, 0x2296,
  0x2297, 0x2298, 0x2299, 0x25cb, 0x2020, 0x2021, 0x2a3f, 0x22b2, 0x22b3,
  0x2214, 0x2A2F,
]);

/** Codepoints TeX classes as Rel — relations. */
const REL_OPERATORS = new Set([
  0x003d, 0x2260, 0x003c, 0x003e, 0x2264, 0x2265, 0x226a, 0x226b, 0x227a,
  0x227b, 0x2aaf, 0x2ab0, 0x2282, 0x2283, 0x2286, 0x2287, 0x228f, 0x2290,
  0x2291, 0x2292, 0x2208, 0x220b, 0x2209, 0x22a2, 0x22a3, 0x2223, 0x2225,
  0x223c, 0x2243, 0x2248, 0x2245, 0x224d, 0x2250, 0x2261, 0x221d, 0x22a8,
  0x2323, 0x2322, 0x2276, 0x2277, 0x227c, 0x227d, 0x2192, 0x2190, 0x2194,
  0x21d2, 0x21d0, 0x21d4, 0x21a6, 0x21aa, 0x21a9, 0x21c0, 0x21bc, 0x21cc,
  0x2197, 0x2198, 0x2199, 0x2196, 0x225c, 0x225d, 0x225f, 0x2254, 0x2255,
  0x2261, 0x2249, 0x2262,
]);

/** One piece of a formula that may sit on a line by itself. */
export interface MathSegment {
  path: Path2D | null;
  /** Advance width, in the SVG's own units. */
  width: number;
  /** Penalty for breaking after this piece; null on the last one. */
  penaltyAfter: number | null;
}

/**
 * Split an inline formula at the breaks TeX would allow.
 *
 * Returns a single segment when the formula offers no outer-level operator,
 * which is the common case and costs nothing extra.
 */
export function segmentInlineMath(svg: SVGSVGElement, totalWidth: number): MathSegment[] {
  const mathNode = svg.querySelector('[data-mml-node="math"]');
  if (!mathNode) return [];

  const children = Array.from(mathNode.children);
  if (children.length === 0) return [];

  // Where the accumulated transform stands at the math node: everything above
  // it — notably MathJax's scale(1,-1) — applies to every segment alike.
  const base = accumulatedMatrix(mathNode, svg);

  // Pass one: find the boundaries.
  const classes = children.map(operatorClass);
  const cuts: number[] = [];
  for (let i = 0; i < children.length - 1; i++) {
    if (classes[i] === null) continue;
    // TeX suppresses the penalty when a relation follows, so that a formula
    // never breaks in the gap immediately before one.
    if (classes[i + 1] === REL_PENALTY) continue;
    cuts.push(i);
  }
  if (cuts.length === 0) {
    return [{ path: collect(children, base), width: totalWidth, penaltyAfter: null }];
  }

  // Pass two: build each segment, shifted so its own left edge is the origin.
  const segments: MathSegment[] = [];
  let from = 0;
  for (let c = 0; c <= cuts.length; c++) {
    const to = c < cuts.length ? cuts[c] + 1 : children.length;
    const startX = childOffset(children[from]);
    // The last segment runs to the formula's own right edge; the others end
    // where the next one begins, which folds the space after an operator into
    // the piece that carries it.
    const endX = to < children.length ? childOffset(children[to]) : totalWidth;
    const shifted = multiply(base, [1, 0, 0, 1, -startX, 0]);
    segments.push({
      path: collect(children.slice(from, to), shifted),
      width: endX - startX,
      penaltyAfter:
        c < cuts.length ? (classes[cuts[c]] as number) : null,
    });
    from = to;
  }
  return segments;
}

/** The x this child sits at, from its own transform. */
function childOffset(node: Element): number {
  const m = parseTransform(node.getAttribute("transform"));
  return m[4];
}

/**
 * The penalty for breaking after this atom, or null if no break is allowed.
 *
 * Only a top-level `mo` qualifies, and only when its character is one TeX
 * would class as a binary operator or a relation. Everything else — an
 * identifier, a fraction, a delimited subformula — is indivisible.
 */
function operatorClass(node: Element): number | null {
  if (node.getAttribute("data-mml-node") !== "mo") return null;
  const explicit = node.getAttribute("data-mjx-texclass");
  if (explicit === "BIN") return BINOP_PENALTY;
  if (explicit === "REL") return REL_PENALTY;
  if (explicit) return null; // ORD, OP, OPEN, CLOSE, PUNCT and friends
  const glyph = node.querySelector("[data-c]");
  const code = glyph ? parseInt(glyph.getAttribute("data-c") || "", 16) : NaN;
  if (Number.isNaN(code)) return null;
  if (BIN_OPERATORS.has(code)) return BINOP_PENALTY;
  if (REL_OPERATORS.has(code)) return REL_PENALTY;
  return null;
}

/** Accumulate the transforms from `svg` down to `node`, exclusive of `node`. */
function accumulatedMatrix(node: Element, root: Element): Matrix {
  const chain: Element[] = [];
  for (let n: Element | null = node; n && n !== root; n = n.parentElement) {
    chain.unshift(n);
  }
  let m = IDENTITY;
  for (const link of chain) {
    m = multiply(m, parseTransform(link.getAttribute("transform")));
  }
  return m;
}

/** Gather the outlines of a run of siblings into one path. */
function collect(nodes: Element[], base: Matrix): Path2D | null {
  const path = new Path2D();
  let drew = false;
  const walk = (node: Element, inherited: Matrix): void => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toLowerCase();
      let matrix = multiply(inherited, parseTransform(child.getAttribute("transform")));
      if (tag === "svg") {
        matrix = multiply(
          matrix,
          viewportTransform(
            unit(child.getAttribute("x")),
            unit(child.getAttribute("y")),
            unit(child.getAttribute("width")),
            unit(child.getAttribute("height")),
            numbers(child.getAttribute("viewBox")),
          ),
        );
        walk(child, matrix);
        continue;
      }
      if (tag === "path") {
        const d = child.getAttribute("d");
        if (d) {
          path.addPath(new Path2D(d), toDomMatrix(matrix));
          drew = true;
        }
        continue;
      }
      if (tag === "rect") {
        const w = unit(child.getAttribute("width"));
        const h = unit(child.getAttribute("height"));
        if (w > 0 && h > 0) {
          const box = new Path2D();
          box.rect(unit(child.getAttribute("x")), unit(child.getAttribute("y")), w, h);
          path.addPath(box, toDomMatrix(matrix));
          drew = true;
        }
        continue;
      }
      walk(child, matrix);
    }
  };
  for (const node of nodes) {
    const own = multiply(base, parseTransform(node.getAttribute("transform")));
    // The node's own outlines, then its children's.
    const tag = node.tagName.toLowerCase();
    if (tag === "path") {
      const d = node.getAttribute("d");
      if (d) {
        path.addPath(new Path2D(d), toDomMatrix(own));
        drew = true;
      }
    }
    walk(node, own);
  }
  return drew ? path : null;
}
