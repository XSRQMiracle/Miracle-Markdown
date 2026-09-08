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
  | "frontmatter"
  | "table"
  | "footnote"
  | "html"
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
  /** Task state of a list item written as `- [ ]` or `- [x]`. */
  task: TaskState;
  /** Rows of a table block; the first is the header. */
  rows: TableCell[][];
  /** One entry per column, from the delimiter row. */
  align: ColumnAlign[];
  /** The label of a footnote definition, or of nothing. */
  label: string;
}

/** A table cell, carrying the document offsets its text came from. */
export interface TableCell {
  text: string;
  start: number;
  end: number;
}

export type ColumnAlign = "left" | "center" | "right";

/** Whether a list item carries a checkbox, and whether it is ticked. */
export type TaskState = "none" | "todo" | "done";

export type SpanKind =
  | "text"
  | "note"
  | "strong"
  | "em"
  | "code"
  | "link"
  | "strike"
  | "math"
  | "image";

/**
 * The character standing in for an inline formula in a block's rendered text.
 *
 * Unicode defines U+FFFC for exactly this: a placeholder occupying the place
 * of content the text stream cannot represent. Using it means the formula
 * needs no special case in the tokenizer — it is one more atom in the
 * horizontal list, with a width, a height and a depth like any other.
 */
export const OBJECT_REPLACEMENT = "\uFFFC";

/**
 * The character standing in for a break the author asked for.
 *
 * Unicode defines U+2028 LINE SEPARATOR for exactly this: a line ending
 * within a paragraph, as distinct from the paragraph ending. Carrying it in
 * the text means the line breaker sees a forced break rather than needing a
 * separate channel to be told about one.
 */
export const LINE_SEPARATOR = "\u2028";

