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
import { renderMath, renderMathSegments, renderDisplayMath } from "./mathjax.js";
import { mathDirectives, resolveMathSource } from "./math-source.js";
import { fitImage, requestImage, type ImageStatus } from "./images.js";
import { sourceLineEnds } from "./source-layout.js";
import type { MathGeometry, MathSegment } from "./math.js";
import {
  parseBlocks,
  parseInline,
  blockIndexAtPosition,
  fenceCloser,
  renderBlock,
  DEFAULT_INLINE_OPTIONS,
  OBJECT_REPLACEMENT,
  type InlineOptions,
  type Block,
  type RenderedBlock,
  type Span,
  type ColumnAlign,
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
  /** Behind ==highlighted== text. */
  highlightColor: string;
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
  highlightColor: "#fbeaa8",
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

/** A picture, ready to draw. */
export interface ImageRun {
  source: CanvasImageSource | null;
  /** Drawn size in CSS pixels, already fitted to the measure. */
  width: number;
  height: number;
  status: ImageStatus;
  src: string;
  alt: string;
  /** Measured alt-text presentation while loading or after a failure. */
  fallback?: { text: string; style: TextStyle };
}

/**
 * One placeholder's worth of content: its box, how it may break, and which
 * kind of object it stands for. The line breaker reads only the box; the
 * discriminator is for the renderer.
 */
interface ObjectBox {
  width: number;
  height: number;
  depth: number;
  /** TeX's penalty for breaking after this piece; NaN when it may not. */
  penaltyAfter: number;
}

interface MathPiece extends MathRun, ObjectBox {
  kind: "math";
}

interface ImagePiece extends ObjectBox {
  kind: "image";
  image: ImageRun;
}

/** A footnote's raised number, at the reference or before its definition. */
export interface NoteRun {
  text: string;
  style: TextStyle;
  /** How far above the baseline the number sits. */
  raise: number;
}

interface NotePiece extends ObjectBox {
  kind: "note";
  note: NoteRun;
}

type ObjectPiece = MathPiece | ImagePiece | NotePiece;

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
  /** Present on a run that draws a picture rather than text. */
  image?: ImageRun;
  /** Present on a run that draws a footnote's raised number. */
  note?: NoteRun;
  /** Destination of the link this run is part of, if it is part of one. */
  href?: string;
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
  /** Column geometry, so the renderer can draw the rules a table needs. */
  table?: TableLayout;
  /** A footnote definition's own number, drawn before its text. */
  note?: NoteRun;
}

/** Where a table's columns sit, and which lines begin each row. */
export interface TableLayout {
  columns: number;
  /** Left edge of each column, relative to the block's indent. */
  x: number[];
  widths: number[];
  /** Index into `lines` at which each row starts. */
  rowStarts: number[];
  padding: number;
}

/** Whether this block depends on document-wide equation/footnote numbering. */
function usesNumbering(block: Block): boolean {
  // Detect commands, not their raw argument text: stripping quote markers
  // can change a multiline argument before the formula resolves its label.
  return block.type === "footnote" || block.source.includes("[^") ||
    block.source.includes("\\ref") || block.source.includes("\\eqref");
}

/** Resolve document references without taking ownership of TeX tag syntax. */
export const resolveLatex = resolveMathSource;

