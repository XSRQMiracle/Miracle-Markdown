/**
 * Skins.
 *
 * A skin is one table of values that dresses both halves of the window: the
 * chrome, which is HTML and therefore takes CSS custom properties, and the
 * page, which is painted on a canvas and therefore takes a `Theme`. Both come
 * out of the same definition so the toolbar and the paper can never disagree
 * about what colour the ink is.
 *
 * What a skin does *not* touch is the typesetting: type size, column width and
 * the seven line-breaking switches are properties of the document, not of the
 * dress. Swapping skins leaves the line breaks exactly where they were.
 *
 * Six skins, one shape of table. Where a skin's identity is a *shape* rather
 * than a colour — Industry's corner marks, Modernist's 2px rules, Broadsheet's
 * refusal to draw any rule at all — the values here carry as much of it as
 * tokens can, and the rest lives in the `[data-skin]` blocks in index.html.
 */

import type { Theme } from "../engine/theme.js";
import { faceStack, findFace } from "./fonts.js";

export type SkinName =
  | "organic"
  | "classical"
  | "broadsheet"
  | "industry"
  | "modernist"
  | "nocturne";

export type Appearance = "light" | "dark" | "system";

/** Which face the page is set in: `theme` follows the skin's own preference,
 *  anything else is an id from `fonts.ts`'s catalogue. */
export type BodyFace = string;

/** The document palette, minus the two values that belong to the document
 *  rather than to the skin. */
export type DocumentPalette = Omit<Theme, "bodySize" | "columnWidth">;

/** Every chrome token, without the `--mm-` prefix they are written under. */
export interface ChromePalette {
  /** The window ground, and the page behind the text column. */
  paper: string;
  /** Toolbar and status bar. Equal to `paper` in the skins that separate
   *  regions with whitespace or a background step instead of with a rule. */
  chrome: string;
  sidebar: string;
  /** Toolbar/status rules and popover borders — the hairline that reads. */
  rule: string;
  /** Sidebar edge and in-panel dividers — a step quieter. */
  ruleSoft: string;
  /** Menu separators and table interiors — quieter still. */
  ruleFaint: string;
  /** Selected row, active tab, slider track. */
  fillActive: string;
  /** Sidebar tab hover. */
  fillHover: string;
  /** Toolbar and status-bar button hover. */
  fillHoverChrome: string;
  /** The lightest hover, for controls that already carry a fill. */
  fillHoverSoft: string;
  /** Code panels, table headers, the scroll rail. */
  tint: string;
  thumb: string;
  text: string;
  text2: string;
  text3: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentDeep: string;
  /** Accent text sitting on `accentTint` — dark enough to read on it. */
  accentLabel: string;
  accentTint: string;
  /** The unsaved-changes dot. Usually the accent, but Broadsheet spends its
   *  one drop of magenta here and nowhere else. */
  dirty: string;
  positive: string;
  positiveRule: string;
  positiveFill: string;
  /** Border of a chrome icon button at rest. */
  iconBorder: string;
  /** The one action that loses work. Used sparingly, and never as a fill
   *  except on hover. */
  danger: string;
  shadow: string;
  shadowStrong: string;

  /** Shape. A skin is as much its corners and its rule weight as its colour,
   *  so these travel with the palette rather than being fixed in the sheet. */
  radiusPill: string;
  radiusLg: string;
  radiusMd: string;
  radiusSm: string;
  /** How heavy a structural rule is. Modernist's is 2px, everyone else's 1px. */
  ruleWeight: string;
}

export interface SkinMode {
  chrome: ChromePalette;
  document: DocumentPalette;
}

export interface Skin {
  name: SkinName;
  label: string;
  /** Shown under the name on the appearance card. */
  description: string;
  light: SkinMode | null;
  dark: SkinMode | null;
  fonts: {
    /** The chrome's own face. */
    ui: string;
    mono: string;
  };
  /** Enough colour to draw the skin's card without applying the skin. */
  swatch: { bg: string; ink: string; accent: string; rule: string; family: string };
}

const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

/** Each skin names its own face first and then falls through to the platform's.
 *  None of the six are bundled yet, so what ships is the fallback — see
 *  fonts.ts for why the fallbacks are ordered the way they are. */
const UI_FIGTREE =
  'Figtree, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
const UI_LORA = 'Lora, "Iowan Old Style", Charter, Georgia, "Songti SC", serif';
const UI_SOURCE_SERIF =
  '"Source Serif 4", "Iowan Old Style", Charter, Georgia, "Songti SC", serif';
const UI_BARLOW = 'Barlow, "Helvetica Neue", -apple-system, "Segoe UI", system-ui, sans-serif';
const UI_ARCHIVO = 'Archivo, "Helvetica Neue", -apple-system, "Segoe UI", system-ui, sans-serif';
const UI_INTER = 'Inter, -apple-system, "Segoe UI", system-ui, sans-serif';

/** The two document faces, from the catalogue so the ordering rule holds. */
export const DOC_SERIF = faceStack(findFace("serif")!);
export const DOC_SANS = faceStack(findFace("sans")!);

// ── Organic ───────────────────────────────────────────────────────────────

