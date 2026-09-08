/**
 * Markdown parsing.
 *
 * Blocks map onto TeX's vertical list and inline spans onto its horizontal
 * list, so the parser's job is to produce, for each block, the text that will
 * actually be set plus the style runs over it.
 *
 * Every block also carries a map from displayed character back to source
 * character. Stripping `**` from a heading changes the offsets, and without
 * that map the caret could not survive the round trip. It is the single piece
 * of bookkeeping that separates an editor from a viewer.
 */

export type BlockType =
  | "paragraph"
  | "heading"
  | "code"
  | "quote"
  | "list"
  | "rule"
  | "math"
  | "blank";

export interface Block {
  type: BlockType;
  /** Heading level 1-6, or list nesting depth. */
  level: number;
  ordered: boolean;
  /** Rendered list marker, e.g. "1." or a bullet. */
  marker: string;
  /** Character range in the whole document. */
  start: number;
  end: number;
  /** The block's raw markdown, exactly as it appears in the source. */
  source: string;
  /** Language tag on a fenced code block. */
  lang: string;
  /** LaTeX source of a block of kind "math", delimiters already removed. */
  math: string;
}

export type SpanKind = "text" | "strong" | "em" | "code" | "link" | "strike" | "math";

/**
 * The character standing in for an inline formula in a block's rendered text.
 *
 * Unicode defines U+FFFC for exactly this: a placeholder occupying the place
 * of content the text stream cannot represent. Using it means the formula
 * needs no special case in the tokenizer — it is one more atom in the
 * horizontal list, with a width, a height and a depth like any other.
 */
export const OBJECT_REPLACEMENT = "\uFFFC";

export interface Span {
  kind: SpanKind;
  /** LaTeX source, on spans of kind "math". */
  math?: string;
  /** Whether a math span is set in display style. */
  display?: boolean;
  /** Range within the block's *rendered* text. */
  start: number;
  end: number;
  strong: boolean;
  em: boolean;
  code: boolean;
  strike: boolean;
  href: string;
}