/**
 * Assign every display equation its number, and record what each label
 * points at.
 *
 * This runs before layout because a reference may point forward: a
 * paragraph early in the document can cite an equation that appears much
 * later, and it cannot be typeset until that equation's number is known.
 * The metadata pass shares the formula cache with layout, so unchanged
 * formulas do not need to be parsed by MathJax again.
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
    // The actual TeX parser decides which commands execute, including tags
    // expanded from macros and separate tags/labels on aligned rows. The
    // lexical fallback is used only while MathJax is loading or source is
    // incomplete; the normal math-ready invalidation replaces that layout.
    const semantic = renderMath(block.math, true).equation;
    const tag = semantic
      ? semantic.tags[0] ?? (semantic.suppressed ? null
        : semantic.labels.length || mode === "all" || (mode === "ams" && semantic.numberedEnvironment)
          ? String(equation + 1) : null)
      : equationTag(block.math, equation + 1, mode);
    if (tag === null) continue;
    equation++;
    tags.set(i, tag);
    if (semantic) {
      for (const label of semantic.labels) labels.set(label, semantic.references[label] ?? tag);
    } else {
      for (const directive of mathDirectives(block.math)) {
        if (directive.name === "label") labels.set(directive.value.trim(), tag);
      }
    }
  }
  // Derived from the resolved values, so a block holding a reference
  // re-typesets exactly when the number it cites moves — and not when some
  // unrelated paragraph is edited.
  const notes = numberFootnotes(parsed);
  const version = [...labels].map(([k, v]) => k + "=" + v).join(",") +
    "|" + [...notes].map(([k, v]) => k + "=" + v).join(",");
  return { tags, labels, notes, version };
}

/**
 * Number the footnotes.
 *
 * By first reference rather than by where the definitions sit, which is the
 * convention every typesetter follows: a reader meets the marks in reading
 * order, so 1 must be the first one they see. A definition nobody cites still
 * earns a number, at the end, so that editing it is not confusing.
 */
function numberFootnotes(parsed: Block[]): Map<string, string> {
  const notes = new Map<string, string>();
  const reference = new RegExp(String.raw`\[\^([^\]\s]+)\]`, "g");
  for (const block of parsed) {
    if (block.type === "footnote") continue;
    for (const match of block.source.matchAll(reference)) {
      if (!notes.has(match[1])) notes.set(match[1], String(notes.size + 1));
    }
  }
  for (const block of parsed) {
    if (block.type === "footnote" && block.label && !notes.has(block.label)) {
      notes.set(block.label, String(notes.size + 1));
    }
  }
  return notes;
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
  const directives = mathDirectives(latex);
  const explicit = directives.find((directive) => directive.name === "tag");
  if (explicit) return explicit.value;
  if (directives.some((directive) => directive.name === "notag" || directive.name === "nonumber")) return null;
  if (directives.some((directive) => directive.name === "label")) return String(next);
  if (mode === "none") return null;
  if (mode === "all") return String(next);

  const NUMBERED = ["equation", "align", "alignat", "gather", "multline", "flalign", "eqnarray"];
  return directives.some((directive) => directive.name === "begin" && NUMBERED.includes(directive.value))
    ? String(next) : null;
}

/** What the numbering pass produces, before anything is laid out. */
export interface Numbering {
  /** Block index to the number that block's equation carries. */
  tags: Map<number, string>;
  /** Label to the number it resolves to. */
  labels: Map<string, string>;
  /** Footnote label to its number, in order of first reference. */
  notes: Map<string, string>;
  /** Changes exactly when some label's number changes. */
  version: string;
}

/** Token class codes, mirroring `CharClass` in the Rust core. */
const CLASS_LETTER = 4;
const CLASS_OBJECT = 7;
const CLASS_WESTERN_PUNCT = 9;
const METRIC_STRIDE = 6;
const isShapedText = (tokenClass: number) =>
  tokenClass === CLASS_LETTER || tokenClass === CLASS_WESTERN_PUNCT;

/** MathJax sizes its SVG in ex, and its fonts put the x-height at this many
 *  of the thousand units per em. Used only as a fallback when a formula is so
 *  degenerate that its width cannot give the scale. */
const MATHJAX_EX_UNITS = 442;

/** Characters the engine positions one at a time: CJK ideographs, kana, and
 *  the full-width punctuation whose empty half can be squeezed away. */
const INDIVIDUALLY_PLACED =
  /[\s\ufffc\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u{20000}-\u{2a6df}\u{2a700}-\u{2ebef}\u{30000}-\u{323af}]/u;

/** True for a fragment that is safe to draw joined to its neighbour. */
export function isLatinWordPiece(text: string): boolean {
  return text.length > 0 && !INDIVIDUALLY_PLACED.test(text);
}