const ORGANIC_LIGHT: SkinMode = {
  chrome: {
    paper: "#fdfaf4",
    chrome: "#f0e6d4",
    sidebar: "#f5ecdc",
    rule: "#ddd2bd",
    ruleSoft: "#e2d8c6",
    ruleFaint: "#e9e0cd",
    fillActive: "#e4d5b9",
    fillHover: "#ece0ca",
    fillHoverChrome: "#e6dac4",
    fillHoverSoft: "#f6efe2",
    tint: "#f3ebdb",
    thumb: "#dcd3c4",
    text: "#201e1d",
    text2: "#474238",
    text3: "#645c50",
    textMuted: "#82796a",
    textFaint: "#a19786",
    accent: "#c67139",
    accentDeep: "#b2622d",
    accentLabel: "#8c491a",
    accentTint: "#fff2eb",
    dirty: "#c67139",
    positive: "#56633f",
    positiveRule: "#ccdbb2",
    positiveFill: "#e1eecc",
    iconBorder: "#d3c7b1",
    danger: "#b3402f",
    shadow: "0 12px 32px rgba(46, 43, 37, 0.22)",
    shadowStrong: "0 14px 34px rgba(46, 43, 37, 0.24)",
    radiusPill: "999px",
    radiusLg: "16px",
    radiusMd: "12px",
    radiusSm: "8px",
    ruleWeight: "1px",
  },
  document: {
    bodyFamily: DOC_SERIF,
    headingFamily: DOC_SERIF,
    monoFamily: MONO,
    headingWeight: 600,
    lineHeight: 1.85,
    background: "#fdfaf4",
    color: "#201e1d",
    mutedColor: "#82796a",
    accentColor: "#c67139",
    codeBackground: "#f3ebdb",
    ruleColor: "#e2d8c6",
    highlightColor: "#ffe1d0",
    quoteColor: "#56633f",
    quoteRuleColor: "#ccdbb2",
    // Booktabs wants its outer rules visibly heavier than the header rule.
    tableRuleColor: "#82796a",
    caretColor: "#201e1d",
    selectionColor: "rgba(198, 113, 57, 0.22)",
    // A search match has to stay apart from both the selection and a
    // ==highlight==, since all three can land on the same word.
    matchColor: "rgba(226, 176, 74, 0.42)",
    veilColor: "rgba(253, 250, 244, 0.72)",
    scrollbarRailColor: "#f3ebdb",
    scrollbarColor: "#dcd3c4",
    scrollbarActiveColor: "#c0b6a5",
    errorColor: "#b3402f",
  },
};

/** 2c in the design: a warm-shifted dark, never an inversion. The design
 *  collapses the sidebar in its only dark artboard, so the sidebar and its
 *  dividers are derived rather than quoted. */
const ORGANIC_DARK: SkinMode = {
  chrome: {
    paper: "#1c1813",
    chrome: "#262119",
    sidebar: "#221d17",
    rule: "#3a3328",
    ruleSoft: "#332c22",
    ruleFaint: "#2b251d",
    fillActive: "#3a3328",
    fillHover: "#2b251d",
    fillHoverChrome: "#31291f",
    fillHoverSoft: "#31291f",
    tint: "#241f18",
    thumb: "#4a4238",
    text: "#ece2d0",
    text2: "#c9bfae",
    text3: "#9c9384",
    textMuted: "#9c9384",
    textFaint: "#6d6558",
    accent: "#e08c50",
    accentDeep: "#f0b184",
    accentLabel: "#f0b184",
    accentTint: "#33261a",
    dirty: "#e08c50",
    positive: "#9db07c",
    positiveRule: "#4a5238",
    positiveFill: "#2b3020",
    iconBorder: "#3f382c",
    danger: "#d2694f",
    shadow: "0 12px 32px rgba(20, 17, 13, 0.5)",
    shadowStrong: "0 14px 34px rgba(20, 17, 13, 0.55)",
    radiusPill: "999px",
    radiusLg: "16px",
    radiusMd: "12px",
    radiusSm: "8px",
    ruleWeight: "1px",
  },
  document: {
    bodyFamily: DOC_SERIF,
    headingFamily: DOC_SERIF,
    monoFamily: MONO,
    headingWeight: 600,
    lineHeight: 1.85,
    background: "#1c1813",
    color: "#ece2d0",
    mutedColor: "#9c9384",
    accentColor: "#e08c50",
    codeBackground: "#241f18",
    ruleColor: "#3a3328",
    highlightColor: "#4a3520",
    quoteColor: "#9db07c",
    quoteRuleColor: "#4a5238",
    tableRuleColor: "#6d6558",
    caretColor: "#ece2d0",
    selectionColor: "rgba(224, 140, 80, 0.26)",
    matchColor: "rgba(226, 176, 74, 0.3)",
    veilColor: "rgba(28, 24, 19, 0.72)",
    scrollbarRailColor: "#241f18",
    scrollbarColor: "#4a4238",
    scrollbarActiveColor: "#6d6558",
    errorColor: "#d2694f",
  },
};

// ── Classical ─────────────────────────────────────────────────────────────
// 3a/3c. Gold is a border and an underline, never a fill; selection is a rule
// beside the row rather than a block behind it; radii drop to 2–4px.

