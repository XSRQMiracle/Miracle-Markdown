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