/** First span whose end follows this character; spans are ordered/disjoint. */
function spanIndexAt(spans: readonly Span[], position: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid].end <= position) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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
  const code =
    block.type === "code" ||
    block.type === "frontmatter" ||
    block.type === "html" ||
    span?.code;

  let size = theme.bodySize;
  if (heading) {
    const scale = [1.9, 1.55, 1.3, 1.15, 1.05, 1.0][Math.min(block.level, 6) - 1] ?? 1;
    size = Math.round(theme.bodySize * scale);
  } else if (code) {
    size = Math.round(theme.bodySize * 0.88);
  } else if (block.type === "footnote") {
    // A note is an aside. Sizing it here rather than shrinking the finished
    // runs means a formula inside one is measured at the size it is drawn.
    size = Math.round(theme.bodySize * 0.86);
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
    // Front matter is the document's metadata rather than its prose, so it is
    // set back like a quotation instead of competing with the opening line.
    : block.type === "quote" || block.type === "frontmatter" || block.type === "footnote"
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
  if (span?.highlight) style.background = theme.highlightColor;
  if (span?.underline) style.underline = true;
  // A superscript is set smaller and lifted, a subscript smaller and dropped.
  // The size is taken from the surrounding text rather than from the theme so
  // that one inside a heading stays in proportion to the heading.
  if (span?.sup || span?.sub) {
    style.size = Math.max(8, Math.round(size * 0.68));
    style.raise = span.sup ? size * 0.34 : -size * 0.1;
  }
  // The key is what the measurement caches and run coalescing key on, so
  // anything that changes how a run is *painted* has to be in it, even when
  // it leaves the metrics alone.
  return {
    style,
    key: cssFont(style) + (style.background ?? "") + (style.raise ? `^${style.raise}` : "") +
      (style.underline ? "_" : ""),
  };
}