export interface Span {
  kind: SpanKind;
  /** LaTeX source, on spans of kind "math". */
  math?: string;
  /** Whether a math span is set in display style. */
  display?: boolean;
  /** Alternative text, on spans of kind "image". */
  alt?: string;
  /** The label a footnote reference points at, on spans of kind "note". */
  label?: string;
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
/** Shared by parsing and preview so an invalid closer remains visible code. */
export function fenceCloser(openingLine: string): RegExp | null {
  const fence = FENCE.exec(openingLine);
  return fence ? new RegExp(`^\\s*${fence[2][0]}{${fence[2].length},}\\s*$`) : null;
}
/** A display formula opened by $$ or by \[ on its own line. */
const MATH_OPEN = /^\s*(\$\$|\\\[)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
/** Front matter opens with exactly three dashes on the document's first line. */
const FRONT_MATTER_OPEN = /^---\s*$/;
/** YAML permits either fence as a terminator. */
const FRONT_MATTER_CLOSE = /^(?:---|\.\.\.)\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const UL = /^(\s*)([-*+])\s+(.*)$/;
/** GFM's task marker: only valid directly after a bullet, and space-separated. */
const TASK = /^\[([ xX])\]\s+/;
/** A table's delimiter row: dashes per column, with optional alignment colons. */
const DELIMITER_CELL = /^:?-+:?$/;
/** A footnote definition: a labelled paragraph that belongs at the foot. */
const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:\s?/;
/** A footnote reference within running text. */
const FOOTNOTE_REF = /^\[\^([^\]\s]+)\]/;

/**
 * HTML blocks, in CommonMark's terms.
 *
 * Only the kinds an author actually writes are recognised. The distinction
 * that matters here is how each one ends, since that is what decides how much
 * of the document the block swallows.
 */
const HTML_RAW_TEXT = /^\s{0,3}<(script|pre|style|textarea)(\s|>|$)/i;
const HTML_RAW_CLOSE = /<\/(script|pre|style|textarea)>/i;
/** A comment, a processing instruction, a declaration, or CDATA. */
const HTML_SPECIAL: Array<[RegExp, RegExp]> = [
  [/^\s{0,3}<!--/, /-->/],
  [/^\s{0,3}<\?/, /\?>/],
  [/^\s{0,3}<![A-Za-z]/, />/],
  [/^\s{0,3}<!\[CDATA\[/, /\]\]>/],
];
/** The block-level tag names CommonMark lists; these end at a blank line. */
const HTML_BLOCK_TAG = new RegExp(
  "^\\s{0,3}</?(address|article|aside|base|basefont|blockquote|body|caption|center|col|" +
  "colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|" +
  "frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|" +
  "noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|" +
  "thead|title|tr|track|ul)(\\s|/?>|$)",
  "i",
);
/**
 * A complete open or close tag alone on its line.
 *
 * Deliberately strict, because this is what stands between an HTML block and
 * an autolink: `<https://example.com>` is not a tag, since a name cannot be
 * followed by a colon, and must stay a link.
 */
const HTML_LONE_TAG =
  /^\s{0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/;

/**
 * Where an HTML block starts, and how it ends.
 *
 * `interrupts` follows CommonMark: every kind but the lone-tag one may break
 * into a paragraph. Excluding that one is what keeps an `<em>` opening a
 * continuation line from splitting the sentence it belongs to.
 */
function htmlBlockStart(
  line: string,
): { closer: RegExp | null; interrupts: boolean } | null {
  if (!line.includes("<")) return null;
  if (HTML_RAW_TEXT.test(line)) return { closer: HTML_RAW_CLOSE, interrupts: true };
  for (const [opener, closer] of HTML_SPECIAL) {
    if (opener.test(line)) return { closer, interrupts: true };
  }
  if (HTML_BLOCK_TAG.test(line)) return { closer: null, interrupts: true };
  if (HTML_LONE_TAG.test(line)) return { closer: null, interrupts: false };
  return null;
}
const OL = /^(\s*)(\d+)([.)])\s+(.*)$/;

interface BlockMathOpen {
  opener: "$$" | "\\[";
  closer: "$$" | "\\]";
  openAt: number;
  /** A closer on the opening line. A non-terminal closer disqualifies the line as a block. */
  sameLineClose: number;
}

/** Find a delimiter that is not itself escaped by an odd run of backslashes. */
function findUnescapedDelimiter(source: string, delimiter: string, from: number): number {
  let at = source.indexOf(delimiter, from);
  while (at >= 0) {
    let slashes = 0;
    for (let i = at - 1; i >= 0 && source[i] === "\\"; i--) slashes++;
    if (slashes % 2 === 0) return at;
    // Advance one code unit so overlapping dollar runs (for example \$$$)
    // still expose a later unescaped candidate.
    at = source.indexOf(delimiter, at + 1);
  }
  return -1;
}

/**
 * Recognise a display-math block opener without stealing a partial line.
 *
 * A complete one-line block may only have whitespace after its closer. When
 * text follows, the whole line remains a paragraph and the inline scanner can
 * preserve both the display formula and its suffix.
 */
function matchBlockMathOpen(line: string, options: InlineOptions): BlockMathOpen | null {
  const match = MATH_OPEN.exec(line);
  if (!match) return null;
  const opener = match[1] as BlockMathOpen["opener"];
  if (opener === "$$" ? !options.inlineMath : !options.texDelimiters) return null;
  const closer = opener === "$$" ? "$$" : "\\]";
  const openAt = line.indexOf(opener);
  const sameLineClose = findUnescapedDelimiter(line, closer, openAt + opener.length);
  if (
    sameLineClose >= 0 &&
    line.slice(sameLineClose + closer.length).trim() !== ""
  ) {
    return null;
  }
  return { opener, closer, openAt, sameLineClose };
}

function interruptsParagraph(
  line: string,
  options: InlineOptions,
  next?: string,
): boolean {
  return (
    line.trim() === "" ||
    // A table's header row is indistinguishable from a paragraph line until
    // the delimiter row beneath it is seen, so an interrupting table can only
    // be recognised with the following line in hand.
    (next !== undefined && tableStartsAt([line, next], 0, 2) !== null) ||
    HEADING.test(line) ||
    FENCE.test(line) ||
    FOOTNOTE_DEF.test(line) ||
    htmlBlockStart(line)?.interrupts === true ||
    matchBlockMathOpen(line, options) !== null ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    UL.test(line) ||
    OL.test(line)
  );
}

/**
 * Split a row into cells, keeping each one's document offsets.
 *
 * A pipe escaped with a backslash is content. The outer pipes are optional in
 * GFM, so a leading or trailing empty cell created by one is dropped — but
 * only when the row actually began or ended with a pipe, since `a || b` has a
 * genuinely empty cell in the middle.
 */
function splitRow(line: string, offset: number): TableCell[] {
  const cells: TableCell[] = [];
  let from = 0;
  for (let i = 0; i <= line.length; i++) {
    if (i < line.length) {
      if (line[i] === "\\" && line[i + 1] === "|") {
        i++;
        continue;
      }
      if (line[i] !== "|") continue;
    }
    const raw = line.slice(from, i);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    cells.push({
      text,
      start: offset + from + leading,
      end: offset + from + leading + text.length,
    });
    from = i + 1;
  }
  if (cells.length && line.trimStart().startsWith("|")) cells.shift();
  if (cells.length && line.trimEnd().endsWith("|") && cells[cells.length - 1].text === "") {
    cells.pop();
  }
  return cells;
}

/** Column alignments, or null when the line is not a delimiter row. */
function delimiterAlignments(line: string): ColumnAlign[] | null {
  if (!line.includes("-")) return null;
  const cells = splitRow(line, 0);
  if (!cells.length) return null;
  const align: ColumnAlign[] = [];
  for (const cell of cells) {
    if (!DELIMITER_CELL.test(cell.text)) return null;
    const left = cell.text.startsWith(":");
    const right = cell.text.endsWith(":");
    align.push(left && right ? "center" : right ? "right" : "left");
  }
  return align;
}

/**
 * Whether a table begins on this line.
 *
 * A header row looks exactly like a paragraph until the delimiter row below
 * it is seen, so the decision needs both lines. GFM also requires the two to
 * agree on how many columns there are.
 */
function tableStartsAt(lines: string[], i: number, count: number): ColumnAlign[] | null {
  if (i + 1 >= count || !lines[i].includes("|")) return null;
  const align = delimiterAlignments(lines[i + 1]);
  if (!align) return null;
  return splitRow(lines[i], 0).length === align.length ? align : null;
}

/**
 * Split a document into blocks.
 *
 * Deliberately line-oriented and allocation-light: re-parsing the whole
 * document on every keystroke is affordable at this granularity, and it
 * sidesteps a class of incremental-parser bugs that a v1 does not need.
 */
export function parseBlocks(
  doc: string,
  options: InlineOptions = DEFAULT_INLINE_OPTIONS,
): Block[] {
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

  // Ordered lists number themselves. CommonMark takes the start from the
  // first item and ignores every number after it, so "1. 1. 1." reads as
  // 1, 2, 3 — which is what lets an author reorder items without renumbering
  // the source by hand. A stack, because a nested list has its own counter and
  // the outer one must resume where it left off.
  const counters: ListCounter[] = [];

  // Front matter, if the document opens with it. This must be decided before
  // the rule branch, which would otherwise claim the opening dashes, and only
  // at the very first line: three dashes anywhere else are a thematic break.
  // Without a terminator it stays a rule, so a document that merely begins
  // with a divider is not swallowed whole.
  let i = 0;
  if (count > 1 && FRONT_MATTER_OPEN.test(lines[0])) {
    let j = 1;
    while (j < count && !FRONT_MATTER_CLOSE.test(lines[j])) j++;
    if (j < count) {
      const end = offsets[j] + lines[j].length;
      blocks.push(block("frontmatter", doc.slice(0, end), 0, end));
      i = j + 1;
    }
  }

  while (i < count) {
    const line = lines[i];
    const start = offsets[i];

    // Display math, opened by $$ or \[. Both may close on the same line.
    const mathOpen = matchBlockMathOpen(line, options);
    if (mathOpen) {
      const { opener, closer, openAt, sameLineClose } = mathOpen;
      const afterOpen = start + openAt + opener.length;
      let end: number;
      let bodyEnd: number;
      let suffix: Block | null = null;
      if (sameLineClose >= 0) {
        bodyEnd = start + sameLineClose;
        // matchBlockMathOpen guarantees that only whitespace follows. Keep it
        // in the raw block so source ranges still cover the complete line.
        end = start + line.length;
        i++;
      } else {
        let j = i + 1;
        let closeAt = -1;
        while (j < count) {
          closeAt = findUnescapedDelimiter(lines[j], closer, 0);
          if (closeAt >= 0) break;
          j++;
        }
        if (j < count) {
          bodyEnd = offsets[j] + closeAt;
          const closeEnd = bodyEnd + closer.length;
          const tail = lines[j].slice(closeAt + closer.length);
          if (tail.trim() === "") {
            end = offsets[j] + lines[j].length;
            i = j + 1;
          } else {
            // A block closer ends the formula, but any source following it is
            // a paragraph rather than disposable trivia. Include ordinary
            // continuation lines so the split does not invent a hard break.
            end = closeEnd;
            let k = j + 1;
            while (k < count && !interruptsParagraph(lines[k], options, lines[k + 1])) k++;
            const suffixEnd = blockEnd(doc, offsets, lines.length, k, closeEnd, tail);
            suffix = block("paragraph", doc.slice(closeEnd, suffixEnd), closeEnd, suffixEnd);
            i = k;
          }
        } else {
          // Unterminated: treat the rest of the document as the formula so the
          // reader can see what they are typing rather than losing it.
          bodyEnd = doc.length;
          end = doc.length;
          i = count;
        }
      }
counters.length = 0;
      blocks.push(
        block("math", doc.slice(start, end), start, end, {
          math: doc.slice(afterOpen, bodyEnd),
        }),
      );
      if (suffix) blocks.push(suffix);
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      // CommonMark requires the closing run to use the same character and to
      // be at least as long as the opener. Compile this once for the whole
      // block; a shorter run is content, not a premature close.
      const closeFence = fenceCloser(line)!;
      let j = i + 1;
      while (j < count && !closeFence.test(lines[j])) j++;
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
counters.length = 0;
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
counters.length = 0;
      blocks.push(block("rule", line, start, start + line.length, {}));
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
counters.length = 0;
      blocks.push(
        block("heading", line, start, start + line.length, { level: heading[1].length }),
      );
      i++;
      continue;
    }

    // HTML is shown as written. Rendering it would mean implementing a second
    // layout engine on the canvas; showing the source is both honest and what
    // an author editing markup wants to see.
    const html = htmlBlockStart(line);
    if (html) {
      let j = i;
      if (html.closer) {
        while (j < count && !html.closer.test(lines[j])) j++;
        j = Math.min(j + 1, count);
      } else {
        j = i + 1;
        while (j < count && lines[j].trim() !== "") j++;
      }
      const end = j > i ? offsets[j - 1] + lines[j - 1].length : start + line.length;
      counters.length = 0;
      blocks.push(block("html", doc.slice(start, end), start, end));
      i = j;
      continue;
    }

    const note = FOOTNOTE_DEF.exec(line);
    if (note) {
      // A definition runs on like a paragraph, so an author can write more
      // than one line without indenting a continuation.
      let j = i + 1;
      while (j < count && !interruptsParagraph(lines[j], options, lines[j + 1])) j++;
      const end = blockEnd(doc, offsets, lines.length, j, start, line);
      counters.length = 0;
      blocks.push(
        block("footnote", doc.slice(start, end), start, end, { label: note[1] }),
      );
      i = j;
      continue;
    }

    const align = tableStartsAt(lines, i, count);
    if (align) {
      const rows: TableCell[][] = [splitRow(line, start)];
      let j = i + 2;
      while (j < count && lines[j].includes("|") && lines[j].trim() !== "") {
        rows.push(splitRow(lines[j], offsets[j]));
        j++;
      }
      const end = offsets[j - 1] + lines[j - 1].length;
      counters.length = 0;
      blocks.push(block("table", doc.slice(start, end), start, end, { rows, align }));
      i = j;
      continue;
    }

    const ul = UL.exec(line);
    const ol = OL.exec(line);
    if (ul || ol) {
      // A list item continues over ordinary lazy continuation lines, but a
      // block opener starts a new block just as it would after a paragraph.
      let j = i + 1;
      while (j < count && !interruptsParagraph(lines[j], options, lines[j + 1])) j++;
      const end = blockEnd(doc, offsets, lines.length, j, start, line);
      const indent = (ul ? ul[1] : ol![1]).length;
      const level = Math.floor(indent / 2) + 1;
      // A checkbox belongs to a bullet. An ordered item that happens to start
      // with "[x]" is a link label the author is still typing, not a task.
      const task = ul ? TASK.exec(ul[3]) : null;
      blocks.push(
        block("list", doc.slice(start, end), start, end, {
          level,
          ordered: !!ol,
          marker: listMarker(counters, level, ol),
          task: task ? (task[1] === " " ? "todo" : "done") : "none",
        }),
      );
      i = j;
      continue;
    }

    if (QUOTE.test(line)) {
      let j = i;
      while (j < count && QUOTE.test(lines[j])) j++;
      const end = blockEnd(doc, offsets, lines.length, j, start, line);
counters.length = 0;
      blocks.push(block("quote", doc.slice(start, end), start, end));
      i = j;
      continue;
    }

    // Paragraph: run on until a blank line or a block that interrupts.
    let j = i + 1;
    while (j < count && !interruptsParagraph(lines[j], options, lines[j + 1])) j++;
    const end = blockEnd(doc, offsets, lines.length, j, start, line);
counters.length = 0;
    blocks.push(block("paragraph", doc.slice(start, end), start, end));
    i = j;
  }

  if (blocks.length === 0) {
    blocks.push(block("paragraph", "", 0, 0));
  }
  return blocks;
}

/**
 * The number to print on an ordered list item.
 *
 * Deeper levels are discarded on the way out of a nested list, so returning to
 * the outer level resumes its own count rather than restarting. A level that
 * changes between bullets and numbers starts over, since the two are not the
 * same list.
 */
function listMarker(
  counters: ListCounter[],
  level: number,
  ordered: RegExpExecArray | null,
): string {
  // Leaving a nested list discards its counter; the level we return to keeps
  // its own and carries on.
  while (counters.length && counters[counters.length - 1].level > level) counters.pop();
  const top = counters[counters.length - 1];
  const continues = top !== undefined && top.level === level && top.ordered === !!ordered;

  if (!ordered) {
    // Bullets need no count, but the level must still be claimed so that a
    // later number restarts rather than resuming a list this one interrupted.
    if (!continues) {
      if (top && top.level === level) counters.pop();
      counters.push({ level, ordered: false, next: 0, delimiter: "" });
    }
    return "•";
  }

  if (continues) return `${top.next++}${top.delimiter}`;
  if (top && top.level === level) counters.pop();
  const written = Number.parseInt(ordered[2], 10);
  const from = Number.isFinite(written) ? written : 1;
  counters.push({ level, ordered: true, next: from + 1, delimiter: ordered[3] });
  return `${from}${ordered[3]}`;
}

/**
 * Locate a caret position in an ordered block list.
 *
 * Block source ranges are half-open, while a caret may also sit just after a
 * block's last character. Usually that end position still belongs to the
 * block. If the next block starts at the exact same position, however, the
 * shared boundary belongs to the next block so adjacent source fragments stay
 * editable.
 */
export function blockIndexAtPosition(blocks: readonly Block[], position: number): number {
  for (let i = 0; i < blocks.length; i++) {
    if (sourceRangeOwnsPosition(blocks[i], blocks[i + 1], position)) return i;
  }
  return -1;
}

export interface SourceRange {
  start: number;
  end: number;
}

/** The shared ownership rule used by parsing, focus and canvas hit testing. */
export function sourceRangeOwnsPosition(
  current: SourceRange,
  next: SourceRange | undefined,
  position: number,
): boolean {
  if (position < current.start || position > current.end) return false;
  return position !== current.end || next?.start !== position;
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
    task: extra.task ?? "none",
    rows: extra.rows ?? [],
    align: extra.align ?? [],
    label: extra.label ?? "",
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
  if (raw || b.type === "code" || b.type === "frontmatter" || b.type === "html") {
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
  } else if (b.type === "footnote") {
    const m = FOOTNOTE_DEF.exec(b.source);
    if (m) {
      base += m[0].length;
      body = b.source.slice(m[0].length);
    }
  } else if (b.type === "list") {
    // UL and OL deliberately match a complete source line. Match only the
    // first one here so a lazy continuation does not prevent the list marker
    // from being stripped from a multi-line item.
    const newline = b.source.indexOf("\n");
    const firstLine = newline >= 0 ? b.source.slice(0, newline) : b.source;
    const m = UL.exec(firstLine) ?? OL.exec(firstLine);
    if (m) {
      let consumed = m[0].length - m[m.length - 1].length;
      // The checkbox is drawn as a marker, so it is not part of the text. It
      // has to go before inline parsing rather than after, or its bracket
      // would be scanned as a link label.
      if (b.task !== "none") {
        const task = TASK.exec(b.source.slice(consumed));
        if (task) consumed += task[0].length;
      }
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

/** One level of an in-progress list, for numbering ordered items. */
interface ListCounter {
  level: number;
  ordered: boolean;
  next: number;
  delimiter: string;
}

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
  /** Alternative text, on image formats. */
  alt?: string;
  /** Footnote label, on note formats. */
  label?: string;
}

/**
 * The ASCII punctuation characters CommonMark permits after a backslash.
 *
 * Keep this narrower than `PUNCT` below: that expression also contains
 * Unicode punctuation for emphasis flanking, while a backslash before `。` or
 * any other non-ASCII character is literal source and must survive.
 */
function isEscapableAsciiPunctuation(c: string | undefined): boolean {
  if (c === undefined) return false;
  const n = c.charCodeAt(0);
  return (
    (n >= 0x21 && n <= 0x2f) ||
    (n >= 0x3a && n <= 0x40) ||
    (n >= 0x5b && n <= 0x60) ||
    (n >= 0x7b && n <= 0x7e)
  );
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
  /** Newlines the author marked as breaks, by backslash or trailing spaces. */
  const hardBreaks = new Set<number>();
  /** Label-local scan boundaries, including the emphasis stack they own. */
  const linkLabels: Array<{ start: number; close: number; end: number; openStart: number }> = [];

  // ---- pass one: find the real delimiters ------------------------------
  const open: Array<{ marker: string; at: number; contentAt: number }> = [];
  let i = 0;
  while (i < body.length) {
    const label = linkLabels.at(-1);
    if (label && i === label.close) {
      // The label has already been scanned for inline formatting. Skip its
      // closing bracket and the complete destination so math or emphasis in
      // the URL cannot leak back into the rendered label.
      open.length = label.openStart;
      linkLabels.pop();
      i = label.end;
      continue;
    }

    const limit = label?.close ?? body.length;
    const c = body[i];

    if (options.texDelimiters && c === "\\" && (body[i + 1] === "(" || body[i + 1] === "[")) {
      const display = body[i + 1] === "[";
      const close = findUnescapedDelimiter(body, display ? "\\]" : "\\)", i + 2);
      if (close > 0 && close + 2 <= limit) {
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

    if (c === "\\" && body[i + 1] === "\n") {
      // CommonMark's other spelling of a hard break. The slash itself is not
      // content; the newline that follows becomes the break.
      drops.push([i, i + 1]);
      hardBreaks.add(i + 1);
      i += 2;
      continue;
    }

    if (c === "\\" && isEscapableAsciiPunctuation(body[i + 1])) {
      drops.push([i, i + 1]);
      escaped.add(i + 1);
      i += 2;
      continue;
    }

    // Math is scanned before emphasis and code so that a formula's contents
    // are never reinterpreted as markdown.
    if (options.inlineMath && c === "$") {
      const found = scanDollarMath(body, i, options.strictDollar, limit);
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
      const code = scanBackticks(body, i, limit);
      if (code.close >= 0) {
        drops.push([i, code.contentAt], [code.close, code.end]);
        formats.push({ kind: "code", from: code.contentAt, to: code.close, href: "" });
      }
      i = code.end;
      continue;
    }

    if (c === "[" && body[i + 1] === "^") {
      const ref = FOOTNOTE_REF.exec(body.slice(i, limit));
      if (ref) {
        swaps.push({ from: i, to: i + ref[0].length });
        formats.push({
          kind: "note",
          from: i,
          to: i + ref[0].length,
          href: "",
          label: ref[1],
        });
        i += ref[0].length;
        continue;
      }
    }

    // An image is a link that resolves to a picture rather than to text, so
    // it becomes a placeholder like a formula: its alt text is a fallback,
    // not content, and the typesetter needs a box rather than characters.
    if (c === "!" && body[i + 1] === "[") {
      const close = matchBracket(body, i + 1, limit);
      if (close > 0 && close < limit && body[close + 1] === "(") {
        const target = matchLinkDestination(body, close + 1, limit);
        if (target) {
          swaps.push({ from: i, to: target.end });
          formats.push({
            kind: "image",
            from: i,
            to: target.end,
            href: target.href,
            alt: body.slice(i + 2, close),
          });
          i = target.end;
          continue;
        }
      }
    }

    // An autolink is only a link when it is not already inside one: CommonMark
    // forbids a link within a link, and letting both formats cover the same
    // characters would leave the span builder to choose arbitrarily.
    if (c === "<" && !label) {
      const auto = matchAutolink(body, i, limit);
      if (auto) {
        drops.push([i, i + 1], [auto.close, auto.close + 1]);
        formats.push({ kind: "link", from: i + 1, to: auto.close, href: auto.href });
        i = auto.close + 1;
        continue;
      }
    }

    if (c === "[") {
      const close = matchBracket(body, i, limit);
      if (close > 0 && close < limit && body[close + 1] === "(") {
        const target = matchLinkDestination(body, close + 1, limit);
        if (target) {
          drops.push([i, i + 1], [close, target.end]);
          linkLabels.push({ start: i + 1, close, end: target.end, openStart: open.length });
          formats.push({
            kind: "link",
            from: i + 1,
            to: close,
            href: target.href,
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
      while (i + n < limit && body[i + n] === c) n++;
      const marker = c === "~" ? (n >= 2 ? "~~" : "") : n >= 2 ? c + c : c;
      if (!marker) {
        i += n;
        continue;
      }
      const len = marker.length;
      const before = i === label?.start ? undefined : body[i - 1];
      const after = i + len < limit ? body[i + len] : undefined;
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
        if (canClose && top >= (label?.openStart ?? 0)) {
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

  // Code content is opaque to emphasis, so drop any emphasis that
  // strayed inside one.
  const opaque = formats.filter((f) => f.kind === "code");
  const insideCode = (at: number) => opaque.some((o) => at >= o.from && at < o.to);

  // Two or more spaces at the end of a line are CommonMark's original hard
  // break. The spaces themselves are not content — they exist only to carry
  // the instruction — so they are dropped along with being noted. Inside a
  // code span they are content and mean nothing, which is why this runs after
  // the opaque ranges are known rather than during the scan.
  for (let k = 0; k < body.length; k++) {
    if (body[k] !== "\n" || insideCode(k)) continue;
    let run = k;
    while (run > 0 && body[run - 1] === " ") run--;
    if (k - run >= 2) {
      drops.push([run, k]);
      hardBreaks.add(k);
    }
  }
  for (const at of [...hardBreaks]) if (insideCode(at)) hardBreaks.delete(at);

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
      active.push(
        live.filter(
          (f) =>
            f.from === swaps[w].from &&
            (f.kind === "math" || f.kind === "image" || f.kind === "note"),
        ),
      );
      k = swaps[w].to - 1;
      continue;
    }
    while (d < liveDrops.length && liveDrops[d][1] <= k) d++;
    if (d < liveDrops.length && k >= liveDrops[d][0] && k < liveDrops[d][1]) continue;

    if (body[k] === "\n" && hardBreaks.has(k) && text.length) {
      // A break the author asked for holds wherever it falls, so it survives
      // the soft-break rules entirely — including the CJK one, which exists to
      // discard breaks the author did *not* intend.
      text += LINE_SEPARATOR;
      map.push(src(k));
      active.push([]);
      let j = k + 1;
      while (j < body.length && (body[j] === " " || body[j] === "\t")) j++;
      k = j - 1;
      continue;
    }

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
  const image = fs.find((f) => f.kind === "image");
  const note = fs.find((f) => f.kind === "note");
  if (note) {
    return {
      kind: "note",
      label: note.label ?? "",
      start,
      end,
      strong: false,
      em: false,
      code: false,
      strike: false,
      href: "",
    };
  }
  if (image) {
    return {
      kind: "image",
      alt: image.alt ?? "",
      href: image.href,
      start,
      end,
      strong: false,
      em: false,
      code: false,
      strike: false,
    };
  }
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
  limit: number = body.length,
): { end: number; bodyStart: number; bodyEnd: number; display: boolean } | null {
  const display = body[at + 1] === "$";
  const delimiter = display ? "$$" : "$";
  const bodyStart = at + delimiter.length;
  if (bodyStart >= limit) return null;

  if (!display && strict && isSpace(body[bodyStart])) return null;

  let k = bodyStart;
  while (k < limit) {
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
      if (k + 1 < limit && body[k + 1] === "$") {
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
      if (k + 1 < limit && /\d/.test(body[k + 1])) {
        k++;
        continue;
      }
    }
    return { end: k + 1, bodyStart, bodyEnd: k, display: false };
  }
  return null;
}

/**
 * A URI autolink: a scheme, a colon, then anything but whitespace and angle
 * brackets. The scheme is what separates `<https://x>` from `<div>`, so HTML
 * that happens to sit in a paragraph is left alone.
 */
const AUTOLINK_URI = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\x00-\x20]*>/;

/**
 * An email autolink. CommonMark spells this out separately because it carries
 * no scheme; the `mailto:` is supplied by the renderer, not the author.
 */
const AUTOLINK_EMAIL =
  /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/;

/** Where the closing angle bracket sits, and what the link points at. */
function matchAutolink(
  body: string,
  from: number,
  limit: number,
): { close: number; href: string } | null {
  const candidate = body.slice(from, limit);
  const uri = AUTOLINK_URI.exec(candidate);
  if (uri) {
    return { close: from + uri[0].length - 1, href: uri[0].slice(1, -1) };
  }
  const email = AUTOLINK_EMAIL.exec(candidate);
  if (email) {
    return { close: from + email[0].length - 1, href: `mailto:${email[0].slice(1, -1)}` };
  }
  return null;
}

/**
 * Match whole backtick runs, never a prefix of a longer run. The same scanner
 * determines code opacity while finding a label and while parsing its text.
 * An unmatched opener advances over that complete run as literal content.
 */
function scanBackticks(
  body: string,
  from: number,
  limit: number,
): { contentAt: number; close: number; end: number } {
  let contentAt = from + 1;
  while (contentAt < limit && body[contentAt] === "`") contentAt++;
  let at = contentAt;
  while (at < limit) {
    const close = body.indexOf("`", at);
    if (close < 0 || close >= limit) break;
    let end = close + 1;
    while (end < limit && body[end] === "`") end++;
    if (end - close === contentAt - from) return { contentAt, close, end };
    at = end;
  }
  return { contentAt, close: -1, end: contentAt };
}

/** Index of the matching `]`, honouring nesting, escapes, and opaque code. */
function matchBracket(body: string, from: number, limit: number): number {
  let depth = 0;
  for (let i = from; i < limit; i++) {
    if (body[i] === "\\" && isEscapableAsciiPunctuation(body[i + 1])) {
      i++;
      continue;
    }
    if (body[i] === "`") {
      i = scanBackticks(body, i, limit).end - 1;
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

/**
 * Parse the complete link tail before hiding any source. Angle destinations,
 * bare destinations, and titles have different delimiter rules; balancing all
 * parentheses together can consume prose after the actual link.
 */
function matchLinkDestination(
  body: string,
  from: number,
  limit: number,
): { end: number; href: string } | null {
  const start = skipLinkWhitespace(body, from + 1, limit);
  if (start < 0 || start >= limit) return null;
  if (body[start] === ")") return { end: start + 1, href: "" };

  let i = start;
  let destinationStart = start;
  let destinationEnd = -1;
  if (body[i] === "<") {
    destinationStart = ++i;
    while (i < limit) {
      if (body[i] === "\\" && isEscapableAsciiPunctuation(body[i + 1])) i += 2;
      else if (body[i] === "<" || body[i] === "\n" || body[i] === "\r") break;
      else if (body[i] === ">") {
        destinationEnd = i++;
        break;
      } else i++;
    }
  } else {
    let depth = 0;
    while (i < limit) {
      const c = body[i];
      if (c.charCodeAt(0) <= 0x20 || c.charCodeAt(0) === 0x7f) break;
      if (c === "\\" && isEscapableAsciiPunctuation(body[i + 1])) {
        i += 2;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) break;
        depth--;
      }
      i++;
    }
    if (depth === 0 && i > start) destinationEnd = i;
  }

  if (destinationEnd >= 0) {
    const after = skipLinkWhitespace(body, i, limit);
    let close = after;
    if (after > i && body[after] !== ")") {
      const titleEnd = matchLinkTitle(body, after, limit);
      close = titleEnd < 0 ? -1 : skipLinkWhitespace(body, titleEnd, limit);
    }
    if (close >= 0 && close < limit && body[close] === ")") {
      const href = body.slice(destinationStart, destinationEnd).replace(
        /\\(.)/g,
        (escape, c: string) => isEscapableAsciiPunctuation(c) ? c : escape,
      );
      return { end: close + 1, href };
    }
  }

  // A title can appear without a destination, but a valid destination takes
  // precedence: ("title") links to the literal URL "title", quotes included.
  const titleEnd = matchLinkTitle(body, start, limit);
  const close = titleEnd < 0 ? -1 : skipLinkWhitespace(body, titleEnd, limit);
  return close >= 0 && close < limit && body[close] === ")"
    ? { end: close + 1, href: "" }
    : null;
}

/** Components permit spaces, tabs, and at most one line ending between them. */
function skipLinkWhitespace(body: string, from: number, limit: number): number {
  let lineEndings = 0;
  let i = from;
  while (i < limit) {
    if (body[i] === " " || body[i] === "\t") i++;
    else if (body[i] === "\n" || body[i] === "\r") {
      if (++lineEndings > 1) return -1;
      if (body[i] === "\r" && body[i + 1] === "\n") i++;
      i++;
    } else break;
  }
  return i;
}

/** End just after a quoted or parenthesized title, before trailing whitespace. */
function matchLinkTitle(body: string, from: number, limit: number): number {
  const opener = body[from];
  if (opener !== '"' && opener !== "'" && opener !== "(") return -1;
  const closer = opener === "(" ? ")" : opener;
  for (let i = from + 1; i < limit; i++) {
    const c = body[i];
    if (c === "\\" && isEscapableAsciiPunctuation(body[i + 1])) i++;
    else if (c === closer) return i + 1;
    else if (opener === "(" && c === "(") return -1;
    else if (c === "\n" || c === "\r") {
      const after = skipLinkWhitespace(body, i, limit);
      if (after < 0) return -1;
      i = after - 1;
    }
  }
  return -1;
}