const CLASSICAL_LIGHT: SkinMode = {
  chrome: {
    paper: "#faf9f9",
    chrome: "#f3f2f2",
    sidebar: "#f3f2f2",
    rule: "rgba(32, 31, 29, 0.22)",
    ruleSoft: "rgba(32, 31, 29, 0.14)",
    ruleFaint: "rgba(32, 31, 29, 0.1)",
    fillActive: "rgba(182, 130, 53, 0.1)",
    fillHover: "rgba(32, 31, 29, 0.05)",
    fillHoverChrome: "rgba(32, 31, 29, 0.06)",
    fillHoverSoft: "rgba(32, 31, 29, 0.04)",
    tint: "#eae9e9",
    thumb: "rgba(32, 31, 29, 0.22)",
    text: "#201f1d",
    text2: "#444141",
    text3: "#605d5d",
    textMuted: "#7d7979",
    textFaint: "#9b9797",
    accent: "#b68235",
    accentDeep: "#7d5411",
    accentLabel: "#7d5411",
    accentTint: "rgba(182, 130, 53, 0.08)",
    dirty: "#b68235",
    positive: "#7d5411",
    positiveRule: "#b68235",
    positiveFill: "rgba(182, 130, 53, 0.08)",
    iconBorder: "rgba(32, 31, 29, 0.22)",
    danger: "#b3402f",
    shadow: "0 12px 32px rgba(45, 43, 43, 0.18)",
    shadowStrong: "0 14px 34px rgba(45, 43, 43, 0.2)",
    radiusPill: "2px",
    radiusLg: "4px",
    radiusMd: "4px",
    radiusSm: "2px",
    ruleWeight: "1px",
  },
  document: {
    bodyFamily: DOC_SERIF,
    headingFamily: DOC_SERIF,
    monoFamily: MONO,
    headingWeight: 600,
    lineHeight: 1.9,
    background: "#faf9f9",
    color: "#201f1d",
    mutedColor: "#7d7979",
    accentColor: "#b68235",
    // No filled code panel in this skin: the block is ruled above and below,
    // so the panel takes the colour of the page and the rules do the work.
    codeBackground: "#faf9f9",
    ruleColor: "rgba(32, 31, 29, 0.14)",
    highlightColor: "rgba(182, 130, 53, 0.18)",
    quoteColor: "#444141",
    quoteRuleColor: "#b68235",
    tableRuleColor: "rgba(32, 31, 29, 0.4)",
    caretColor: "#201f1d",
    selectionColor: "rgba(182, 130, 53, 0.2)",
    matchColor: "rgba(182, 130, 53, 0.34)",
    veilColor: "rgba(250, 249, 249, 0.72)",
    scrollbarRailColor: "#eae9e9",
    scrollbarColor: "rgba(32, 31, 29, 0.22)",
    scrollbarActiveColor: "rgba(32, 31, 29, 0.4)",
    errorColor: "#b3402f",
  },
};

/** 3c. A neutral warm charcoal rather than Organic's brown-black, and one
 *  lighter gold doing the work of both the light skin's rule and text golds. */
const CLASSICAL_DARK: SkinMode = {
  chrome: {
    paper: "#191818",
    chrome: "#201f1d",
    // The dark artboard collapses the sidebar; this step between paper and
    // chrome is derived, on the ratio the light skin uses.
    sidebar: "#1e1d1b",
    rule: "rgba(243, 242, 242, 0.16)",
    ruleSoft: "rgba(243, 242, 242, 0.12)",
    ruleFaint: "rgba(243, 242, 242, 0.08)",
    fillActive: "rgba(225, 173, 102, 0.12)",
    fillHover: "rgba(243, 242, 242, 0.06)",
    fillHoverChrome: "rgba(243, 242, 242, 0.07)",
    fillHoverSoft: "rgba(243, 242, 242, 0.05)",
    tint: "#232120",
    thumb: "rgba(243, 242, 242, 0.2)",
    text: "#eae9e9",
    text2: "#bab6b6",
    text3: "#9b9797",
    textMuted: "#9b9797",
    textFaint: "#7d7979",
    accent: "#e1ad66",
    accentDeep: "#f0c98f",
    accentLabel: "#e1ad66",
    accentTint: "rgba(225, 173, 102, 0.12)",
    dirty: "#e1ad66",
    positive: "#e1ad66",
    positiveRule: "rgba(225, 173, 102, 0.55)",
    positiveFill: "rgba(225, 173, 102, 0.12)",
    iconBorder: "rgba(243, 242, 242, 0.2)",
    danger: "#d2694f",
    shadow: "0 12px 32px rgba(10, 9, 9, 0.45)",
    shadowStrong: "0 14px 34px rgba(10, 9, 9, 0.5)",
    radiusPill: "2px",
    radiusLg: "4px",
    radiusMd: "4px",
    radiusSm: "2px",
    ruleWeight: "1px",
  },
  document: {
    bodyFamily: DOC_SERIF,
    headingFamily: DOC_SERIF,
    monoFamily: MONO,
    headingWeight: 600,
    lineHeight: 1.9,
    background: "#191818",
    color: "#eae9e9",
    mutedColor: "#9b9797",
    accentColor: "#e1ad66",
    codeBackground: "#191818",
    ruleColor: "rgba(243, 242, 242, 0.16)",
    highlightColor: "rgba(225, 173, 102, 0.22)",
    quoteColor: "#bab6b6",
    quoteRuleColor: "#e1ad66",
    tableRuleColor: "rgba(243, 242, 242, 0.4)",
    caretColor: "#eae9e9",
    selectionColor: "rgba(225, 173, 102, 0.24)",
    matchColor: "rgba(225, 173, 102, 0.36)",
    veilColor: "rgba(25, 24, 24, 0.72)",
    scrollbarRailColor: "#232120",
    scrollbarColor: "rgba(243, 242, 242, 0.2)",
    scrollbarActiveColor: "rgba(243, 242, 242, 0.36)",
    errorColor: "#d2694f",
  },
};

