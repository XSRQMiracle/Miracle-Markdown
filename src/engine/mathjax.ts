/**
 * The MathJax bridge.
 *
 * MathJax is loaded lazily — a document with no formulas never pays for it —
 * but once loaded, conversion is synchronous. That matters: the typesetter
 * measures and lays out a paragraph in one pass on every keystroke, and an
 * async formula would either stall that pass or make the layout arrive a frame
 * late and jump.
 *
 * Results are cached by source and display mode, so re-typesetting a paragraph
 * whose formula did not change costs a map lookup.
 */

import { EMPTY_GEOMETRY, geometryFromSvg, type MathGeometry } from "./math.js";

export interface MathOptions {
  /** The LaTeX `physics` package. Off by default, and deliberately so: it
   *  redefines commands that already mean something else — `\div` stops being
   *  the division sign and becomes the divergence operator — so enabling it
   *  silently changes existing documents. */
  physics: boolean;
  /** mhchem, for chemical equations written as \\ce{...}. */
  mhchem: boolean;
  /** braket notation: \\bra, \\ket, \\braket. Independent of physics, which
   *  also defines them. */
  braket: boolean;
  /** mathtools, extending amsmath. */
  mathtools: boolean;
  /** Document-level macro definitions, as \\newcommand would give them. */
  macros: Record<string, string | [string, number]>;
}

export const DEFAULT_MATH_OPTIONS: MathOptions = {
  physics: false,
  mhchem: false,
  braket: false,
  mathtools: true,
  macros: {},
};

/** The subset of MathJax's browser API we rely on. */
interface MathJaxGlobal {
  tex2svg(latex: string, options: { display: boolean }): Element;
  startup: { promise: Promise<void> };
  texReset(): void;
}

declare global {
  interface Window {
    MathJax?: unknown;
  }
}

let mj: MathJaxGlobal | null = null;
let loading: Promise<void> | null = null;
let configured = "";
let version = 0;
const cache = new Map<string, MathGeometry>();

/** Whether formulas can be rendered right now, without awaiting. */
export function mathReady(): boolean {
  return mj !== null;
}

/**
 * Load MathJax and configure it. Safe to call repeatedly; the engine is only
 * rebuilt when the options actually change.
 *
 * MathJax's own package set is fixed at load time, so changing which packages
 * are active means reloading the page — the same restriction Typora notes
 * against its parser-level settings. We rebuild the configuration instead and
 * accept that a package toggle takes effect on the next load.
 */
export async function initMath(options: MathOptions): Promise<void> {
  const wanted = JSON.stringify(options);
  if (mj && wanted === configured) return;
  if (loading) await loading;
  if (mj && wanted === configured) return;

  loading = build(options).then(() => {
    configured = wanted;
    cache.clear();
    version++;
  });
  try {
    await loading;
  } finally {
    loading = null;
  }
}

/**
 * The TeX packages to install.
 *
 * Every package is bundled either way; what this decides is whether its
 * definitions are active — and they are not merely additive. `physics`
 * redefines commands that already mean something else: with it loaded,
 * `\div` stops being the division sign and becomes the divergence operator,
 * so the same document renders differently. That is why it is a switch rather
 * than something simply always on.
 */
function activePackages(options: MathOptions): string[] {
  // The base set every document gets. `noundefined` is what turns an unknown
  // command into visible red text instead of an exception, which matters in
  // an editor where the formula is incomplete most of the time it is read.
  const packages = [
    "base",
    "ams",
    "newcommand",
    "configmacros",
    "noundefined",
    "boldsymbol",
    "color",
    "textmacros",
    "cancel",
    "unicode",
    "html",
  ];
  if (options.mathtools) packages.push("mathtools");
  if (options.physics) packages.push("physics");
  if (options.mhchem) packages.push("mhchem");
  if (options.braket) packages.push("braket");
  return packages;
}

async function build(options: MathOptions): Promise<void> {
  // The bundled browser build carries every extension, so no package is ever
  // fetched on demand and `tex2svg` stays synchronous — which is what lets a
  // formula be measured inside the same layout pass as the text around it.
  const url = (await import("mathjax-full/es5/tex-svg-full.js?url")).default;

  window.MathJax = {
    tex: {
      // An explicit list rather than MathJax's "[+]" additive form: the whole
      // point of the physics switch is that the set is exactly what we say.
      packages: activePackages(options),
      macros: options.macros,
      // Numbering is decided by the typesetter, which knows document order;
      // MathJax only ever sees an explicit \tag.
      tags: "none",
      processEscapes: false,
    },
    svg: {
      // 'none' inlines each glyph as its own <path> rather than referencing a
      // shared <defs>. Larger SVG, but we convert once and keep only the
      // Path2D, so the flatter tree is simply easier to walk.
      fontCache: "none",
    },
    startup: { typeset: false },
    options: { enableMenu: false },
  };

  await loadScript(url);
  const global = window.MathJax as unknown as MathJaxGlobal;
  await global.startup.promise;
  mj = global;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-mathjax]`);
    if (existing) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.dataset.mathjax = "1";
    el.addEventListener("load", () => resolve());
    el.addEventListener("error", () => reject(new Error("MathJax failed to load")));
    document.head.appendChild(el);
  });
}

/**
 * Lay out one formula. Synchronous; returns an empty geometry with an error
 * set if MathJax has not finished loading or the source does not parse.
 */
export function renderMath(latex: string, display: boolean): MathGeometry {
  if (!mj) return { ...EMPTY_GEOMETRY, error: "loading" };
  if (!latex.trim()) return { ...EMPTY_GEOMETRY };

  const key = `${version}|${display ? "d" : "i"}|${latex}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let geometry: MathGeometry;
  try {
    const node = mj.tex2svg(latex, { display });
    const svg = node.querySelector("svg");
    if (!svg) {
      geometry = { ...EMPTY_GEOMETRY, error: "no output" };
    } else if (svg.querySelector("[data-mjx-error]")) {
      // MathJax renders what it could and marks the failure inline. We would
      // rather fall back to showing the source than draw a half-formula.
      const message =
        svg.querySelector("[data-mjx-error]")?.getAttribute("data-mjx-error") ?? "syntax error";
      geometry = { ...geometryFromSvg(svg as unknown as SVGSVGElement), error: message };
    } else {
      geometry = geometryFromSvg(svg as unknown as SVGSVGElement);
    }
  } catch (err) {
    geometry = { ...EMPTY_GEOMETRY, error: err instanceof Error ? err.message : String(err) };
  }

  // A cache that never forgets would hold every intermediate state of a
  // formula the reader is still typing.
  if (cache.size > 2000) cache.clear();
  cache.set(key, geometry);
  return geometry;
}

/** Drop every cached formula. Called when the math options change. */
export function invalidateMath(): void {
  cache.clear();
  version++;
}
