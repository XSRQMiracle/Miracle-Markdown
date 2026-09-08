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

import {
  EMPTY_GEOMETRY,
  geometryFromSvg,
  segmentInlineMath,
  type MathGeometry,
  type MathSegment,
} from "./math.js";
import { ConfigurationLifecycle, snapshotMathOptions, type MathOptions } from "./math-lifecycle.js";
export { DEFAULT_MATH_OPTIONS, type MathOptions } from "./math-lifecycle.js";

/** The subset of MathJax's browser API we rely on. */
interface MathJaxGlobal {
  tex2svg(latex: string, options: { display: boolean }): Element;
  config: { tex: { packages: string[]; macros: MathOptions["macros"] } };
  startup: {
    promise: Promise<void>;
    getComponents(): void;
    makeMethods(): void;
  };
  texReset(): void;
}

declare global {
  interface Window {
    MathJax?: unknown;
  }
}

let mj: MathJaxGlobal | null = null;
let runtime: MathJaxGlobal | null = null;
let scriptLoad: Promise<void> | null = null;
let version = 0;
const cache = new Map<string, MathGeometry>();

/** Whether formulas can be rendered right now, without awaiting. */
export function mathReady(): boolean {
  return mj !== null;
}

const lifecycle = new ConfigurationLifecycle({
  snapshot: snapshotMathOptions,
  apply: applyConfiguration,
  committed: () => invalidateMath(),
  broken: () => { mj = null; },
});

/** Load once, then rebuild the bundled components when configuration changes. */
export function initMath(options: MathOptions): Promise<boolean> {
  return lifecycle.configure(options);
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

function mutableMacros(options: MathOptions): MathOptions["macros"] {
  return Object.fromEntries(Object.entries(options.macros).map(([name, value]) =>
    [name, Array.isArray(value) ? [...value] : value]));
}

async function applyConfiguration(options: MathOptions): Promise<void> {
  if (runtime) {
    // The browser bundle replaces the initial config with its runtime object.
    // Keep that object alive; only the input/output jax need re-creating.
    runtime.config.tex.packages = activePackages(options);
    runtime.config.tex.macros = mutableMacros(options);
    runtime.startup.getComponents();
    // Reset/convert methods close over jax instances and must be rebound too.
    runtime.startup.makeMethods();
    mj = runtime;
    return;
  }
  // The bundled browser build carries every extension, so no package is ever
  // fetched on demand and `tex2svg` stays synchronous — which is what lets a
  // formula be measured inside the same layout pass as the text around it.
  const url = (await import("mathjax-full/es5/tex-svg-full.js?url")).default;

  window.MathJax = {
    tex: {
      // An explicit list rather than MathJax's "[+]" additive form: the whole
      // point of the physics switch is that the set is exactly what we say.
      packages: activePackages(options),
      macros: mutableMacros(options),
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

  try {
    await loadScript(url);
    const global = window.MathJax as MathJaxGlobal;
    await global.startup.promise;
    if (typeof global.tex2svg !== "function" || typeof global.startup.getComponents !== "function" ||
        typeof global.startup.makeMethods !== "function") {
      throw new Error("MathJax runtime did not initialize");
    }
    runtime = mj = global;
  } catch (error) {
    document.querySelector("script[data-mathjax]")?.remove();
    scriptLoad = null;
    throw error;
  }
}

function loadScript(src: string): Promise<void> {
  if (scriptLoad) return scriptLoad;
  scriptLoad = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.dataset.mathjax = "1";
    el.addEventListener("load", () => resolve());
    el.addEventListener("error", () => reject(new Error("MathJax failed to load")));
    document.head.appendChild(el);
  });
  return scriptLoad;
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

const segmentCache = new Map<string, { geometry: MathGeometry; segments: MathSegment[] }>();

/**
 * Lay out a formula and, for inline math, split it where TeX would allow a
 * line break: after an outer-level binary operator or relation.
 *
 * Display math is never split — TeX only does this in text style, since a
 * displayed equation has a line to itself by definition.
 */
export function renderMathSegments(
  latex: string,
  display: boolean,
): { geometry: MathGeometry; segments: MathSegment[] } {
  const geometry = renderMath(latex, display);
  if (display || geometry.error || !geometry.path) return { geometry, segments: [] };

  const key = `${version}|${latex}`;
  const hit = segmentCache.get(key);
  if (hit) return hit;

  let segments: MathSegment[] = [];
  try {
    const node = mj!.tex2svg(latex, { display: false });
    const svg = node.querySelector("svg");
    if (svg) {
      segments = segmentInlineMath(svg as unknown as SVGSVGElement, geometry.viewBoxWidth);
    }
  } catch {
    segments = [];
  }

  const built = { geometry, segments };
  if (segmentCache.size > 2000) segmentCache.clear();
  segmentCache.set(key, built);
  return built;
}

/** Drop every cached formula. Called when the math options change. */
export function invalidateMath(): void {
  cache.clear();
  segmentCache.clear();
  version++;
}