export interface RenderedBlock {
  /** The text to typeset. */
  text: string;
  spans: Span[];
  /** `map[i]` is the document character index that rendered character `i`
   *  came from. Length is `text.length + 1` so the end position maps too. */
  map: Int32Array;
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*(\S*)/;
/** A display formula opened by $$ or by \[ on its own line. */
const MATH_OPEN = /^\s*(\$\$|\\\[)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const UL = /^(\s*)([-*+])\s+(.*)$/;
const OL = /^(\s*)(\d+)([.)])\s+(.*)$/;

/**
 * Split a document into blocks.
 *
 * Deliberately line-oriented and allocation-light: re-parsing the whole
 * document on every keystroke is affordable at this granularity, and it
 * sidesteps a class of incremental-parser bugs that a v1 does not need.
 */
export function parseBlocks(doc: string): Block[] {
  const blocks: Block[] = [];
  const lines = doc.split("\n");
  const offsets = new Int32Array(lines.length + 1);
  for (let i = 0, at = 0; i < lines.length; i++) {
    offsets[i] = at;
    at += lines[i].length + 1;
  }
  offsets[lines.length] = doc.length;

  // A document ending in a newline yields a final empty element that is an
  // artefact of splitting, not a blank line the author wrote.
  const count = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;

  let i = 0;
  while (i < count) {
    const line = lines[i];
    const start = offsets[i];

    // Display math, opened by $$ or \[. Both may close on the same line.
    const mathOpen = MATH_OPEN.exec(line);
    if (mathOpen) {
      const opener = mathOpen[1];
      const closer = opener === "$$" ? "$$" : "\\]";
      const afterOpen = start + line.indexOf(opener) + opener.length;
      const sameLine = line.indexOf(closer, line.indexOf(opener) + opener.length);
      let end: number;
      let bodyEnd: number;
      if (sameLine >= 0) {
        bodyEnd = start + sameLine;
        end = bodyEnd + closer.length;
        i++;
      } else {
        let j = i + 1;
        while (j < count && !lines[j].includes(closer)) j++;
        if (j < count) {
          bodyEnd = offsets[j] + lines[j].indexOf(closer);
          end = bodyEnd + closer.length;
          i = j + 1;
        } else {
          // Unterminated: treat the rest of the document as the formula so the
          // reader can see what they are typing rather than losing it.
          bodyEnd = doc.length;
          end = doc.length;
          i = count;
        }
      }
      blocks.push(
        block("math", doc.slice(start, end), start, end, {
          math: doc.slice(afterOpen, bodyEnd),
        }),
      );
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const closer = fence[2][0];
      let j = i + 1;
      while (j < count && !new RegExp(`^\\s*${closer}{3,}\\s*$`).test(lines[j])) j++;
      const end = j < count ? offsets[j] + lines[j].length : doc.length;
      const info = fence[3].toLowerCase();
      if (info === "math" || info === "latex" || info === "katex") {
        const bodyStart = offsets[i] + line.length + 1;
        const bodyEnd = j < count ? Math.max(bodyStart, offsets[j] - 1) : doc.length;
        blocks.push(
          block("math", doc.slice(start, end), start, end, {
            math: doc.slice(bodyStart, bodyEnd),
          }),
        );
      } else {
        blocks.push(block("code", doc.slice(start, end), start, end, { lang: fence[3] }));
      }
      i = j + 1;
      continue;
    }

    if (line.trim() === "") {
      blocks.push(block("blank", line, start, start + line.length, {}));
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push(block("rule", line, start, start + line.length, {}));
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push(
        block("heading", line, start, start + line.length, { level: heading[1].length }),
      );
      i++;
      continue;
    }

    const ul = UL.exec(line);
    const ol = OL.exec(line);
    if (ul || ol) {
      // A list item continues over lazy continuation lines.
      let j = i + 1;
      while (
        j < count &&
        lines[j].trim() !== "" &&
        !UL.test(lines[j]) &&
        !OL.test(lines[j]) &&
        !HEADING.test(lines[j]) &&
        !FENCE.test(lines[j])
      ) {
        j++;
      }
      const end = blockEnd(doc, offsets, lines.length, j, start, line);
      const indent = (ul ? ul[1] : ol![1]).length;
      blocks.push(
        block("list", doc.slice(start, end), start, end, {
          level: Math.floor(indent / 2) + 1,
          ordered: !!ol,
          marker: ol ? `${ol[2]}${ol[3]}` : "•",
        }),
      );
      i = j;
      continue;
    }

    if (QUOTE.test(line)) {
      let j = i;
      while (j < count && QUOTE.test(lines[j])) j++;
      const end = blockEnd(doc, offsets, lines.length, j, start, line);
      blocks.push(block("quote", doc.slice(start, end), start, end));
      i = j;
      continue;
    }

    // Paragraph: run on until a blank line or a block that interrupts.
    let j = i + 1;
    while (
      j < count &&
      lines[j].trim() !== "" &&
      !HEADING.test(lines[j]) &&
      !FENCE.test(lines[j]) &&
      !MATH_OPEN.test(lines[j]) &&
      !RULE.test(lines[j]) &&
      !QUOTE.test(lines[j]) &&
      !UL.test(lines[j]) &&
      !OL.test(lines[j])
    ) {
      j++;
    }
    const end = blockEnd(doc, offsets, lines.length, j, start, line);
    blocks.push(block("paragraph", doc.slice(start, end), start, end));
    i = j;
  }

  if (blocks.length === 0) {
    blocks.push(block("paragraph", "", 0, 0));
  }
  return blocks;
}

/**
 * Where a multi-line block ends.
 *
 * Blocks are separated by the newline that follows them, so the separator is
 * excluded — unless the block runs to the end of a document that has no
 * trailing newline, in which case there is nothing to exclude.
 */
function blockEnd(
  doc: string,
  offsets: Int32Array,
  lineCount: number,
  j: number,
  start: number,
  line: string,
): number {
  if (j >= lineCount) return doc.length;
  return offsets[j] > start ? offsets[j] - 1 : start + line.length;
}

function block(
  type: BlockType,
  source: string,
  start: number,
  end: number,
  extra: Partial<Block> = {},
): Block {
  return {
    type,
    level: extra.level ?? 0,
    ordered: extra.ordered ?? false,
    marker: extra.marker ?? "",
    start,
    end,
    source,
    lang: extra.lang ?? "",
    math: extra.math ?? "",
  };
}

/**
 * Produce the text to typeset for a block, along with its style runs and the
 * map back to source positions.
 *
 * When `raw` is set the block's markdown is shown verbatim, which is what
 * happens to the block holding the caret: it sidesteps the unanswerable
 * question of where the caret goes "inside" a pair of asterisks, and keeps
 * the mapping an identity.
 */
export function renderBlock(
  b: Block,
  raw: boolean,
  options: InlineOptions = DEFAULT_INLINE_OPTIONS,
): RenderedBlock {
  if (raw || b.type === "code") {
    const map = identityMap(b.source.length, b.start);
    return { text: b.source, spans: [plainSpan(0, b.source.length)], map };
  }

  // Strip the block's own syntax first, tracking where each surviving
  // character came from.
  let body = b.source;
  let base = b.start;
  if (b.type === "heading") {
    const m = HEADING.exec(b.source);
    if (m) {
      base += m[1].length + b.source.slice(m[1].length).indexOf(m[2]);
      body = m[2];
    }
  } else if (b.type === "quote") {
    return stripPerLine(b, /^\s*>\s?/, options);
  } else if (b.type === "list") {
    const m = UL.exec(b.source) ?? OL.exec(b.source);
    if (m) {
      const consumed = m[0].length - m[m.length - 1].length;
      base += consumed;
      body = b.source.slice(consumed);
    }
  }

  return parseInline(body, base, undefined, options);
}

/** Remove a leading marker from every line, e.g. the `>` of a blockquote. */
function stripPerLine(b: Block, marker: RegExp, options: InlineOptions): RenderedBlock {
  let text = "";
  const map: number[] = [];
  let at = b.start;
  const lines = b.source.split("\n");
  lines.forEach((line, n) => {
    const m = marker.exec(line);
    const skip = m ? m[0].length : 0;
    for (let i = skip; i < line.length; i++) {
      text += line[i];
      map.push(at + i);
    }
    at += line.length + 1;
    if (n + 1 < lines.length) {
      // The same rule the running text follows: a break between wide
      // characters is how the author wrapped the file, not a space.
      const next = lines[n + 1].replace(marker, "");
      const before = text.length ? text[text.length - 1] : "";
      const wide = isWide(before) || isWide(next.charAt(0));
      if (!options.cjkSoftBreaks || !wide) {
        text += " ";
        map.push(at - 1);
      }
    }
  });
  map.push(b.end);
  // Hand the stripped text on for inline parsing, carrying the map with it —
  // and keep the map that comes back, since emphasis removal shortens it
  // further.
  return parseInline(text, -1, map, options);
}

function identityMap(length: number, base: number): Int32Array {
  const map = new Int32Array(length + 1);
  for (let i = 0; i <= length; i++) map[i] = base + i;
  return map;
}

function plainSpan(start: number, end: number): Span {
  return {
    kind: "text",
    start,
    end,
    strong: false,
    em: false,
    code: false,
    strike: false,
    href: "",
  };
}

/** How the inline scanner should treat math delimiters. */
export interface InlineOptions {
  /** Recognise dollar-delimited formulas at all. */
  inlineMath: boolean;
  /** Recognise TeX's own \( \) and \[ \] delimiters. */
  texDelimiters: boolean;
  /**
   * Strict dollar parsing, following Pandoc's rule: the opening delimiter may
   * not be followed by whitespace, the closing one may not be preceded by it,
   * and the closing one may not be followed by a digit.
   *
   * That last clause is what keeps "it costs $5 and $10" out of math mode,
   * and it is the reason a strict and a lenient mode both need to exist: a
   * document written under lenient rules can contain formulas that strict
   * parsing would no longer see.
   */
  strictDollar: boolean;
  /**
   * Drop a source line break that touches a CJK character, instead of turning
   * it into a space.
   *
   * CommonMark says a newline inside a paragraph is a space, which is right
   * for scripts that separate words with one and wrong for Chinese and
   * Japanese, where a line break in the source is only how the author chose
   * to wrap the file. Leave it on and a paragraph reads the same however it
   * is wrapped; turn it off for CommonMark's literal behaviour.
   *
   * Pandoc's `east_asian_line_breaks` drops the newline only when the
   * characters on *both* sides are wide. We drop it when *either* side is,
   * because we also insert the quarter em between Han and Latin ourselves: on
   * a boundary like "意思；\n`\eqref`" Pandoc's rule leaves a space that the
   * mixed-script spacing then widens further, and the gap reads as a mistake.
   */
  cjkSoftBreaks: boolean;
}

export const DEFAULT_INLINE_OPTIONS: InlineOptions = {
  inlineMath: true,
  texDelimiters: true,
  strictDollar: true,
  cjkSoftBreaks: true,
};

/** A stretch of source that carries formatting. */
interface Format {
  kind: Exclude<SpanKind, "text">;
  /** Range of the *content*, in source coordinates. */
  from: number;
  to: number;
  href: string;
  /** LaTeX source, on math formats. */
  latex?: string;
  display?: boolean;
}

const PUNCT = /[!-/:-@[-`{-~ -⁯　-〿＀-￯]/;

/**
 * East Asian wide characters: Han, kana, Hangul, CJK punctuation and the
 * fullwidth forms. These are the ones whose neighbours never need a space.
 */
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︐-﹯＀-｠￠-￦]/;

function isWide(c: string): boolean {
  return c.length > 0 && WIDE.test(c);
}

function isSpace(c: string | undefined): boolean {
  return c === undefined || /\s/.test(c);
}

/**
 * Inline markdown, in two passes.
 *
 * The first pass decides which delimiters are real — a `*` only opens a span
 * if something follows it and only closes one if something precedes it, which
 * is what keeps `2 * 3 * 4` from turning into emphasis. The second pass emits
 * the text without those delimiters, recording where every surviving
 * character came from.
 *
 * `base` is the document offset of `body`; pass -1 with `outerMap` when the
 * caller has its own mapping, as a blockquote does since its lines are not
 * contiguous in the source.
 */
export function parseInline(
  body: string,
  base: number,
  outerMap?: number[],
  options: InlineOptions = DEFAULT_INLINE_OPTIONS,
): RenderedBlock {
  const src = (i: number): number =>
    outerMap ? (outerMap[i] ?? outerMap[outerMap.length - 1]) : base + i;

  const formats: Format[] = [];
  /** Source ranges to omit from the output: delimiters and link targets. */
  const drops: Array<[number, number]> = [];
  /** Source ranges replaced wholesale by a single placeholder character —
   *  the formulas, which have no textual form. */
  const swaps: Array<{ from: number; to: number }> = [];
  /** Source positions that are literal because a backslash escaped them. */
  const escaped = new Set<number>();

  // ---- pass one: find the real delimiters ------------------------------
  const open: Array<{ marker: string; at: number; contentAt: number }> = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];

    if (options.texDelimiters && c === "\\" && (body[i + 1] === "(" || body[i + 1] === "[")) {
      const display = body[i + 1] === "[";
      const close = body.indexOf(display ? "\\]" : "\\)", i + 2);
      if (close > 0) {
        swaps.push({ from: i, to: close + 2 });
        formats.push({
          kind: "math",
          from: i,
          to: close + 2,
          href: "",
          latex: body.slice(i + 2, close),
          display,
        });
        i = close + 2;
        continue;
      }
    }

    if (c === "\\" && i + 1 < body.length) {
      drops.push([i, i + 1]);
      escaped.add(i + 1);
      i += 2;
      continue;
    }

    // Math is scanned before emphasis and code so that a formula's contents
    // are never reinterpreted as markdown.
    if (options.inlineMath && c === "$") {
      const found = scanDollarMath(body, i, options.strictDollar);
      if (found) {
        swaps.push({ from: i, to: found.end });
        formats.push({
          kind: "math",
          from: i,
          to: found.end,
          href: "",
          latex: body.slice(found.bodyStart, found.bodyEnd),
          display: found.display,
        });
        i = found.end;
        continue;
      }
    }

    if (c === "`") {
      let n = 1;
      while (body[i + n] === "`") n++;
      const close = body.indexOf("`".repeat(n), i + n);
      if (close > 0) {
        drops.push([i, i + n], [close, close + n]);
        formats.push({ kind: "code", from: i + n, to: close, href: "" });
        i = close + n;
        continue;
      }
      i += n;
      continue;
    }

    if (c === "[") {
      const close = matchBracket(body, i);
      if (close > 0 && body[close + 1] === "(") {
        const paren = body.indexOf(")", close);
        if (paren > 0) {
          drops.push([i, i + 1], [close, paren + 1]);
          formats.push({
            kind: "link",
            from: i + 1,
            to: close,
            href: body.slice(close + 2, paren),
          });
          i = i + 1;
          continue;
        }
      }
      i++;
      continue;
    }

    if (c === "*" || c === "_" || c === "~") {
      let n = 1;
      while (body[i + n] === c) n++;
      const marker = c === "~" ? (n >= 2 ? "~~" : "") : n >= 2 ? c + c : c;
      if (!marker) {
        i += n;
        continue;
      }
      const len = marker.length;
      const before = body[i - 1];
      const after = body[i + len];
      // CommonMark's flanking rules, in their essential form: a run that has
      // whitespace after it cannot open, and one with whitespace before it
      // cannot close.
      const canOpen = !isSpace(after);
      const canClose = !isSpace(before);
      // `_` does not act as a delimiter inside a word, so snake_case survives.
      const intraword =
        c === "_" &&
        before !== undefined &&
        after !== undefined &&
        !isSpace(before) &&
        !isSpace(after) &&
        !PUNCT.test(before) &&
        !PUNCT.test(after);

      if (!intraword) {
        const top = open.findLastIndex((o) => o.marker === marker);
        if (canClose && top >= 0) {
          const o = open[top];
          open.length = top;
          drops.push([o.at, o.at + len], [i, i + len]);
          formats.push({
            kind: marker === "~~" ? "strike" : len === 2 ? "strong" : "em",
            from: o.contentAt,
            to: i,
            href: "",
          });
          i += len;
          continue;
        }
        if (canOpen) {
          open.push({ marker, at: i, contentAt: i + len });
          i += len;
          continue;
        }
      }
      i += len;
      continue;
    }
    i++;
  }