// ── Broadsheet ────────────────────────────────────────────────────────────
// 4a. No frame, no divider, no background step: one flat field, and the only
// thing between the sidebar and the page is the gutter. Cyan is the
// interaction colour; magenta appears exactly once, on the unsaved dot.

const BROADSHEET_LIGHT: SkinMode = {
  chrome: {
    paper: "#f3f2f2",
    // Every bar is the window's own ground. The [data-skin] block removes
    // their borders; keeping the colours equal is the other half of it.
    chrome: "#f3f2f2",
    sidebar: "#f3f2f2",
    // Nothing structural is ruled, but a floating surface still needs an
    // edge — the popover and the find bar are not drawn in the artboard.
    rule: "rgba(32, 30, 29, 0.14)",
    ruleSoft: "rgba(32, 30, 29, 0.1)",
    ruleFaint: "rgba(32, 30, 29, 0.07)",
    fillActive: "rgba(32, 30, 29, 0.06)",
    fillHover: "rgba(32, 30, 29, 0.05)",
    fillHoverChrome: "rgba(32, 30, 29, 0.06)",
    fillHoverSoft: "rgba(32, 30, 29, 0.04)",
    tint: "#eae9e9",
    thumb: "#c9c7c6",
    text: "#201e1d",
    text2: "#4a4745",
    text3: "#6b6866",
    textMuted: "#6b6866",
    textFaint: "#9b9997",
    accent: "#0088b0",
    accentDeep: "#006786",
    accentLabel: "#006786",
    accentTint: "#e9f8ff",
    dirty: "#d6006c",
    positive: "#006786",
    positiveRule: "#99e0ff",
    positiveFill: "#e9f8ff",
    iconBorder: "rgba(32, 30, 29, 0.16)",
    danger: "#aa0b56",
    shadow: "0 12px 32px rgba(32, 30, 29, 0.16)",
    shadowStrong: "0 14px 34px rgba(32, 30, 29, 0.18)",
    radiusPill: "0px",
    radiusLg: "0px",
    radiusMd: "0px",
    radiusSm: "0px",
    ruleWeight: "1px",
  },
  document: {
    bodyFamily: DOC_SERIF,
    headingFamily: DOC_SERIF,
    monoFamily: MONO,
    headingWeight: 600,
    lineHeight: 1.75,
    background: "#f3f2f2",
    color: "#201e1d",
    mutedColor: "#6b6866",
    accentColor: "#0088b0",
    codeBackground: "#eae9e9",
    ruleColor: "rgba(32, 30, 29, 0.14)",
    highlightColor: "#cbeeff",
    quoteColor: "#0d5c74",
    quoteRuleColor: "#99e0ff",
    tableRuleColor: "#4a4745",
    caretColor: "#201e1d",
    selectionColor: "rgba(0, 136, 176, 0.18)",
    matchColor: "rgba(214, 0, 108, 0.22)",
    veilColor: "rgba(243, 242, 242, 0.72)",
    scrollbarRailColor: "#eae9e9",
    scrollbarColor: "#c9c7c6",
    scrollbarActiveColor: "#9b9997",
    errorColor: "#aa0b56",
  },
};

/** Derived. The design says every light skin needs a dark build and that none
 *  should be a mechanical inversion; Broadsheet's is the hardest, because with
 *  no rules to invert its hierarchy has to stay entirely in size and tracking.
 *  So: the same single flat field, one step off ink-black. */
const BROADSHEET_DARK: SkinMode = {
  chrome: {
    paper: "#1b1b1b",
    chrome: "#1b1b1b",
    sidebar: "#1b1b1b",
    rule: "rgba(240, 239, 239, 0.16)",
    ruleSoft: "rgba(240, 239, 239, 0.12)",
    ruleFaint: "rgba(240, 239, 239, 0.08)",
    fillActive: "rgba(240, 239, 239, 0.08)",
    fillHover: "rgba(240, 239, 239, 0.06)",
    fillHoverChrome: "rgba(240, 239, 239, 0.08)",
    fillHoverSoft: "rgba(240, 239, 239, 0.05)",
    tint: "#242424",
    thumb: "#494949",
    text: "#f0efef",
    text2: "#cbc9c9",
    text3: "#a8a5a5",
    textMuted: "#a8a5a5",
    textFaint: "#787575",
    accent: "#4fc3e8",
    accentDeep: "#99e0ff",
    accentLabel: "#99e0ff",
    accentTint: "rgba(79, 195, 232, 0.14)",
    dirty: "#ff90b1",
    positive: "#99e0ff",
    positiveRule: "rgba(79, 195, 232, 0.5)",
    positiveFill: "rgba(79, 195, 232, 0.14)",
    iconBorder: "rgba(240, 239, 239, 0.2)",
    danger: "#ff90b1",
    shadow: "0 12px 32px rgba(8, 8, 8, 0.5)",
    shadowStrong: "0 14px 34px rgba(8, 8, 8, 0.55)",
    radiusPill: "0px",
    radiusLg: "0px",
    radiusMd: "0px",
    radiusSm: "0px",
    ruleWeight: "1px",
  },
  document: {
    bodyFamily: DOC_SERIF,
    headingFamily: DOC_SERIF,
    monoFamily: MONO,
    headingWeight: 600,
    lineHeight: 1.75,
    background: "#1b1b1b",
    color: "#f0efef",
    mutedColor: "#a8a5a5",
    accentColor: "#4fc3e8",
    codeBackground: "#242424",
    ruleColor: "rgba(240, 239, 239, 0.16)",
    highlightColor: "rgba(79, 195, 232, 0.2)",
    quoteColor: "#8fd4ea",
    quoteRuleColor: "rgba(79, 195, 232, 0.45)",
    tableRuleColor: "#cbc9c9",
    caretColor: "#f0efef",
    selectionColor: "rgba(79, 195, 232, 0.24)",
    matchColor: "rgba(255, 144, 177, 0.28)",
    veilColor: "rgba(27, 27, 27, 0.72)",
    scrollbarRailColor: "#242424",
    scrollbarColor: "#494949",
    scrollbarActiveColor: "#787575",
    errorColor: "#ff90b1",
  },
};

