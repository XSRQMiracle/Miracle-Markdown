/**
 * Block layout: markdown blocks in, positioned glyph runs out.
 *
 * The handshake with the Rust core is two calls per paragraph. The core says
 * what needs measuring, the host measures it (from cache, nearly always), and
 * the core breaks and positions. Results are cached per block and measure, so
 * typing re-typesets exactly one paragraph and everything else is a map hit.
 */

import init, { Engine } from "../../crates/typeset-wasm/pkg/typeset_wasm.js";
import {
  byteToCharIndex,
  charToByteIndex,
  cssFont,
  FALLBACK_MONO,
  FALLBACK_SANS,
  FALLBACK_SERIF,
  Measurer,
  type TextStyle,
} from "./measure.js";
import { renderMath, renderMathSegments } from "./mathjax.js";
import { sourceLineEnds } from "./source-layout.js";
import type { MathGeometry, MathSegment } from "./math.js";
import {
  parseBlocks,
  blockIndexAtPosition,
  fenceCloser,
  renderBlock,
  DEFAULT_INLINE_OPTIONS,
  OBJECT_REPLACEMENT,
  type InlineOptions,
  type Block,
  type RenderedBlock,
  type Span,
} from "../markdown/parse.js";

export interface Theme {
  bodySize: number;
  /** Width of the text column in pixels. Independent of `bodySize`, so that
   *  changing the type size changes how much fits on a line rather than where
   *  the page sits. */
  columnWidth: number;
  bodyFamily: string;
  headingFamily: string;
  monoFamily: string;
  lineHeight: number;
  color: string;
  mutedColor: string;
  accentColor: string;
  codeBackground: string;
  ruleColor: string;
}

export const DEFAULT_THEME: Theme = {
  bodySize: 18,
  columnWidth: 760,
  bodyFamily: FALLBACK_SERIF,
  headingFamily: FALLBACK_SANS,
  monoFamily: FALLBACK_MONO,
  lineHeight: 1.75,
  color: "#1a1a1a",
  mutedColor: "#8a8a8a",
  accentColor: "#2f6f4f",
  codeBackground: "#f5f4f1",
  ruleColor: "#dcdad4",
};

export interface TypesetOptions {
  justify: boolean;
  cjkLatinSpacing: boolean;
  punctSqueeze: boolean;
  protrusion: boolean;
  hyphenate: boolean;
  tolerance: number;
  maxExpand: number;
  punctStyle: 0 | 1 | 2;
  /** Draw the box/glue/penalty structure instead of hiding it. */
  showBadness: boolean;
  /** Which delimiters are recognised, and how strictly. */
  inline: InlineOptions;
  /**
   * Which displayed equations get a number.
   *
   * "ams" follows LaTeX: the numbered environments are numbered and their
   * starred forms are not, and a bare formula gets nothing. "all" numbers
   * every display, which is what a reader cross-referencing a draft usually
   * wants. An explicit \tag always wins, and \notag always suppresses.
   */
  numbering: "none" | "ams" | "all";
  /**
   * Whether an inline formula may break across lines.
   *
   * TeX does this by default, charging `\binoppenalty` (700) after a binary
   * operator and `\relpenalty` (500) after a relation, and only at the outer
   * level of the formula. Turning it off is the equivalent of setting both
   * penalties to infinity: formulas stay whole, and a long one near the end of
   * a line is shunted down entire, leaving the gap those penalties exist to
   * avoid.
   */
  breakInsideMath: boolean;
}

export const DEFAULT_OPTIONS: TypesetOptions = {
  justify: true,
  cjkLatinSpacing: true,
  punctSqueeze: true,
  protrusion: true,
  hyphenate: true,
  tolerance: 2.0,
  maxExpand: 0,
  punctStyle: 0,
  showBadness: false,
  inline: { ...DEFAULT_INLINE_OPTIONS },
  numbering: "none",
  breakInsideMath: true,
};

/** A formula, ready to draw: outlines plus the scale that puts them in
 *  pixels at the surrounding type size. */
export interface MathRun {
  geometry: MathGeometry;
  /** Actual box in CSS pixels, shared by line breaking and hit testing. */
  width: number;
  height: number;
  depth: number;
  /** Multiplier from the SVG's own units to pixels. */
  scale: number;
  /** LaTeX source, shown instead of the formula when it does not parse. */
  source: string;
  display: boolean;
  /** Measured text presentation while loading or after a conversion error. */
  fallback?: { text: string; style: TextStyle };
  /** The piece of a split formula this run draws, if it was split. */
  segment?: MathSegment;
}

/** One placeholder's worth of formula: its box and how it may break. */
interface MathPiece extends MathRun {
  /** TeX's penalty for breaking after this piece; NaN when it may not. */
  penaltyAfter: number;
}

