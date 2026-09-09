/**
 * Text measurement.
 *
 * The engine needs an advance width for every token before it can break a
 * line, and it needs them again every time the measure changes. Measuring
 * through the DOM costs about 16 microseconds per character; `measureText`
 * on a canvas costs well under one, and a token cache brings a whole
 * paragraph down to roughly two microseconds. That gap is the reason the
 * document surface is a canvas rather than a tree of styled spans.
 *
 * Measuring with the same API the platform will draw with also keeps the two
 * honest: whatever `fillText` does to a word, `measureText` reported.
 */

export interface TextStyle {
  /** Font stack. Latin face first, CJK face second, so canvas falls back the
   *  same way it will when drawing and measurement matches rendering. */
  family: string;
  size: number;
  weight: number;
  italic: boolean;
  color: string;
  /** Line box height as a multiple of the font size. */
  lineHeight: number;
  /** Painted behind the text, for highlighted spans. */
  background?: string;
  /** Baseline shift, positive upwards — superscripts and subscripts. */
  raise?: number;
  /** Ruled under, for <u> and for links. */
  underline?: boolean;
}

// Latin first, CJK second. Canvas resolves each character from the first
// family that has it, and a CJK serif carries a full Latin repertoire — so a
// Latin face behind one is never reached, and the Latin in a mixed document
// gets drawn, unkerned, by the Song face.
export const FALLBACK_SERIF =
  '"Iowan Old Style", Charter, Palatino, Cambria, Constantia, Georgia, ' +
  '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", SimSun, serif';
export const FALLBACK_SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, ' +
  '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif';
export const FALLBACK_MONO =
  '"SF Mono", "Cascadia Code", Menlo, Consolas, monospace';

export function cssFont(s: TextStyle): string {
  return `${s.italic ? "italic " : ""}${s.weight} ${s.size}px ${s.family}`;
}

/**
 * A measurement cache keyed by (style, token).
 *
 * Hit rates in real prose are very high: a document reuses the same few
 * thousand words and the same few thousand ideographs, so after the first
 * screenful almost every lookup is a map hit.
 */
export class Measurer {
  private ctx: CanvasRenderingContext2D;
  private cache = new Map<string, number>();
  private currentFont = "";
  /** Resolves once web fonts have settled, at which point the cache is
   *  cleared so no fallback widths survive. */
  readonly ready: Promise<void>;

  constructor() {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas is unavailable");
    this.ctx = ctx;
    this.ready = document.fonts
      ? document.fonts.ready.then(() => {
          this.cache.clear();
        })
      : Promise.resolve();
  }

  /** Drop everything. Called when a font or size changes. */
  invalidate(): void {
    this.cache.clear();
    this.currentFont = "";
  }

  private use(style: TextStyle): void {
    const font = cssFont(style);
    if (font !== this.currentFont) {
      this.ctx.font = font;
      this.currentFont = font;
    }
  }

  /** Advance width of one token, in CSS pixels. */
  width(token: string, style: TextStyle, styleKey: string): number {
    const key = styleKey + " " + token;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    this.use(style);
    const w = this.ctx.measureText(token).width;
    this.cache.set(key, w);
    return w;
  }

  /** Width of a single space in this style: the basis of interword glue. */
  spaceWidth(style: TextStyle, styleKey: string): number {
    return this.width(" ", style, styleKey);
  }

  /**
   * Width of a prefix of a token. Used only for caret placement inside a
   * word, which happens once per click rather than once per frame, so it is
   * deliberately not cached.
   */
  prefixWidth(token: string, chars: number, style: TextStyle): number {
    this.use(style);
    return this.ctx.measureText(token.slice(0, chars)).width;
  }

  /**
   * The x-height of a style, in pixels.
   *
   * Math is sized in `ex` because that is what makes a formula look like it
   * belongs in the sentence: matching x-heights, not em sizes, is what keeps
   * the symbols optically the same weight as the words around them.
   */
  exHeight(style: TextStyle): number {
    this.use(style);
    const m = this.ctx.measureText("x");
    const ascent = m.actualBoundingBoxAscent;
    return ascent && ascent > 0 ? ascent : style.size * 0.45;
  }

  /** Ascent and descent for a style, for baseline placement. */
  vmetrics(style: TextStyle): { ascent: number; descent: number } {
    this.use(style);
    const m = this.ctx.measureText("Hxg中");
    return {
      ascent: m.fontBoundingBoxAscent ?? style.size * 0.88,
      descent: m.fontBoundingBoxDescent ?? style.size * 0.22,
    };
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * The core speaks UTF-8 byte offsets; JavaScript strings are UTF-16. Build
 * the mapping once per paragraph rather than re-encoding on every slice.
 */
export function byteToCharIndex(text: string): (byte: number) => number {
  if (isAscii(text)) return (b) => b;

  const total = utf8Length(text);
  const map = new Int32Array(total + 1);
  let byte = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const chars = cp > 0xffff ? 2 : 1;
    const bytes = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    for (let b = 0; b < bytes; b++) map[byte + b] = i;
    byte += bytes;
    i += chars;
  }
  map[total] = text.length;
  return (b) => map[b < 0 ? 0 : b > total ? total : b];
}

/** Char index to UTF-8 byte offset: the inverse of `byteToCharIndex`. */
export function charToByteIndex(text: string): (char: number) => number {
  if (isAscii(text)) return (c) => c;

  const map = new Int32Array(text.length + 1);
  let byte = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const chars = cp > 0xffff ? 2 : 1;
    map[i] = byte;
    if (chars === 2) map[i + 1] = byte;
    byte += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += chars;
  }
  map[text.length] = byte;
  return (c) => map[c < 0 ? 0 : c > text.length ? text.length : c];
}

export function utf8Length(text: string): number {
  if (isAscii(text)) return text.length;
  let n = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp > 0xffff ? 2 : 1;
  }
  return n;
}

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) return false;
  }
  return true;
}