// ── Industry ──────────────────────────────────────────────────────────────
// 4b. Wireframe boxes with corner marks, two deliberate divider strengths, and
// steel blue only on things you can interact with.

const INDUSTRY_LIGHT: SkinMode = {
  chrome: {
    paper: "#f2f2f3",
    chrome: "#f2f2f3",
    sidebar: "#f2f2f3",
    // The two strengths are load-bearing: 28% is structure, 16% is the
    // separator inside a component.
    rule: "rgba(29, 31, 32, 0.28)",
    ruleSoft: "rgba(29, 31, 32, 0.16)",
    ruleFaint: "rgba(29, 31, 32, 0.1)",
    fillActive: "rgba(89, 128, 166, 0.1)",
    fillHover: "rgba(29, 31, 32, 0.06)",
    fillHoverChrome: "rgba(29, 31, 32, 0.07)",
    fillHoverSoft: "rgba(29, 31, 32, 0.05)",
    tint: "#e9e9ea",
    thumb: "rgba(29, 31, 32, 0.28)",
    text: "#1d1f20",
    text2: "#3a3c3e",
    text3: "#4a4c4e",
    textMuted: "#6f7274",
    textFaint: "#6f7274",
    accent: "#5980a6",
    accentDeep: "#456b90",
    accentLabel: "#416180",
    accentTint: "#eef6ff",
    dirty: "#5980a6",
    positive: "#416180",
    positiveRule: "#b5d9fd",
    positiveFill: "#eef6ff",
    iconBorder: "rgba(29, 31, 32, 0.28)",
    danger: "#b3402f",
    shadow: "0 6px 20px rgba(29, 31, 32, 0.12)",
    shadowStrong: "0 10px 26px rgba(29, 31, 32, 0.16)",
    radiusPill: "0px",
    radiusLg: "0px",
    radiusMd: "0px",
    radiusSm: "0px",
    ruleWeight: "1px",
  },
  document: {
    bodyFamily: DOC_SERIF,
    headingFamily: DOC_SERIF,
    monoFamily: MONO,
    headingWeight: 600,
    lineHeight: 1.8,
    background: "#f2f2f3",
    color: "#1d1f20",
    mutedColor: "#6f7274",
    accentColor: "#5980a6",
    codeBackground: "#e9e9ea",
    ruleColor: "rgba(29, 31, 32, 0.28)",
    highlightColor: "#d6ebff",
    quoteColor: "#3a3c3e",
    quoteRuleColor: "#5980a6",
    tableRuleColor: "#1d1f20",
    caretColor: "#1d1f20",
    selectionColor: "rgba(89, 128, 166, 0.2)",
    matchColor: "rgba(89, 128, 166, 0.36)",
    veilColor: "rgba(242, 242, 243, 0.72)",
    scrollbarRailColor: "#e9e9ea",
    scrollbarColor: "rgba(29, 31, 32, 0.28)",
    scrollbarActiveColor: "rgba(29, 31, 32, 0.45)",
    errorColor: "#b3402f",
  },
};

/** Derived, following the metaphor the design names: a blueprint is pale lines
 *  on ink. The two divider strengths are re-derived at their dark equivalents
 *  rather than alpha-flipped. */