export interface LaidRun {
  x: number;
  text: string;
  /** Document character range, for hit testing and caret placement. */
  docStart: number;
  docEnd: number;
  style: TextStyle;
  styleKey: string;
  /** Identity of the rendered span this run is painted from. */
  spanId: number;
  scaleX: number;
  /** Set on the hyphen the breaker inserted; it has no source of its own. */
  synthetic: boolean;
  /** Present on a run that draws a formula rather than text. */
  math?: MathRun;
}

export interface LaidLine {
  /** Editable source extent, independent of whether the line paints glyphs. */
  docStart: number;
  docEnd: number;
  /** Baseline, relative to the top of the block. Computed by the core using
   *  TeX's interline glue, not by multiplying out a fixed line height. */
  baseline: number;
  /** Distance from the baseline to the top of the line's tallest ink. */
  height: number;
  /** Distance from the baseline to the bottom of its deepest ink. */
  depth: number;
  runs: LaidRun[];
  ratio: number;
  width: number;
  indent: number;
}

export interface LaidBlock {
  block: Block;
  lines: LaidLine[];
  /** Total height including the space above and below the block. */
  height: number;
  spaceBefore: number;
  /** Vertical offset of the block within the document, filled in by the
   *  document layout pass. */
  y: number;
  rendered: RenderedBlock;
  indent: number;
  marker: string;
  raw: boolean;
}

// These are kept as sources rather than as shared RegExp objects on purpose.
// A global regular expression carries a mutable `lastIndex`, and `test` leaves
// it pointing past the match — so a later `matchAll` on the same object starts
// midway through the string and quietly finds nothing. Building a fresh one at
// each use costs nothing here and removes the whole class of bug.

/** `\label{...}` inside a formula. */
const LABEL_SOURCE = String.raw`\\label\s*\{([^}]*)\}`;
/** `\ref{...}` and `\eqref{...}`, the two ways to cite a numbered equation. */
const REFERENCE_SOURCE = String.raw`\\(eq)?ref\s*\{([^}]*)\}`;

const HAS_LABEL = new RegExp(LABEL_SOURCE);

function hasLabel(latex: string): boolean {
  return HAS_LABEL.test(latex);
}

/** Every label declared in a formula. */
function labelsIn(latex: string): string[] {
  return [...latex.matchAll(new RegExp(LABEL_SOURCE, "g"))].map((m) => m[1].trim());
}

/** Whether a block might contain a citation worth re-resolving. */
function citesAnything(block: Block): boolean {
  return block.source.includes("\\ref") || block.source.includes("\\eqref");
}

/**
 * Turn a formula's source into what MathJax should actually see: labels
 * removed, citations replaced by the numbers they resolve to.
 *
 * Neither MathJax nor KaTeX resolves `\ref` on its own — both lay out one
 * formula at a time and have no idea what else is in the document. Since the
 * numbering pass has just worked that out, substituting here is both simpler
 * and cheaper than handing MathJax a global counter to keep.
 *
 * An unresolved citation becomes `?`, which is LaTeX's own convention for a
 * reference to something that is not there.
 */
export function resolveLatex(latex: string, labels: Map<string, string>): string {
  let out = latex;
  if (out.includes("\\label")) out = out.replace(new RegExp(LABEL_SOURCE, "g"), "");
  if (out.includes("ref")) {
    out = out.replace(
      new RegExp(REFERENCE_SOURCE, "g"),
      (_match, eq: string | undefined, key: string) => {
        const number = labels.get(key.trim());
        if (number === undefined) return eq ? "(?)" : "?";
        return eq ? "(" + number + ")" : number;
      },
    );
  }
  return out;
}

/**
 * Assign every display equation its number, and record what each label
 * points at.
 *
 * This runs before layout because a reference may point forward: a
 * paragraph early in the document can cite an equation that appears much
 * later, and it cannot be typeset until that equation's number is known.
 * Two passes are the price of forward references, and the first is cheap —
 * it reads the source and never touches MathJax.
 */
export function numberEquations(
parsed: Block[],
mode: TypesetOptions["numbering"],
): Numbering {
  const tags = new Map<number, string>();
  const labels = new Map<string, string>();
  let equation = 0;
  for (let i = 0; i < parsed.length; i++) {
    const block = parsed[i];
    if (block.type !== "math") continue;
    const tag = equationTag(block.math, equation + 1, mode);
    if (tag === null) continue;
    equation++;
    tags.set(i, tag);
    for (const label of labelsIn(block.math)) {
      labels.set(label, tag);
    }
  }
  // Derived from the resolved values, so a block holding a reference
  // re-typesets exactly when the number it cites moves — and not when some
  // unrelated paragraph is edited.
  const version = [...labels].map(([k, v]) => k + "=" + v).join(",");
  return { tags, labels, version };
}