/** How far into its column a line sits, given the column's alignment. */
function alignmentOffset(align: ColumnAlign, lineWidth: number, columnWidth: number): number {
  const slack = Math.max(0, columnWidth - lineWidth);
  if (align === "right") return slack;
  if (align === "center") return slack / 2;
  return 0;
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

/** Build cached geometry in source coordinates local to its own block. */
function localBlock(block: Block): Block {
  return {
    ...block,
    start: 0,
    end: block.end - block.start,
    rows: block.rows.map((row) => row.map((cell) => ({
      ...cell, start: cell.start - block.start, end: cell.end - block.start,
    }))),
  };
}

/** Every occurrence owns its placement and source maps, even for equal text. */
function placeCachedBlock(cached: LaidBlock, block: Block): LaidBlock {
  const offset = block.start;
  return {
    ...cached,
    block,
    y: 0,
    rendered: {
      ...cached.rendered,
      spans: cached.rendered.spans.map((span) => ({ ...span })),
      map: cached.rendered.map.map((position) => position + offset),
    },
    lines: cached.lines.map((line) => ({
      ...line,
      docStart: line.docStart + offset,
      docEnd: line.docEnd + offset,
      runs: line.runs.map((run) => ({
        ...run, docStart: run.docStart + offset, docEnd: run.docEnd + offset,
      })),
    })),
    table: cached.table && {
      ...cached.table,
      x: [...cached.table.x], widths: [...cached.table.widths], rowStarts: [...cached.table.rowStarts],
    },
  };
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
    /** Show every block as its source, not only the one holding the caret. */
    sourceMode = false,
  ): { blocks: LaidBlock[]; height: number } {
    const parsed = parseBlocks(doc, this.options.inline);
    // Most blocks exclude the trailing LF, but an unterminated code/math
    // block owns it and already lays out its final source line when focused.
    // Only synthesize a line when no parsed block owns that insertion point.
    if (doc.endsWith("\n") && parsed.at(-1)?.end !== doc.length) {
      parsed.push({
        type: "blank", start: doc.length, end: doc.length, source: "",
        level: 0, ordered: false, marker: "", lang: "", math: "", task: "none",
        rows: [], align: [], label: "",
      });
    }
    const focusedBlock = blockIndexAtPosition(parsed, focusedPosition);
    const numbering = numberEquations(parsed, this.options.numbering);
    const out: LaidBlock[] = [];
    const usedKeys = new Set<string>();
    let y = 0;
    for (let i = 0; i < parsed.length; i++) {
      const b = parsed[i];
      const laid = this.layoutBlock(
        b,
        width,
        sourceMode || i === focusedBlock,
        out.at(-1)?.block ?? null,
        numbering.tags.get(i) ?? null,
        numbering,
        usedKeys,
      );
      laid.y = y + laid.spaceBefore;
      y = laid.y + laid.height - laid.spaceBefore;
      out.push(laid);
    }
    // Keep the current document's working set even when it exceeds the
    // history budget. Clearing mid-layout would evict its beginning and
    // cause the entire next layout of a long document to miss again.
    for (const key of this.cache.keys()) {
      if (this.cache.size <= 4000) break;
      if (!usedKeys.has(key)) this.cache.delete(key);
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
    usedKeys: Set<string>,
  ): LaidBlock {
    // Absolute offsets and document y never change a block's typography.
    // Derived list markers and resolved references do, even when the source
    // is identical. JSON framing prevents separators in source/labels from
    // colliding, and preserves the exact available width.
    const key = JSON.stringify([
      this.version, width, raw, previous?.type ?? null,
      block.type, block.level, block.ordered, block.marker, block.task,
      block.lang, block.math, block.align, block.label, block.source,
      raw ? null : tag, !raw && usesNumbering(block) ? numbering.version : null,
    ]);
    usedKeys.add(key);
    let laid = this.cache.get(key);
    if (!laid) {
      laid = this.buildBlock(localBlock(block), width, raw, previous, tag, numbering);
      this.cache.set(key, laid);
    }
    return placeCachedBlock(laid, block);
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

    if (block.type === "footnote") {
      const laid = this.buildFootnote(block, rendered, spaceBefore, measure, indent, numbering);
      if (laid) return laid;
    }

    if (block.type === "table") {
      return this.buildTable(block, rendered, spaceBefore, measure, indent, raw, numbering);
    }

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
    // Both keep their own line structure: breaking either optimally would be
    // actively wrong.
    if (block.type === "code" || block.type === "frontmatter" || block.type === "html") {
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
    const widthEx = measure / this.measurer.exHeight(style);
    const math = this.mathRun(renderDisplayMath(latex, tag, widthEx), latex, true, style);
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

  /**
   * Lay out a table.
   *
   * Each cell is broken as a paragraph of its own at its column's width, so
   * everything the engine already does inside a paragraph — optimal breaking,
   * mixed-script spacing, formulas — works inside a cell without a second
   * implementation. A row is then as tall as its deepest cell, and the row's
   * lines are ordinary lines whose runs happen to sit at column offsets. Hit
   * testing, selection and the caret need no special case.
   */
  private buildTable(
    block: Block,
    rendered: RenderedBlock,
    spaceBefore: number,
    measure: number,
    indent: number,
    raw: boolean,
    numbering: Numbering,
  ): LaidBlock {
    const theme = this.theme;
    const columns = block.align.length;
    if (!columns || !block.rows.length) {
      return this.buildPreformatted(block, rendered, spaceBefore, indent, raw);
    }

    const base = styleForSpan(theme, block, null);
    const padding = theme.bodySize * 0.7;
    const cells = block.rows.map((row, r) =>
      Array.from({ length: columns }, (_, c) => {
        const cell = row[c];
        if (!cell) return null;
        const inline = parseInline(cell.text, cell.start, undefined, this.options.inline);
        // The header is set bold. Marking the spans rather than the block
        // keeps one style resolver for every kind of run.
        return r === 0
          ? { ...inline, spans: inline.spans.map((span) => ({ ...span, strong: true })) }
          : inline;
      }),
    );

    // A column is as wide as its widest cell wants to be, then every column
    // is scaled back together if the table overflows. Scaling proportionally
    // rather than clipping keeps a wide column wide.
    // The header is set bold, so it has to be measured bold: sizing a column
    // from the lighter face makes the heading it was sized for wrap.
    const header = styleForSpan(theme, block, {
      kind: "text", start: 0, end: 0,
      strong: true, em: false, code: false, strike: false, highlight: false,
      sub: false, sup: false, underline: false, href: "",
    });
    const natural = Array.from({ length: columns }, (_, c) =>
      Math.max(
        ...cells.map((row, r) => {
          const cell = row[c];
          if (!cell) return 0;
          const style = r === 0 ? header : base;
          return this.measurer.width(cell.text, style.style, style.key);
        }),
        theme.bodySize,
      ),
    );
    const available = Math.max(measure - padding * (columns - 1), theme.bodySize * columns);
    const total = natural.reduce((a, b) => a + b, 0);
    const widths = total <= available
      ? natural
      : natural.map((w) => (w / total) * available);

    const x: number[] = [];
    for (let c = 0, at = 0; c < columns; c++) {
      x.push(at);
      at += widths[c] + padding;
    }

    const lines: LaidLine[] = [];
    const rowStarts: number[] = [];
    let y = 0;
    for (let r = 0; r < cells.length; r++) {
      rowStarts.push(lines.length);
      const broken = cells[r].map((cell, c) =>
        cell && cell.text
          ? this.breakParagraph(block, cell, widths[c], 0, numbering)
          : [],
      );
      const depth = Math.max(1, ...broken.map((l) => l.length));
      for (let k = 0; k < depth; k++) {
        const runs: LaidRun[] = [];
        let height = base.style.size * 0.8;
        let lineDepth = base.style.size * 0.2;
        for (let c = 0; c < columns; c++) {
          const line = broken[c][k];
          if (!line) continue;
          height = Math.max(height, line.height);
          lineDepth = Math.max(lineDepth, line.depth);
          const shift = x[c] + alignmentOffset(block.align[c], line.width, widths[c]);
          for (const run of line.runs) runs.push({ ...run, x: run.x + shift });
        }
        // Rows stack on their own rhythm rather than the paragraph breaker's,
        // since each cell was broken in isolation and knows nothing of its
        // neighbours' depth.
        y += k === 0 ? height : height + theme.bodySize * 0.25;
        lines.push({
          docStart: lines.length ? lines[lines.length - 1].docEnd : block.start,
          docEnd: block.end,
          baseline: y,
          height,
          depth: lineDepth,
          runs,
          ratio: 0,
          width: measure,
          indent,
        });
        y += lineDepth;
      }
      y += theme.bodySize * 0.55;
    }

    return {
      block,
      lines,
      height: spaceBefore + y,
      spaceBefore,
      y: 0,
      rendered,
      indent,
      marker: "",
      raw,
      table: { columns, x, widths, rowStarts, padding },
    };
  }

  /**
   * A footnote definition: its text, indented, with its number in the margin.
   *
   * The definition stays where the author wrote it rather than being gathered
   * at the foot of the document. Moving blocks would break the one invariant
   * the editor rests on — that a block's source range is contiguous and covers
   * the caret — and in a live editor a note that leaps away as you type it is
   * worse than one that sits in place.
   */
  private buildFootnote(
    block: Block,
    rendered: RenderedBlock,
    spaceBefore: number,
    measure: number,
    indent: number,
    numbering: Numbering,
  ): LaidBlock | null {
    const theme = this.theme;
    const base = styleForSpan(theme, block, null);
    const marker = this.buildNotePiece(numbering.notes.get(block.label) ?? "?", base.style);
    const gutter = theme.bodySize * 1.4;
    const lines = this.breakParagraph(
      block,
      rendered,
      Math.max(measure - gutter, theme.bodySize * 4),
      indent,
      numbering,
    );
    if (!lines.length) return null;

    // Only the horizontal shift is applied here; the size and colour came
    // from the style resolver, so every run already agrees with its box.
    const shifted = lines.map((line) => ({
      ...line,
      runs: line.runs.map((run) => ({ ...run, x: run.x + gutter })),
    }));
    const last = shifted[shifted.length - 1];
    return {
      block,
      lines: shifted,
      height: spaceBefore + last.baseline + last.depth,
      spaceBefore,
      y: 0,
      rendered,
      indent,
      marker: "",
      raw: false,
      note: marker.note,
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
   * flush against one another — word pieces split for hyphenation or Western
   * punctuation measured separately for optical margins.
   *
   * Drawing them as one `fillText` restores the kerning across the join.
   *
   * Restricted to Western shaping runs. A CJK glyph is positioned
   * individually — squeezed punctuation is shifted inside its own em box —
   * and merging those into one draw call
   * would hand their positions back to the platform and undo the adjustment.
   * The flush-position check below would catch most such cases, but "most" is
   * not worth relying on when the shaping boundary is known.
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
  private expandObjects(
    rendered: RenderedBlock,
    style: TextStyle,
    key: string,
    numbering: Numbering,
    measure: number,
  ): { rendered: RenderedBlock; pieces: Map<number, ObjectPiece> } {
    if (!rendered.text.includes(OBJECT_REPLACEMENT)) {
      return { rendered, pieces: new Map() };
    }

    const pieces = new Map<number, ObjectPiece>();
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
      const span = rendered.spans[spanIndexAt(rendered.spans, i)];
      const built: ObjectPiece[] = span?.kind === "image"
        ? [this.buildImagePiece(span, style, measure)]
        : span?.kind === "note"
          ? [this.buildNotePiece(numbering.notes.get(span.label ?? "") ?? "?", style)]
          : this.buildMathPieces(rendered, i, style, key, numbering);
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
    const found = rendered.spans[spanIndexAt(rendered.spans, charIndex)];
    const span = found?.kind === "math" ? found : undefined;
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
      built = [{ ...common, kind: "math", penaltyAfter: NaN }];
    } else {
      // Every piece is given the whole formula's height and depth. That is
      // conservative — a piece with no tall part gets more leading than it
      // strictly needs — but it can never let two lines collide, and formulas
      // that break at an outer-level operator are usually of even height
      // anyway.
      built = segments.map((segment) => ({
        ...common,
        kind: "math" as const,
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

  /**
   * A footnote's raised number.
   *
   * Set smaller and lifted rather than drawn at full size on the baseline: a
   * mark that reads as part of the sentence would be mistaken for content.
   * The box reserves the lifted height, so the line above stays clear.
   */
  private buildNotePiece(text: string, style: TextStyle): NotePiece {
    const raised: TextStyle = { ...style, size: Math.max(8, style.size * 0.68) };
    const key = cssFont(raised);
    const raise = style.size * 0.36;
    const v = this.vmetrics(raised, key);
    return {
      kind: "note",
      width: this.measurer.width(text, raised, key),
      height: v.ascent + raise,
      depth: Math.max(0, v.descent - raise),
      penaltyAfter: NaN,
      note: { text, style: raised, raise },
    };
  }

  /**
   * Lay out a picture.
   *
   * The intrinsic size arrives asynchronously, so the box is whatever is known
   * now: the alt text while the file decodes or after it fails, the fitted
   * picture once it is there. `onImageSettled` re-typesets when that changes,
   * which is the same handshake the math bridge uses while MathJax loads.
   *
   * An image sits on the baseline rather than straddling it, as a browser
   * places one, so the line above is never encroached upon.
   */
  private buildImagePiece(span: Span, style: TextStyle, measure: number): ImagePiece {
    const src = span.href ?? "";
    const alt = span.alt ?? "";
    const loaded = requestImage(src);
    const key = cssFont(style);

    if (loaded.status !== "ready" || loaded.width <= 0) {
      const text = alt || (loaded.status === "error" ? "\u26a0 " + src : src);
      const v = this.vmetrics(style, key);
      return {
        kind: "image",
        width: this.measurer.width(text, style, key),
        height: v.ascent,
        depth: v.descent,
        penaltyAfter: NaN,
        image: {
          source: null,
          width: 0,
          height: 0,
          status: loaded.status,
          src,
          alt,
          fallback: { text, style },
        },
      };
    }

    const fitted = fitImage(loaded.width, loaded.height, measure);
    return {
      kind: "image",
      width: fitted.width,
      height: fitted.height,
      depth: 0,
      penaltyAfter: NaN,
      image: { source: loaded.source, ...fitted, status: "ready", src, alt },
    };
  }

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
    const expanded = this.expandObjects(rendered, base.style, base.key, numbering, measure);
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
    // Contextual advance, height, depth, break penalty, measured hyphen width,
    // and standalone glyph advance (optical margins must not use word width).
    const metrics = new Float32Array(count * METRIC_STRIDE);

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
      // Spans are disjoint and ordered. A full scan per token would make a
      // paragraph with many Markdown styles quadratic again after parsing.
      const found = spanStyles[spanIndexAt(rendered.spans, ch)];
      if (found && ch >= found.span.start && ch < found.span.end) return found;
      return spanStyles[0] ?? fallbackStyle;
    };

    // Measure word pieces and adjacent Western punctuation as differences
    // between prefixes of one shaping run. Their advances sum to the drawn
    // text, preserving kerning even though punctuation has its own token.
    for (let i = 0, t = 0; i < count; ) {
      let n = 1;
      const st = styleAt(tokens[t]);
      if (isShapedText(tokens[t + 2])) {
        while (
          i + n < count &&
          isShapedText(tokens[t + n * 3 + 2]) &&
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
        metrics[i * METRIC_STRIDE] = piece?.width ?? 0;
        metrics[i * METRIC_STRIDE + 1] = Math.max(piece?.height ?? 0, v.ascent * 0.2);
        metrics[i * METRIC_STRIDE + 2] = piece?.depth ?? 0;
        metrics[i * METRIC_STRIDE + 3] = piece?.penaltyAfter ?? NaN;
        i += 1;
        t += 3;
        continue;
      }

      if (n === 1) {
        const slice = text.slice(toChar(tokens[t]), toChar(tokens[t + 1]));
        metrics[i * METRIC_STRIDE] = this.measurer.width(slice, st.style, st.key);
      } else {
        const from = toChar(tokens[t]);
        let previous = 0;
        for (let k = 0; k < n; k++) {
          const upto = toChar(tokens[t + k * 3 + 1]);
          const cumulative = this.measurer.width(text.slice(from, upto), st.style, st.key);
          metrics[(i + k) * METRIC_STRIDE] = cumulative - previous;
          previous = cumulative;
        }
      }
      // A raised or lowered run keeps its own ink inside the line: the box
      // has to grow by however far the glyphs moved, or a superscript would
      // collide with the line above.
      const shift = st.style.raise ?? 0;
      for (let k = 0; k < n; k++) {
        metrics[(i + k) * METRIC_STRIDE + 1] = v.ascent + Math.max(0, shift);
        metrics[(i + k) * METRIC_STRIDE + 2] = v.descent + Math.max(0, -shift);
        metrics[(i + k) * METRIC_STRIDE + 3] = NaN;
        metrics[(i + k) * METRIC_STRIDE + 4] = this.measurer.width("-", st.style, st.key);
        metrics[(i + k) * METRIC_STRIDE + 5] = tokens[t + k * 3 + 2] === CLASS_WESTERN_PUNCT
          ? this.measurer.width(text.slice(toChar(tokens[t + k * 3]), toChar(tokens[t + k * 3 + 1])), st.style, st.key)
          : metrics[(i + k) * METRIC_STRIDE];
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
        const object = slice === OBJECT_REPLACEMENT ? pieces.get(cs) : undefined;
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
          math: object?.kind === "math" ? object : undefined,
          image: object?.kind === "image" ? object.image : undefined,
          note: object?.kind === "note" ? object.note : undefined,
          // Carried on the run so that following a link is a hit test like
          // any other, with no second pass over the markdown.
          href: st.span?.kind === "link" ? st.span.href : undefined,
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
