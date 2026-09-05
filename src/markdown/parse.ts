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
}

export type SpanKind = "text" | "strong" | "em" | "code" | "link" | "strike";

export interface Span {
  kind: SpanKind;
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

    const fence = FENCE.exec(line);
    if (fence) {
      const closer = fence[2][0];
      let j = i + 1;
      while (j < count && !new RegExp(`^\\s*${closer}{3,}\\s*$`).test(lines[j])) j++;
      const end = j < count ? offsets[j] + lines[j].length : doc.length;
      blocks.push(block("code", doc.slice(start, end), start, end, { lang: fence[3] }));
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
export function renderBlock(b: Block, raw: boolean): RenderedBlock {
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
    return stripPerLine(b, /^\s*>\s?/);
  } else if (b.type === "list") {
    const m = UL.exec(b.source) ?? OL.exec(b.source);
    if (m) {
      const consumed = m[0].length - m[m.length - 1].length;
      base += consumed;
      body = b.source.slice(consumed);
    }
  }

  const inline = parseInline(body, base);
  return inline;
}

/** Remove a leading marker from every line, e.g. the `>` of a blockquote. */
function stripPerLine(b: Block, marker: RegExp): RenderedBlock {
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
      // A newline inside the quote becomes an ordinary space.
      text += " ";
      map.push(at - 1);
    }
  });
  map.push(b.end);
  // Hand the stripped text on for inline parsing, carrying the map with it —
  // and keep the map that comes back, since emphasis removal shortens it
  // further.
  return parseInline(text, -1, map);
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

/** A stretch of source that carries formatting. */
interface Format {
  kind: Exclude<SpanKind, "text">;
  /** Range of the *content*, in source coordinates. */
  from: number;
  to: number;
  href: string;
}

const PUNCT = /[!-/:-@[-`{-~\u2000-\u206f\u3000-\u303f\uff00-\uffef]/;

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
): RenderedBlock {
  const src = (i: number): number =>
    outerMap ? (outerMap[i] ?? outerMap[outerMap.length - 1]) : base + i;

  const formats: Format[] = [];
  /** Source ranges to omit from the output: delimiters and link targets. */
  const drops: Array<[number, number]> = [];
  /** Source positions that are literal because a backslash escaped them. */
  const escaped = new Set<number>();

  // ---- pass one: find the real delimiters ------------------------------
  const open: Array<{ marker: string; at: number; contentAt: number }> = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];

    if (c === "\\" && i + 1 < body.length) {
      drops.push([i, i + 1]);
      escaped.add(i + 1);
      i += 2;
      continue;
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
  let text = "";
  const map: number[] = [];
  const active: Format[][] = [];
  let d = 0;
  for (let k = 0; k < body.length; k++) {
    while (d < liveDrops.length && liveDrops[d][1] <= k) d++;
    if (d < liveDrops.length && k >= liveDrops[d][0] && k < liveDrops[d][1]) continue;
    text += body[k] === "\n" ? " " : body[k];
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
