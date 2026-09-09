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
 * Organic is the one built out here. The other five design systems share this
 * shape exactly — each is a second entry in `SKINS` — which is why the type is
 * a table rather than a set of branches.
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
  /** Toolbar and status bar. */
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
  /** True once the skin has both modes built out. Cards for the rest are
   *  drawn from `swatch` and cannot be selected yet. */
  ready: boolean;
  /** Enough colour to draw the skin's card before the skin itself exists. */
  swatch: { bg: string; ink: string; accent: string; rule: string; family: string };
}

const UI_FIGTREE =
  'Figtree, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

/** The page's two faces. The serif is what the design calls "more like a TeX
 *  product"; the sans matches the chrome. Both put their Latin half first —
 *  see fonts.ts for why that ordering is load-bearing rather than cosmetic. */
export const DOC_SERIF = faceStack(findFace("serif")!);
export const DOC_SANS = faceStack(findFace("sans")!);

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
    positive: "#56633f",
    positiveRule: "#ccdbb2",
    positiveFill: "#e1eecc",
    iconBorder: "#d3c7b1",
    danger: "#b3402f",
    shadow: "0 12px 32px rgba(46, 43, 37, 0.22)",
    shadowStrong: "0 14px 34px rgba(46, 43, 37, 0.24)",
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
    // Booktabs wants its outer rules visibly heavier than the header rule;
    // the design's boxed table has no equivalent, so this is the muted ink.
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

/** 2c in the design. It is a warm-shifted dark, never an inversion: the ground
 *  keeps its brown, and the terracotta lifts to #e08c50 to stay legible on it.
 *
 *  The design collapses the sidebar in its only dark artboard, so the sidebar
 *  and its dividers are derived here rather than quoted: `sidebar` sits between
 *  the paper and the chrome bar, and the panel rules step down from `rule` by
 *  the same ratio they do in the light mode. */
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
    positive: "#9db07c",
    positiveRule: "#4a5238",
    positiveFill: "#2b3020",
    iconBorder: "#3f382c",
    danger: "#d2694f",
    shadow: "0 12px 32px rgba(20, 17, 13, 0.5)",
    shadowStrong: "0 14px 34px rgba(20, 17, 13, 0.55)",
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

export const SKINS: Skin[] = [
  {
    name: "organic",
    label: "Organic",
    description: "暖底 chrome、陶土点缀，正文区几乎纯净。",
    light: ORGANIC_LIGHT,
    dark: ORGANIC_DARK,
    fonts: { ui: UI_FIGTREE, mono: MONO },
    ready: true,
    swatch: { bg: "#fdfaf4", ink: "#201e1d", accent: "#c67139", rule: "#ddd2bd", family: UI_FIGTREE },
  },
  // The five below are drawn on the appearance pane but not yet selectable:
  // each needs its own SkinMode pair, which is the next round's work. Their
  // swatches come from the design systems' own token files.
  {
    name: "classical",
    label: "Classical",
    description: "书籍气质：近白纸底、发丝线分栏，金色只作描边。",
    light: null,
    dark: null,
    fonts: { ui: '"Cormorant Garamond", Lora, Georgia, serif', mono: MONO },
    ready: false,
    swatch: { bg: "#f3f2f2", ink: "#201f1d", accent: "#b68235", rule: "#d7d3d3", family: "Lora, Georgia, serif" },
  },
  {
    name: "broadsheet",
    label: "Broadsheet",
    description: "报纸：没有框也没有分隔线，层级全靠字号与字距。",
    light: null,
    dark: null,
    fonts: { ui: '"Source Serif 4", Georgia, serif', mono: MONO },
    ready: false,
    swatch: { bg: "#f3f2f2", ink: "#201e1d", accent: "#0088b0", rule: "#d7d3d3", family: '"Source Serif 4", Georgia, serif' },
  },
  {
    name: "industry",
    label: "Industry",
    description: "蓝图：窗口与气泡都是带四角记号的线框。",
    light: null,
    dark: null,
    fonts: { ui: 'Barlow, system-ui, sans-serif', mono: MONO },
    ready: false,
    swatch: { bg: "#f2f2f3", ink: "#1d1f20", accent: "#5980a6", rule: "#d4d4d7", family: "Barlow, system-ui, sans-serif" },
  },
  {
    name: "modernist",
    label: "Modernist",
    description: "瑞士：零圆角、2px 强规线，红色只给主操作。",
    light: null,
    dark: null,
    fonts: { ui: "Archivo, system-ui, sans-serif", mono: MONO },
    ready: false,
    swatch: { bg: "#f3f2f2", ink: "#201e1d", accent: "#ec3013", rule: "#201e1d", family: "Archivo, system-ui, sans-serif" },
  },
  {
    name: "nocturne",
    label: "Nocturne",
    description: "夜间：蓝灰近黑底，紫作线与微光。天然深色。",
    light: null,
    dark: null,
    fonts: { ui: "Inter, system-ui, sans-serif", mono: MONO },
    ready: false,
    swatch: { bg: "#161826", ink: "#e9e9ed", accent: "#9184d9", rule: "#3f424d", family: "Inter, system-ui, sans-serif" },
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
