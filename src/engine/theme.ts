/**
 * The document's palette and metrics.
 *
 * The page is painted on a canvas, so everything the reader sees inside the
 * text column is a value in here rather than a CSS rule. The window around it
 * is themed separately, from `ui/skin.ts` — the two are handed the same skin
 * definition so they cannot drift apart.
 *
 * `Theme` lives in its own module rather than in `typeset.ts` so that the
 * renderer, which needs nothing else from the typesetter, does not import a
 * 1600-line module for one interface. `typeset.ts` re-exports both names, so
 * existing importers keep working.
 */

import { FALLBACK_MONO, FALLBACK_SANS, FALLBACK_SERIF } from "./measure.js";

export interface Theme {
  bodySize: number;
  /** Width of the text column in pixels. Independent of `bodySize`, so that
   *  changing the type size changes how much fits on a line rather than where
   *  the page sits. */
  columnWidth: number;
  bodyFamily: string;
  headingFamily: string;
  monoFamily: string;
  /** Headings are set one weight up from the body; how far up depends on the
   *  face, which is why it is a theme value and not a constant. A serif at 700
   *  is heavier than the page wants. */
  headingWeight: number;
  lineHeight: number;

  /** The page itself. The 2D context is opaque, so this is always painted. */
  background: string;
  color: string;
  mutedColor: string;
  accentColor: string;
  codeBackground: string;
  ruleColor: string;
  /** Behind ==highlighted== text. */
  highlightColor: string;

  /** Quotations are set apart by colour as well as by the bar beside them. */
  quoteColor: string;
  quoteRuleColor: string;
  /** Booktabs rules above and below a table; heavier than `ruleColor`. */
  tableRuleColor: string;

  caretColor: string;
  selectionColor: string;
  /** The band behind a search match. Must stay distinguishable from both the
   *  selection and ==highlight==, since all three can overlap. */
  matchColor: string;
  /** Painted over everything but the current block in focus mode, so it has to
   *  be `background` at partial alpha and nothing else. */
  veilColor: string;
  /** The track the thumb runs in. */
  scrollbarRailColor: string;
  scrollbarColor: string;
  scrollbarActiveColor: string;
  /** A broken image's alt text, and a formula that would not convert. */
  errorColor: string;
}

export const DEFAULT_THEME: Theme = {
  bodySize: 18,
  columnWidth: 760,
  bodyFamily: FALLBACK_SERIF,
  headingFamily: FALLBACK_SANS,
  monoFamily: FALLBACK_MONO,
  headingWeight: 700,
  lineHeight: 1.75,

  background: "#fdfdfb",
  color: "#1a1a1a",
  mutedColor: "#8a8a8a",
  accentColor: "#2f6f4f",
  codeBackground: "#f5f4f1",
  ruleColor: "#dcdad4",
  highlightColor: "#fbeaa8",

  quoteColor: "#8a8a8a",
  quoteRuleColor: "#dcdad4",
  tableRuleColor: "#1a1a1a",

  caretColor: "#1a1a1a",
  selectionColor: "#cddcf0",
  matchColor: "#f6e3a1",
  veilColor: "rgba(253, 253, 251, 0.72)",
  scrollbarRailColor: "transparent",
  scrollbarColor: "rgba(40, 38, 34, 0.2)",
  scrollbarActiveColor: "rgba(40, 38, 34, 0.42)",
  errorColor: "#b3402f",
};