  // Code and link content is opaque to emphasis, so drop any emphasis that
  // strayed inside one.
  const opaque = formats.filter((f) => f.kind === "code");
  const live = formats.filter(
    (f) => f.kind === "code" || !opaque.some((o) => f.from >= o.from && f.to <= o.to),
  );
  const liveDrops = drops.filter(
    ([a, b]) => !opaque.some((o) => a >= o.from && b <= o.to) || escaped.has(b),
  );
  liveDrops.sort((x, y) => x[0] - y[0]);

  // ---- pass two: emit ---------------------------------------------------
  swaps.sort((a, b) => a.from - b.from);

  /** The first character that will survive into the output at or after `from`. */
  const nextEmitted = (from: number): string => {
    let j = from;
    while (j < body.length) {
      const drop = liveDrops.find(([a, b]) => j >= a && j < b);
      if (drop) {
        j = drop[1];
        continue;
      }
      if (swaps.some((w) => j >= w.from && j < w.to)) return OBJECT_REPLACEMENT;
      if (body[j] === "\n") {
        j++;
        continue;
      }
      return body[j];
    }
    return "";
  };
  let text = "";
  const map: number[] = [];
  const active: Format[][] = [];
  let d = 0;
  let w = 0;
  for (let k = 0; k < body.length; k++) {
    // A formula collapses to one placeholder character, which carries the
    // whole span's source position so the caret can still find it.
    while (w < swaps.length && swaps[w].to <= k) w++;
    if (w < swaps.length && k === swaps[w].from) {
      text += OBJECT_REPLACEMENT;
      map.push(src(k));
      active.push(live.filter((f) => f.from === swaps[w].from && f.kind === "math"));
      k = swaps[w].to - 1;
      continue;
    }
    while (d < liveDrops.length && liveDrops[d][1] <= k) d++;
    if (d < liveDrops.length && k >= liveDrops[d][0] && k < liveDrops[d][1]) continue;

    if (body[k] === "\n") {
      // A continuation line's leading whitespace is not content; CommonMark
      // strips it, and keeping it would put the indentation of the source
      // file into the middle of a sentence.
      let j = k + 1;
      while (j < body.length && (body[j] === " " || body[j] === "\t")) j++;

      // Judge the break by what actually surrounds it in the finished text,
      // not by the raw source: a delimiter or a formula may sit between.
      const before = text.length ? text[text.length - 1] : "";
      const after = nextEmitted(j);
      // Whitespace the author already typed is enough; a break adjacent to it
      // adds nothing.
      const redundant = before === "" || before === " ";
      const wide = options.cjkSoftBreaks && (isWide(before) || isWide(after));
      if (!redundant && !wide) {
        text += " ";
        map.push(src(k));
        active.push([]);
      }
      k = j - 1;
      continue;
    }

    text += body[k];
    map.push(src(k));
    active.push(live.filter((f) => k >= f.from && k < f.to));
  }
  map.push(src(body.length));