const INDUSTRY_DARK: SkinMode = {
  chrome: {
    paper: "#161a1f",
    chrome: "#161a1f",
    sidebar: "#161a1f",
    rule: "rgba(214, 235, 255, 0.26)",
    ruleSoft: "rgba(214, 235, 255, 0.15)",
    ruleFaint: "rgba(214, 235, 255, 0.09)",
    fillActive: "rgba(148, 188, 227, 0.14)",
    fillHover: "rgba(214, 235, 255, 0.07)",
    fillHoverChrome: "rgba(214, 235, 255, 0.09)",
    fillHoverSoft: "rgba(214, 235, 255, 0.06)",
    tint: "#1d222a",
    thumb: "rgba(214, 235, 255, 0.26)",
    text: "#e4ecf4",
    text2: "#bcc8d4",
    text3: "#9aa8b6",
    textMuted: "#8494a4",
    textFaint: "#8494a4",
    accent: "#94bce3",
    accentDeep: "#b5d9fd",
    accentLabel: "#b5d9fd",
    accentTint: "rgba(148, 188, 227, 0.14)",
    dirty: "#94bce3",
    positive: "#b5d9fd",
    positiveRule: "rgba(148, 188, 227, 0.5)",
    positiveFill: "rgba(148, 188, 227, 0.14)",
    iconBorder: "rgba(214, 235, 255, 0.26)",
    danger: "#e08a78",
    shadow: "0 6px 20px rgba(6, 9, 13, 0.5)",
    shadowStrong: "0 10px 26px rgba(6, 9, 13, 0.55)",
    radiusPill: "0px",
    radiusLg: "0px",
    radiusMd: "0px",
    radiusSm: "0px",
    ruleWeight: "1px",
  },
  document: {
    bodyFamily: DOC_SERIF,
    headingFamily: DOC_SERIF,
    monoFamily: MONO,
    headingWeight: 600,
    lineHeight: 1.8,
    background: "#161a1f",
    color: "#e4ecf4",
    mutedColor: "#8494a4",
    accentColor: "#94bce3",
    codeBackground: "#1d222a",
    ruleColor: "rgba(214, 235, 255, 0.26)",
    highlightColor: "rgba(148, 188, 227, 0.22)",
    quoteColor: "#bcc8d4",
    quoteRuleColor: "#94bce3",
    tableRuleColor: "#e4ecf4",
    caretColor: "#e4ecf4",
    selectionColor: "rgba(148, 188, 227, 0.24)",
    matchColor: "rgba(148, 188, 227, 0.38)",
    veilColor: "rgba(22, 26, 31, 0.72)",
    scrollbarRailColor: "#1d222a",
    scrollbarColor: "rgba(214, 235, 255, 0.26)",
    scrollbarActiveColor: "rgba(214, 235, 255, 0.42)",
    errorColor: "#e08a78",
  },
};

// ── Modernist ─────────────────────────────────────────────────────────────
// 4c. Zero radius, 2px rules at full-strength ink, one family throughout, and
// red only on the current file and the primary action.

const MODERNIST_LIGHT: SkinMode = {
  chrome: {
    paper: "#f3f2f2",
    chrome: "#f3f2f2",
    sidebar: "#f3f2f2",
    // Every structural rule is opaque ink. There is no rgba anywhere in the
    // artboard; the only 1px line in the skin is the status chip's border.
    rule: "#201e1d",
    ruleSoft: "#201e1d",
    ruleFaint: "rgba(32, 30, 29, 0.4)",
    fillActive: "#ec3013",
    fillHover: "rgba(32, 30, 29, 0.07)",
    fillHoverChrome: "rgba(32, 30, 29, 0.08)",
    fillHoverSoft: "rgba(32, 30, 29, 0.05)",
    tint: "#eae9e9",
    thumb: "#201e1d",
    text: "#201e1d",
    text2: "#3f3c39",
    text3: "#57534f",
    textMuted: "#57534f",
    textFaint: "#9a9693",
    accent: "#ec3013",
    accentDeep: "#c92408",
    accentLabel: "#ae1800",
    accentTint: "#fff2ef",
    dirty: "#ec3013",
    positive: "#201e1d",
    positiveRule: "#201e1d",
    positiveFill: "#eae9e9",
    iconBorder: "#201e1d",
    danger: "#ae1800",
    shadow: "none",
    shadowStrong: "none",
    radiusPill: "0px",
    radiusLg: "0px",
    radiusMd: "0px",
    radiusSm: "0px",
    ruleWeight: "2px",
  },
  document: {
    bodyFamily: DOC_SERIF,
    headingFamily: DOC_SERIF,
    monoFamily: MONO,
    headingWeight: 700,
    lineHeight: 1.8,
    background: "#f3f2f2",
    color: "#201e1d",
    mutedColor: "#57534f",
    accentColor: "#ec3013",
    codeBackground: "#eae9e9",
    ruleColor: "#201e1d",
    highlightColor: "#ffe0d9",
    quoteColor: "#3f3c39",
    quoteRuleColor: "#ec3013",
    tableRuleColor: "#201e1d",
    caretColor: "#201e1d",
    selectionColor: "rgba(236, 48, 19, 0.16)",
    matchColor: "rgba(236, 48, 19, 0.3)",
    veilColor: "rgba(243, 242, 242, 0.72)",
    scrollbarRailColor: "#eae9e9",
    scrollbarColor: "#201e1d",
    scrollbarActiveColor: "#000000",
    errorColor: "#ae1800",
  },
};

/** Derived. The design flags this as the least mechanical of the four to
 *  invert, because #201e1d is simultaneously the ink and every rule: a 2px
 *  paper-white rule on black blooms. So the dark build's rules sit a step
 *  under its text colour rather than equal to it. */