/**
 * The number a display formula should carry, or null for none.
 *
 * An explicit \tag is honoured whatever the setting; \notag and
 * \nonumber suppress. A \label also forces a number, in every mode
 * including "none": labelling an equation is an explicit request for
 * something to reference, and silently refusing would leave the citation
 * with nothing to resolve to. That is what makes "none" a useful default —
 * no numbers until an equation asks for one.
 *
 * Otherwise the setting decides, and under "ams" only the environments
 * LaTeX itself numbers qualify — the starred forms exist precisely to opt
 * out.
 */
export function equationTag(
latex: string,
next: number,
mode: TypesetOptions["numbering"],
): string | null {
  const explicit = /\\tag\s*\*?\s*\{([^}]*)\}/.exec(latex);
  if (explicit) return explicit[1];
  if (/\\(notag|nonumber)\b/.test(latex)) return null;
  if (hasLabel(latex)) return String(next);
  if (mode === "none") return null;
  if (mode === "all") return String(next);

  const env = /\\begin\s*\{([a-zA-Z]+\*?)\}/.exec(latex);
  if (!env) return null;
  const NUMBERED = ["equation", "align", "alignat", "gather", "multline", "flalign", "eqnarray"];
  return NUMBERED.includes(env[1]) ? String(next) : null;
}

/** What the numbering pass produces, before anything is laid out. */
export interface Numbering {
  /** Block index to the number that block's equation carries. */
  tags: Map<number, string>;
  /** Label to the number it resolves to. */
  labels: Map<string, string>;
  /** Changes exactly when some label's number changes. */
  version: string;
}

/** Token class codes, mirroring `CharClass` in the Rust core. */
const CLASS_LETTER = 4;
const CLASS_OBJECT = 7;

/** MathJax sizes its SVG in ex, and its fonts put the x-height at this many
 *  of the thousand units per em. Used only as a fallback when a formula is so
 *  degenerate that its width cannot give the scale. */
const MATHJAX_EX_UNITS = 442;

/** Characters the engine positions one at a time: CJK ideographs, kana, and
 *  the full-width punctuation whose empty half can be squeezed away. */