  // ---- group runs of identical formatting into spans --------------------
  const spans: Span[] = [];
  let start = 0;
  for (let k = 0; k <= text.length; k++) {
    const same = k > 0 && k < text.length && sameFormat(active[k - 1], active[k]);
    if (same) continue;
    if (k > start) spans.push(spanFrom(active[start], start, k));
    start = k;
  }
  if (!spans.length) spans.push(plainSpan(0, text.length));

  return { text, spans, map: Int32Array.from(map) };
}

function sameFormat(a: Format[], b: Format[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function spanFrom(fs: Format[], start: number, end: number): Span {
  const has = (k: Format["kind"]) => fs.some((f) => f.kind === k);
  const link = fs.find((f) => f.kind === "link");
  const math = fs.find((f) => f.kind === "math");
  if (math) {
    return {
      kind: "math",
      math: math.latex ?? "",
      display: math.display ?? false,
      start,
      end,
      strong: false,
      em: false,
      code: false,
      strike: false,
      href: "",
    };
  }
  return {
    kind: link
      ? "link"
      : has("code")
        ? "code"
        : has("strong")
          ? "strong"
          : has("em")
            ? "em"
            : has("strike")
              ? "strike"
              : "text",
    start,
    end,
    strong: has("strong"),
    em: has("em"),
    code: has("code"),
    strike: has("strike"),
    href: link?.href ?? "",
  };
}

/**
 * Decide whether the dollar at `at` opens a formula, and find its end.
 *
 * Two dollars open display math wherever they appear, following Pandoc. A
 * single dollar is governed by `strict`, which is the difference between
 * reading "$5 and $10" as a price and as a formula.
 */
function scanDollarMath(
  body: string,
  at: number,
  strict: boolean,
): { end: number; bodyStart: number; bodyEnd: number; display: boolean } | null {
  const display = body[at + 1] === "$";
  const delimiter = display ? "$$" : "$";
  const bodyStart = at + delimiter.length;
  if (bodyStart >= body.length) return null;

  if (!display && strict && isSpace(body[bodyStart])) return null;

  let k = bodyStart;
  while (k < body.length) {
    if (body[k] === "\\") {
      k += 2;
      continue;
    }
    // A blank line ends a paragraph, so it also ends any formula.
    if (body[k] === "\n" && body[k + 1] === "\n") return null;
    if (body[k] !== "$") {
      k++;
      continue;
    }
    if (display) {
      if (body[k + 1] === "$") {
        return { end: k + 2, bodyStart, bodyEnd: k, display: true };
      }
      k++;
      continue;
    }
    if (k === bodyStart) return null; // an empty span is not a formula
    if (strict) {
      if (isSpace(body[k - 1])) {
        k++;
        continue;
      }
      // The clause that saves prices: a closing delimiter immediately before
      // a digit is far more likely to be currency than mathematics.
      if (body[k + 1] !== undefined && /\d/.test(body[k + 1])) {
        k++;
        continue;
      }
    }
    return { end: k + 1, bodyStart, bodyEnd: k, display: false };
  }
  return null;
}

/** Index of the `]` matching the `[` at `from`, honouring nesting. */
function matchBracket(body: string, from: number): number {
  let depth = 0;
  for (let i = from; i < body.length; i++) {
    if (body[i] === "\\") {
      i++;
      continue;
    }
    if (body[i] === "[") depth++;
    else if (body[i] === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