const MODERNIST_DARK: SkinMode = {
  chrome: {
    paper: "#1a1a19",
    chrome: "#1a1a19",
    sidebar: "#1a1a19",
    rule: "#d9d7d5",
    ruleSoft: "#d9d7d5",
    ruleFaint: "rgba(217, 215, 213, 0.4)",
    fillActive: "#ff563c",
    fillHover: "rgba(243, 242, 242, 0.08)",
    fillHoverChrome: "rgba(243, 242, 242, 0.1)",
    fillHoverSoft: "rgba(243, 242, 242, 0.06)",
    tint: "#232322",
    thumb: "#d9d7d5",
    text: "#f3f2f2",
    text2: "#cfcbc7",
    text3: "#a8a29c",
    textMuted: "#a8a29c",
    textFaint: "#6f6a66",
    accent: "#ff563c",
    accentDeep: "#ff9783",
    accentLabel: "#ff9783",
    accentTint: "rgba(255, 86, 60, 0.14)",
    dirty: "#ff563c",
    positive: "#f3f2f2",
    positiveRule: "#d9d7d5",
    positiveFill: "#232322",
    iconBorder: "#d9d7d5",
    danger: "#ff9783",
    shadow: "none",
    shadowStrong: "none",
    radiusPill: "0px",
    radiusLg: "0px",
    radiusMd: "0px",
    radiusSm: "0px",
    ruleWeight: "2px",
  },
  document: {
    bodyFamily: DOC_SERIF,
    headingFamily: DOC_SERIF,
    monoFamily: MONO,
    headingWeight: 700,
    lineHeight: 1.8,
    background: "#1a1a19",
    color: "#f3f2f2",
    mutedColor: "#a8a29c",
    accentColor: "#ff563c",
    codeBackground: "#232322",
    ruleColor: "#d9d7d5",
    highlightColor: "rgba(255, 86, 60, 0.24)",
    quoteColor: "#cfcbc7",
    quoteRuleColor: "#ff563c",
    tableRuleColor: "#f3f2f2",
    caretColor: "#f3f2f2",
    selectionColor: "rgba(255, 86, 60, 0.2)",
    matchColor: "rgba(255, 86, 60, 0.34)",
    veilColor: "rgba(26, 26, 25, 0.72)",
    scrollbarRailColor: "#232322",
    scrollbarColor: "#d9d7d5",
    scrollbarActiveColor: "#f3f2f2",
    errorColor: "#ff9783",
  },
};

// ── Nocturne ──────────────────────────────────────────────────────────────
// 4d. Regions are separated by stepping the ground rather than by ruling it,
// so the skin has exactly one divider — and that one fades out at both ends.
// Purple is a line and a glow, never a fill.

const NOCTURNE_DARK: SkinMode = {
  chrome: {
    paper: "#161826",
    chrome: "#1b1d2d",
    sidebar: "#191b2a",
    rule: "rgba(233, 233, 237, 0.12)",
    ruleSoft: "rgba(233, 233, 237, 0.1)",
    ruleFaint: "rgba(233, 233, 237, 0.07)",
    fillActive: "#232538",
    fillHover: "#1c1e2e",
    fillHoverChrome: "rgba(145, 132, 217, 0.12)",
    fillHoverSoft: "rgba(145, 132, 217, 0.1)",
    tint: "#1c1e2e",
    thumb: "#3a3d52",
    text: "#e9e9ed",
    text2: "#d5d6e0",
    text3: "#b6b7c6",
    textMuted: "#8b8ca0",
    textFaint: "#6f7189",
    accent: "#9184d9",
    accentDeep: "#b9aef0",
    accentLabel: "#b9aef0",
    accentTint: "rgba(145, 132, 217, 0.12)",
    dirty: "#9184d9",
    positive: "#b9aef0",
    positiveRule: "rgba(145, 132, 217, 0.5)",
    positiveFill: "#1c1e2e",
    iconBorder: "rgba(145, 132, 217, 0.5)",
    danger: "#e07a6a",
    shadow: "0 12px 32px rgba(8, 9, 16, 0.5)",
    shadowStrong: "0 16px 40px rgba(8, 9, 16, 0.6)",
    // 8px on everything rectangular, including the window. The dot and the
    // traffic lights are the only round things, and they set their own.
    radiusPill: "8px",
    radiusLg: "8px",
    radiusMd: "8px",
    radiusSm: "8px",
    ruleWeight: "1px",
  },
  document: {
    bodyFamily: DOC_SERIF,
    headingFamily: DOC_SERIF,
    monoFamily: MONO,
    headingWeight: 500,
    lineHeight: 1.8,
    background: "#161826",
    color: "#e9e9ed",
    mutedColor: "#8b8ca0",
    accentColor: "#9184d9",
    codeBackground: "#1c1e2e",
    ruleColor: "rgba(233, 233, 237, 0.12)",
    highlightColor: "rgba(145, 132, 217, 0.24)",
    quoteColor: "#b9aef0",
    quoteRuleColor: "rgba(145, 132, 217, 0.5)",
    tableRuleColor: "#b6b7c6",
    caretColor: "#e9e9ed",
    selectionColor: "rgba(145, 132, 217, 0.26)",
    matchColor: "rgba(185, 174, 240, 0.3)",
    veilColor: "rgba(22, 24, 38, 0.72)",
    scrollbarRailColor: "#1c1e2e",
    scrollbarColor: "#3a3d52",
    scrollbarActiveColor: "#6f7189",
    errorColor: "#e07a6a",
  },
};