const INDIVIDUALLY_PLACED =
  /[\u2018\u2019\u201c\u201d\u2000-\u206f\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** True for a fragment that is safe to draw joined to its neighbour. */
export function isLatinWordPiece(text: string): boolean {
  return text.length > 0 && !INDIVIDUALLY_PLACED.test(text);
}

/**
 * UTF-8 byte boundaries at which token measurement or paint style changes.
 *
 * Markdown spans use JavaScript's UTF-16 indices while the Rust core slices
 * UTF-8. Keeping the conversion in one place prevents bold/link boundaries
 * beside emoji or non-ASCII text from landing inside a code point.
 */
export function spanByteBoundaries(text: string, spans: readonly Span[]): Uint32Array {
  const toByte = charToByteIndex(text);
  const total = toByte(text.length);
  const boundaries = new Set<number>();
  for (const span of spans) {
    for (const position of [span.start, span.end]) {
      const byte = toByte(position);
      if (byte > 0 && byte < total) boundaries.add(byte);
    }
  }
  return Uint32Array.from([...boundaries].sort((a, b) => a - b));
}

let engine: Engine | null = null;

export async function initEngine(): Promise<void> {
  await init();
  engine = new Engine();
}

/** Style lookup for a span, cached by key so `measureText` can key on it. */
function styleForSpan(
  theme: Theme,
  block: Block,
  span: Span | null,
): { style: TextStyle; key: string } {
  const heading = block.type === "heading";
  const code = block.type === "code" || span?.code;

  let size = theme.bodySize;
  if (heading) {
    const scale = [1.9, 1.55, 1.3, 1.15, 1.05, 1.0][Math.min(block.level, 6) - 1] ?? 1;
    size = Math.round(theme.bodySize * scale);
  } else if (code) {
    size = Math.round(theme.bodySize * 0.88);
  }

  const family = code
    ? theme.monoFamily
    : heading
      ? theme.headingFamily
      : theme.bodyFamily;
  const weight = heading ? 700 : span?.strong ? 700 : 400;
  const italic = !!span?.em;
  const color = span?.href
    ? theme.accentColor
    : block.type === "quote"
      ? theme.mutedColor
      : theme.color;

  const style: TextStyle = {
    family,
    size,
    weight,
    italic,
    color,
    lineHeight: heading ? 1.35 : code ? 1.55 : theme.lineHeight,
  };
  return { style, key: cssFont(style) };
}

/** Extra space above a block, in pixels. TeX's vertical glue. */
function spaceAbove(block: Block, theme: Theme, previous: Block | null): number {
  if (!previous || previous.type === "blank") return 0;
  switch (block.type) {
    case "heading":
      // Headings bind more tightly to what follows than to what precedes.
      return theme.bodySize * (block.level <= 2 ? 1.6 : 1.2);
    case "code":
      return theme.bodySize * 0.9;
    case "rule":
      return theme.bodySize * 1.2;
    case "blank":
      return 0;
    case "list":
      return previous.type === "list" ? theme.bodySize * 0.25 : theme.bodySize * 0.7;
    default:
      return theme.bodySize * 0.7;
  }
}

export class Typesetter {
  private measurer = new Measurer();
  private cache = new Map<string, LaidBlock>();
  private version = 0;

  constructor(
    public theme: Theme = { ...DEFAULT_THEME },
    public options: TypesetOptions = { ...DEFAULT_OPTIONS },
  ) {}

  get ready(): Promise<void> {
    return this.measurer.ready;
  }

  /** Invalidate everything. Called when the theme or options change. */
  invalidate(): void {
    this.measurer.invalidate();
    this.cache.clear();
    this.vcache.clear();
    this.pieceCache.clear();
    this.version++;
  }

  measureText(text: string, style: TextStyle, key: string): number {
    return this.measurer.width(text, style, key);
  }

  prefixWidth(text: string, chars: number, style: TextStyle): number {
    return this.measurer.prefixWidth(text, chars, style);
  }


  private vcache = new Map<string, { ascent: number; descent: number }>();

  /** Ascent and descent for a style, cached — every token asks for them. */
  vmetrics(style: TextStyle, key: string): { ascent: number; descent: number } {
    let hit = this.vcache.get(key);
    if (!hit) {
      hit = this.measurer.vmetrics(style);
      this.vcache.set(key, hit);
    }
    return hit;
  }

  /** Lay out a whole document, returning blocks with absolute y positions. */
  layoutDocument(
    doc: string,
    width: number,
    focusedPosition: number,
  ): { blocks: LaidBlock[]; height: number } {
    const parsed = parseBlocks(doc, this.options.inline);
    // Most blocks exclude the trailing LF, but an unterminated code/math
    // block owns it and already lays out its final source line when focused.
    // Only synthesize a line when no parsed block owns that insertion point.
    if (doc.endsWith("\n") && parsed.at(-1)?.end !== doc.length) {
      parsed.push({
        type: "blank", start: doc.length, end: doc.length, source: "",
        level: 0, ordered: false, marker: "", lang: "", math: "", task: "none",
      });
    }
    const focusedBlock = blockIndexAtPosition(parsed, focusedPosition);
    const numbering = numberEquations(parsed, this.options.numbering);
    const out: LaidBlock[] = [];
    let y = 0;
    for (let i = 0; i < parsed.length; i++) {
      const b = parsed[i];
      const laid = this.layoutBlock(
        b,
        width,
        i === focusedBlock,
        out.at(-1)?.block ?? null,
        numbering.tags.get(i) ?? null,
        numbering,
      );
      laid.y = y + laid.spaceBefore;
      y = laid.y + laid.height - laid.spaceBefore;
      out.push(laid);
    }
    return { blocks: out, height: y };
  }

  private layoutBlock(
    block: Block,
    width: number,
    raw: boolean,
    previous: Block | null,
    tag: string | null,
    numbering: Numbering,
  ): LaidBlock {
    // A block that cites an equation has to be re-laid-out when that
    // equation's number moves, and only then; one that cites nothing is
    // untouched by an edit elsewhere in the document.
    const cites = citesAnything(block) ? numbering.version : "";
    const key = `${this.version}|${width.toFixed(1)}|${raw ? 1 : 0}|${previous?.type ?? ""}|${block.type}|${block.level}|${block.start}|${tag ?? ""}|${cites}|${block.source}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    const laid = this.buildBlock(block, width, raw, previous, tag, numbering);
    // A cache that grows without bound would outlive its usefulness on a long
    // document; the working set is the visible screen plus a little.
    if (this.cache.size > 4000) this.cache.clear();
    this.cache.set(key, laid);
    return laid;
  }

  private buildBlock(
    block: Block,
    width: number,
    raw: boolean,
    previous: Block | null,
    tag: string | null,
    numbering: Numbering,
  ): LaidBlock {
    const theme = this.theme;
    const rendered = renderBlock(block, raw, this.options.inline);
    const spaceBefore = spaceAbove(block, theme, previous);

    // Source editing is a presentation mode shared by every block kind.
    // Resolve it before preview-only math/rule builders so their atomic
    // geometry can never hide editable delimiters or physical source lines.
    if (raw || block.type === "blank") {
      return this.buildPreformatted(block, rendered, spaceBefore, 0, raw, width);
    }

    const indent =
      block.type === "quote"
        ? theme.bodySize * 1.4
        : block.type === "list"
          ? theme.bodySize * 1.6 * block.level
          : 0;
    const measure = Math.max(width - indent, theme.bodySize * 4);

    if (block.type === "math") {
      return this.buildDisplayMath(
        block,
        rendered,
        spaceBefore,
        measure,
        indent,
        tag,
        numbering,
      );
    }

    if (block.type === "rule") {
      return {
        block,
        lines: [],
        height: spaceBefore + theme.bodySize * 1.2,
        spaceBefore,
        y: 0,
        rendered,
        indent,
        marker: "",
        raw,
      };
    }

    // Code keeps its own line structure: breaking it optimally would be
    // actively wrong.
    if (block.type === "code") {
      return this.buildPreformatted(block, rendered, spaceBefore, indent, raw);
    }

    const lines = this.breakParagraph(block, rendered, measure, indent, numbering);

    const first = lines[0];
    const lh = first
      ? first.runs[0]?.style.lineHeight ?? theme.lineHeight
      : theme.lineHeight;
    // Interline glue already respects each line's ink in the Rust core. The
    // block boundary must do the same: a deep last-line formula cannot fit
    // inside the ordinary text's nominal descent allowance.
    const last = lines.at(-1);
    const height = spaceBefore + (last
      ? last.baseline + Math.max(last.depth, theme.bodySize * lh * 0.35)
      : 0);

    return {
      block,
      lines,
      height,
      spaceBefore,
      y: 0,
      rendered,
      indent,
      marker: block.type === "list" ? block.marker : "",
      raw,
    };
  }

  /**
   * A display formula: its own block, centred on the measure.
   *
   * LaTeX sets displayed equations on their own line with generous space above
   * and below — `\abovedisplayskip` and `\belowdisplayskip` — because the
   * formula is a unit of the argument rather than part of a sentence. The
   * numbers here follow that shape at 1.1 and 1.1 em, close to LaTeX's own
   * 10pt-on-12pt defaults once scaled.
   */
  private buildDisplayMath(
    block: Block,
    rendered: RenderedBlock,
    spaceBefore: number,
    measure: number,
    indent: number,
    tag: string | null,
    numbering: Numbering,
  ): LaidBlock {
    const { style, key } = styleForSpan(this.theme, block, null);
    const latex = resolveLatex(block.math, numbering.labels);
    const math = this.mathRun(renderMath(latex, true), latex, true, style);
    const { width, height, depth } = math;

    // Centre it, but never push it off the left edge: an equation wider than
    // the measure overflows to the right, as LaTeX's does.
    const x = Math.max(0, (measure - width) / 2);

    const runs: LaidRun[] = [
      {
        x,
        text: "",
        docStart: block.start,
        docEnd: block.end,
        style,
        styleKey: key,
        spanId: 0,
        scaleX: 1,
        synthetic: false,
        math,
      },
    ];

    // The number sits flush to the right margin, as LaTeX's does — not beside
    // the formula, which would move as the formula's width changed.
    if (tag !== null) {
      const label = `(${tag})`;
      const labelWidth = this.measurer.width(label, style, key);
      runs.push({
        x: Math.max(x + width + this.theme.bodySize, measure - labelWidth),
        text: label,
        docStart: block.start,
        docEnd: block.start,
        style,
        styleKey: key,
        spanId: -1,
        scaleX: 1,
        synthetic: true,
      });
    }

    const above = this.theme.bodySize * 1.1;
    const below = this.theme.bodySize * 1.1;
    return {
      block,
      lines: [
        {
          docStart: block.start,
          docEnd: block.end,
          baseline: above + height,
          height,
          depth,
          runs,
          ratio: 0,
          width,
          indent,
        },
      ],
      height: spaceBefore + above + height + depth + below,
      spaceBefore,
      y: 0,
      rendered,
      indent,
      marker: "",
      raw: false,
    };
  }

  /** Preserve physical source lines; focused source also wraps to the measure. */
  private buildPreformatted(
    block: Block,
    rendered: RenderedBlock,
    spaceBefore: number,
    indent: number,
    raw: boolean,
    width = Infinity,
  ): LaidBlock {
    const { style, key } = styleForSpan(this.theme, block, null);
    const lineHeight = style.size * style.lineHeight;
    const v = this.vmetrics(style, key);
    const lines: LaidLine[] = [];
    const text = rendered.text;
    let at = 0;
    let n = 0;
    // A fenced block's own ``` lines are structure, not content.
    const hideFence = block.type === "code" && !raw;
    const src = text.split("\n");
    const closingFence = hideFence ? fenceCloser(src[0]) : null;
    for (let li = 0; li < src.length; li++) {
      const lineText = src[li];
      const isFence = closingFence !== null &&
        (li === 0 || (li === src.length - 1 && closingFence.test(lineText)));
      if (!isFence) {
        const ends = raw
          ? sourceLineEnds(lineText, width, (part) => this.measurer.width(part, style, key))
          : [lineText.length];
        let start = 0;
        for (const end of ends) {
          const part = lineText.slice(start, end);
          const docStart = rendered.map[at + start];
          const docEnd = rendered.map[at + end];
          lines.push({
            docStart,
            docEnd,
            baseline: n * lineHeight + v.ascent,
            height: v.ascent,
            depth: v.descent,
            ratio: 0,
            width: this.measurer.width(part, style, key),
            indent,
            runs: part.length
              ? [
                  {
                    x: 0,
                    text: part,
                    docStart,
                    docEnd,
                    style,
                    styleKey: key,
                    spanId: 0,
                    scaleX: 1,
                    synthetic: false,
                  },
                ]
              : [],
          });
          n++;
          start = end;
        }
      }
      at += lineText.length + 1;
    }
    const height = spaceBefore + n * lineHeight + (block.type === "blank" ? 0 : style.size * 0.5);
    return {
      block,
      lines,
      height,
      spaceBefore,
      y: 0,
      rendered,
      indent,
      marker: "",
      raw,
    };
  }

  /**
   * Rejoin runs that are contiguous in the source, share a style and sit
   * flush against one another — the pieces of a word that was offered a
   * hyphenation point but not broken at it.
   *
   * Drawing them as one `fillText` restores the kerning across the join.
   *
   * Restricted to Latin script, because that is the only thing coalescing is
   * for. A CJK glyph is positioned individually — squeezed punctuation is
   * shifted inside its own em box — and merging those into one draw call
   * would hand their positions back to the platform and undo the adjustment.
   * The flush-position check below would catch most such cases, but "most" is
   * not worth relying on when "only ever join letters" is simpler and exact.
   */
  private coalesce(runs: LaidRun[]): LaidRun[] {
    if (runs.length < 2) return runs;
    const out: LaidRun[] = [runs[0]];
    for (let i = 1; i < runs.length; i++) {
      const run = runs[i];
      const prev = out[out.length - 1];
      const joinable =
        !run.synthetic &&
        !prev.synthetic &&
        !run.math &&
        !prev.math &&
        isLatinWordPiece(prev.text) &&
        isLatinWordPiece(run.text) &&
        prev.styleKey === run.styleKey &&
        prev.spanId === run.spanId &&
        prev.scaleX === run.scaleX &&
        prev.docEnd === run.docStart &&
        Math.abs(
          prev.x + this.measureText(prev.text, prev.style, prev.styleKey) * prev.scaleX - run.x,
        ) < 0.05;
      if (joinable) {
        out[out.length - 1] = { ...prev, text: prev.text + run.text, docEnd: run.docEnd };
      } else {
        out.push(run);
      }
    }
    return out;
  }

  /**
   * Expand each formula placeholder into one placeholder per breakable piece.
   *
   * A formula reaches this point as a single U+FFFC. TeX allows an inline
   * formula to break after an outer-level binary operator or relation, so a
   * formula that offers such a point is handed to the optimiser as several
   * boxes with `\binoppenalty` or `\relpenalty` between them. From the
   * breaker's side nothing is new — that is the point of having modelled a
   * formula as a box in the first place.
   *
   * The source map gives every piece the formula's own starting offset, so
   * clicking anywhere in a formula puts the caret at its opening delimiter and
   * reveals the source, however the formula happens to be split at the time.
   */
  private expandMath(
    rendered: RenderedBlock,
    style: TextStyle,
    key: string,
    numbering: Numbering,
  ): { rendered: RenderedBlock; pieces: Map<number, MathPiece> } {
    if (!rendered.text.includes(OBJECT_REPLACEMENT)) {
      return { rendered, pieces: new Map() };
    }

    const pieces = new Map<number, MathPiece>();
    let text = "";
    const map: number[] = [];
    // Where each original character ended up, so spans can be moved with it.
    const shifted = new Int32Array(rendered.text.length + 1);

    for (let i = 0; i < rendered.text.length; i++) {
      shifted[i] = text.length;
      if (rendered.text[i] !== OBJECT_REPLACEMENT) {
        text += rendered.text[i];
        map.push(rendered.map[i]);
        continue;
      }
      const built = this.buildMathPieces(rendered, i, style, key, numbering);
      for (const piece of built) {
        pieces.set(text.length, piece);
        text += OBJECT_REPLACEMENT;
        map.push(rendered.map[i]);
      }
    }
    shifted[rendered.text.length] = text.length;
    map.push(rendered.map[rendered.map.length - 1]);

    const spans = rendered.spans.map((span) => ({
      ...span,
      start: shifted[span.start],
      end: shifted[span.end],
    }));

    return { rendered: { text, spans, map: Int32Array.from(map) }, pieces };
  }

  /** Lay out the formula at `charIndex` and split it if TeX would allow. */
  private buildMathPieces(
    rendered: RenderedBlock,
    charIndex: number,
    style: TextStyle,
    key: string,
    numbering: Numbering,
  ): MathPiece[] {
    const span = rendered.spans.find(
      (s) => s.kind === "math" && charIndex >= s.start && charIndex < s.end,
    );
    // References are resolved before the cache key is built, so a formula
    // whose citation now points at a different number is a different entry.
    const latex = resolveLatex(span?.math ?? "", numbering.labels);
    const display = span?.display ?? false;
    const ex = this.measurer.exHeight(style);
    const cacheKey = `${key}|${display ? "d" : "i"}|${ex.toFixed(2)}|${latex}`;
    const hit = this.pieceCache.get(cacheKey);
    if (hit) return hit;

    const { geometry, segments } = this.options.breakInsideMath
      ? renderMathSegments(latex, display)
      : { geometry: renderMath(latex, display), segments: [] };
    const common = this.mathRun(geometry, latex, display, style);
    let built: MathPiece[];
    if (common.fallback || segments.length < 2) {
      built = [{ ...common, penaltyAfter: NaN }];
    } else {
      // Every piece is given the whole formula's height and depth. That is
      // conservative — a piece with no tall part gets more leading than it
      // strictly needs — but it can never let two lines collide, and formulas
      // that break at an outer-level operator are usually of even height
      // anyway.
      built = segments.map((segment) => ({
        ...common,
        segment,
        width: segment.width * common.scale,
        penaltyAfter: segment.penaltyAfter ?? NaN,
      }));
    }

    if (this.pieceCache.size > 2000) this.pieceCache.clear();
    this.pieceCache.set(cacheKey, built);
    return built;
  }

  private pieceCache = new Map<string, MathPiece[]>();

  /** Resolve the painted representation before anyone consumes its metrics. */
  private mathRun(
    geometry: MathGeometry,
    source: string,
    display: boolean,
    style: TextStyle,
  ): MathRun {
    if (geometry.error) {
      const fallbackStyle: TextStyle = {
        ...style, family: this.theme.monoFamily, italic: false,
        color: geometry.error === "loading" ? this.theme.mutedColor : "#b3402f",
      };
      // Canvas paints ASCII whitespace as spaces, even for multi-line TeX.
      // Store exactly that presentation so measuring and drawing cannot drift.
      const text = source.replace(/[\t\n\r\f]/g, " ").trim() || "…";
      const key = cssFont(fallbackStyle);
      const { ascent, descent } = this.vmetrics(fallbackStyle, key);
      return {
        geometry, source, display, scale: 1,
        width: this.measurer.width(text, fallbackStyle, key),
        height: ascent, depth: descent, fallback: { text, style: fallbackStyle },
      };
    }
    const ex = this.measurer.exHeight(style);
    const width = geometry.widthEx * ex;
    return {
      geometry, source, display, width,
      scale: geometry.viewBoxWidth > 0 && width > 0
        ? width / geometry.viewBoxWidth : ex / MATHJAX_EX_UNITS,
      height: (geometry.heightEx - geometry.depthEx) * ex,
      depth: geometry.depthEx * ex,
    };
  }

  /** The real work: hand the paragraph to the Knuth-Plass core. */
  private breakParagraph(
    block: Block,
    rendered: RenderedBlock,
    measure: number,
    indent: number,
    numbering: Numbering,
  ): LaidLine[] {
    if (!engine) throw new Error("engine not initialised");
    if (!rendered.text.length) return [];

    const base = styleForSpan(this.theme, block, null);
    const expanded = this.expandMath(rendered, base.style, base.key, numbering);
    rendered = expanded.rendered;
    const pieces = expanded.pieces;
    engine.configure(
      base.style.size,
      this.options.justify && block.type !== "heading",
      this.options.cjkLatinSpacing,
      this.options.punctSqueeze,
      this.options.protrusion,
      this.options.hyphenate,
      this.options.tolerance,
      this.options.maxExpand,
      this.options.punctStyle,
      base.style.size * base.style.lineHeight,
      base.style.size * 0.08,
    );

    const text = rendered.text;
    const tokens = engine.tokenize(text, spanByteBoundaries(text, rendered.spans));
    const count = tokens.length / 3;
    // Four floats per token: advance, height, depth, and the penalty for
    // breaking after it — the last is how a split formula's pieces are joined.
    const metrics = new Float32Array(count * 4);

    // Resolve which span a byte offset falls in, so bold and code runs are
    // measured with the face they will be drawn in.
    const toChar = byteToCharIndex(text);
    const spanStyles = rendered.spans.map((s, id) => ({
      span: s,
      id,
      ...styleForSpan(this.theme, block, s),
    }));
    const fallbackStyle = { span: null, id: -1, ...base };
    const styleAt = (byteOffset: number) => {
      const ch = toChar(byteOffset);
      for (const s of spanStyles) {
        if (ch >= s.span.start && ch < s.span.end) return s;
      }
      return spanStyles[0] ?? fallbackStyle;
    };

    // Measure. Pieces of one hyphenated word arrive as separate tokens that
    // touch in the source; those are measured as differences between prefixes
    // of the whole word, so the kerning between them is counted exactly once
    // and the pieces sum to the width the word has when it is not broken.
    for (let i = 0, t = 0; i < count; ) {
      let n = 1;
      const st = styleAt(tokens[t]);
      if (tokens[t + 2] === CLASS_LETTER) {
        while (
          i + n < count &&
          tokens[t + n * 3 + 2] === CLASS_LETTER &&
          tokens[t + n * 3] === tokens[t + (n - 1) * 3 + 1] &&
          styleAt(tokens[t + n * 3]).key === st.key &&
          styleAt(tokens[t + n * 3]).id === st.id
        ) {
          n++;
        }
      }
      const v = this.vmetrics(st.style, st.key);

      // A formula arrives as U+FFFC. Its box is whatever MathJax laid out,
      // measured in ex against this style so it sits at the right optical
      // size, and it brings a height and a depth that the line must respect.
      if (tokens[t + 2] === CLASS_OBJECT) {
        const piece = pieces.get(toChar(tokens[t]));
        metrics[i * 4] = piece?.width ?? 0;
        metrics[i * 4 + 1] = Math.max(piece?.height ?? 0, v.ascent * 0.2);
        metrics[i * 4 + 2] = piece?.depth ?? 0;
        metrics[i * 4 + 3] = piece?.penaltyAfter ?? NaN;
        i += 1;
        t += 3;
        continue;
      }

      if (n === 1) {
        const slice = text.slice(toChar(tokens[t]), toChar(tokens[t + 1]));
        metrics[i * 4] = this.measurer.width(slice, st.style, st.key);
      } else {
        const from = toChar(tokens[t]);
        let previous = 0;
        for (let k = 0; k < n; k++) {
          const upto = toChar(tokens[t + k * 3 + 1]);
          const cumulative = this.measurer.width(text.slice(from, upto), st.style, st.key);
          metrics[(i + k) * 4] = cumulative - previous;
          previous = cumulative;
        }
      }
      for (let k = 0; k < n; k++) {
        metrics[(i + k) * 4 + 1] = v.ascent;
        metrics[(i + k) * 4 + 2] = v.descent;
        metrics[(i + k) * 4 + 3] = NaN;
      }
      i += n;
      t += n * 3;
    }

    engine.prepare(metrics, this.measurer.spaceWidth(base.style, base.key));
    const flat = engine.layout(measure);

    // Decode the flat buffer the core returned.
    const lines: LaidLine[] = [];
    const lineCount = flat[0];
    let p = 1;
    for (let l = 0; l < lineCount; l++) {
      const runCount = flat[p];
      const ratio = flat[p + 1];
      const width = flat[p + 2];
      const docStart = rendered.map[toChar(flat[p + 4])];
      const docEnd = rendered.map[toChar(flat[p + 5])];
      const baseline = flat[p + 6];
      const height = flat[p + 7];
      const depth = flat[p + 8];
      p += 9;
      const runs: LaidRun[] = [];
      for (let r = 0; r < runCount; r++) {
        const x = flat[p];
        const s = flat[p + 1];
        const e = flat[p + 2];
        const scaleX = flat[p + 3];
        p += 4;
        if (s < 0) {
          const prev = runs.at(-1);
          runs.push({
            x,
            text: "-",
            docStart: prev?.docEnd ?? 0,
            docEnd: prev?.docEnd ?? 0,
            style: prev?.style ?? base.style,
            styleKey: prev?.styleKey ?? base.key,
            spanId: prev?.spanId ?? -1,
            scaleX,
            synthetic: true,
          });
          continue;
        }
        const cs = toChar(s);
        const ce = toChar(e);
        const st = styleAt(s);
        const slice = text.slice(cs, ce);
        runs.push({
          x,
          text: slice,
          docStart: rendered.map[cs] ?? 0,
          docEnd: rendered.map[ce] ?? rendered.map[rendered.map.length - 1],
          style: st.style,
          styleKey: st.key,
          spanId: st.id,
          scaleX,
          synthetic: false,
          math: slice === OBJECT_REPLACEMENT ? pieces.get(cs) : undefined,
        });
      }
      lines.push({
        docStart,
        docEnd,
        baseline,
        height,
        depth,
        runs: this.coalesce(runs),
        ratio,
        width,
        indent,
      });
    }
    return lines;
  }
}