export const SKINS: Skin[] = [
  {
    name: "organic",
    label: "Organic",
    description: "暖底 chrome、陶土点缀，正文区几乎纯净。",
    light: ORGANIC_LIGHT,
    dark: ORGANIC_DARK,
    fonts: { ui: UI_FIGTREE, mono: MONO },
    swatch: { bg: "#fdfaf4", ink: "#201e1d", accent: "#c67139", rule: "#ddd2bd", family: UI_FIGTREE },
  },
  {
    name: "classical",
    label: "Classical",
    description: "书籍气质：近白纸底、发丝线分栏，金色只作描边与下划线。",
    light: CLASSICAL_LIGHT,
    dark: CLASSICAL_DARK,
    fonts: { ui: UI_LORA, mono: MONO },
    swatch: { bg: "#faf9f9", ink: "#201f1d", accent: "#b68235", rule: "rgba(32,31,29,.22)", family: UI_LORA },
  },
  {
    name: "broadsheet",
    label: "Broadsheet",
    description: "报纸：没有框也没有分隔线，层级全靠字号与字距。",
    light: BROADSHEET_LIGHT,
    dark: BROADSHEET_DARK,
    fonts: { ui: UI_SOURCE_SERIF, mono: MONO },
    swatch: { bg: "#f3f2f2", ink: "#201e1d", accent: "#0088b0", rule: "transparent", family: UI_SOURCE_SERIF },
  },
  {
    name: "industry",
    label: "Industry",
    description: "蓝图：窗口、侧边栏与选中项都是带四角记号的线框。",
    light: INDUSTRY_LIGHT,
    dark: INDUSTRY_DARK,
    fonts: { ui: UI_BARLOW, mono: MONO },
    swatch: { bg: "#f2f2f3", ink: "#1d1f20", accent: "#5980a6", rule: "rgba(29,31,32,.28)", family: UI_BARLOW },
  },
  {
    name: "modernist",
    label: "Modernist",
    description: "瑞士：零圆角、2px 强规线，红色只给当前文件与主操作。",
    light: MODERNIST_LIGHT,
    dark: MODERNIST_DARK,
    fonts: { ui: UI_ARCHIVO, mono: MONO },
    swatch: { bg: "#f3f2f2", ink: "#201e1d", accent: "#ec3013", rule: "#201e1d", family: UI_ARCHIVO },
  },
  {
    name: "nocturne",
    label: "Nocturne",
    description: "夜间：蓝灰近黑底，紫作线与微光。天然深色，没有浅色版。",
    // The caption is explicit — 这套天然就是深色，不需要另做浅色 — so this one
    // has no light mode and `resolveMode` hands back its dark whatever the
    // appearance setting says.
    light: null,
    dark: NOCTURNE_DARK,
    fonts: { ui: UI_INTER, mono: MONO },
    swatch: { bg: "#161826", ink: "#e9e9ed", accent: "#9184d9", rule: "rgba(233,233,237,.12)", family: UI_INTER },
  },
];

export function findSkin(name: SkinName): Skin {
  return SKINS.find((s) => s.name === name) ?? SKINS[0];
}

/** Written as `--mm-fill-active` rather than `--mm-fillActive`. */
function cssName(key: string): string {
  return `--mm-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

const systemDark = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-color-scheme: dark)").matches;

/** Which of a skin's two modes an appearance setting resolves to. A skin that
 *  has only one mode gets that one whatever the setting says — Nocturne is
 *  dark by construction, and the design says so. */
export function resolveMode(skin: Skin, appearance: Appearance): "light" | "dark" {
  if (!skin.light) return "dark";
  if (!skin.dark) return "light";
  if (appearance === "system") return systemDark() ? "dark" : "light";
  return appearance;
}

export interface AppliedSkin {
  skin: Skin;
  mode: "light" | "dark";
  /** Hand this to `Editor.setTheme`. */
  document: DocumentPalette;
}

/**
 * Dress the window, and return the palette the page should be painted in.
 *
 * The chrome half lands on `:root` as custom properties; the document half is
 * returned rather than applied, because only the editor knows that changing a
 * colour means re-measuring the runs it is part of.
 */
export function applySkin(
  name: SkinName,
  appearance: Appearance,
  face: BodyFace,
): AppliedSkin {
  const skin = findSkin(name);
  const mode = resolveMode(skin, appearance);
  const resolved = (mode === "dark" ? skin.dark : skin.light) ?? skin.light ?? skin.dark;
  if (!resolved) throw new Error(`skin ${name} defines no mode`);

  const root = document.documentElement;
  for (const [key, value] of Object.entries(resolved.chrome)) {
    root.style.setProperty(cssName(key), value);
  }
  root.style.setProperty("--mm-font-ui", skin.fonts.ui);
  root.style.setProperty("--mm-font-mono", skin.fonts.mono);
  root.dataset.skin = skin.name;
  root.dataset.mode = mode;
  // Native form controls and scrollbars inside the chrome follow this.
  root.style.colorScheme = mode;

  const chosen = face === "theme" ? null : findFace(face);
  const palette: DocumentPalette = chosen
    ? {
        ...resolved.document,
        bodyFamily: faceStack(chosen),
        headingFamily: faceStack(chosen),
        headingWeight: chosen.headingWeight,
        lineHeight: chosen.lineHeight,
      }
    : resolved.document;

  return { skin, mode, document: palette };
}

/** Call back whenever the OS appearance flips, for the `system` setting. */
export function watchSystemAppearance(onChange: () => void): void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onChange);
}
