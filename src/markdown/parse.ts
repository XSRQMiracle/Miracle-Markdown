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
  | "highlight"
  | "sub"
  | "sup"
  | "underline"
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
  highlight: boolean;
  sub: boolean;
  sup: boolean;
  underline: boolean;
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
 * A list item's marker, as the author wrote it.
 *
 * The `marker` on a Block is the *rendered* one — a bullet, or the number the
 * item takes in sequence — which is what the typesetter draws but not what the
 * editor must write to continue the list. This reads the source instead, and
 * does it with the parser's own patterns so that what the editor writes is
 * exactly what the parser will read back as another item.
 */
export interface ListItemMarker {
  /** Indent, marker, its trailing space, and a task box if there is one. */
  prefix: string;
  /** Whether the item holds nothing but its marker. */
  empty: boolean;
  /** The prefix that continues the list on the following line. */
  next: string;
  /** The same item one level further out, or null at the outermost level. */
  outdented: string | null;
}

export function listItemMarker(line: string): ListItemMarker | null {
  const ul = UL.exec(line);
  const ol = ul ? null : OL.exec(line);
  if (!ul && !ol) return null;

  const indent = ul ? ul[1] : ol![1];
  const body = ul ? ul[3] : ol![4];
  // A checkbox is part of the marker: continuing a task list gives another
  // task, and an item holding only an empty box is still an empty item.
  const box = ul ? TASK.exec(body)?.[0] ?? "" : "";
  const prefix = line.slice(0, line.length - body.length + box.length);
  // A ticked box never carries over — the new item is a new task, not a
  // finished one.
  const carried = box ? "[ ] " : "";
  const bullet = ul ? `${ul[2]} ` : `${Number.parseInt(ol![2], 10) + 1}${ol![3]} `;

  return {
    prefix,
    empty: body.slice(box.length).trim() === "",
    next: indent + bullet + carried,
    // Written numbering only sets where a list starts; the rest is counted by
    // position, so carrying the marker out one level needs no renumbering.
    outdented: /^ {2}/.test(prefix) ? prefix.slice(2) : null,
  };
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
    // This function joins the lines itself, so the newline that would have
    // carried a hard break never reaches the inline scanner. The marker has
    // to be read — and consumed — here instead, or a quoted line ending in a
    // backslash keeps it as content and the break is lost either way.
    const forced = n + 1 < lines.length ? hardBreakMarker(line, skip) : null;
    const content = forced === null ? line.length : forced;
    for (let i = skip; i < content; i++) {
      text += line[i];
      map.push(at + i);
    }
    at += line.length + 1;
    if (n + 1 < lines.length) {
      if (forced !== null) {
        text += LINE_SEPARATOR;
        map.push(at - 1);
        return;
      }
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

/**
 * Where a line's content stops because the author asked for a break, or null
 * if it did not.
 *
 * Both of CommonMark's spellings: a trailing backslash, or two or more
 * trailing spaces. The returned index excludes the marker, which is an
 * instruction rather than content.
 */
function hardBreakMarker(line: string, from: number): number | null {
  if (line.length > from && line.endsWith("\\")) {
    // An even run of backslashes is escaped literals, not a break.
    let slashes = 0;
    for (let i = line.length - 1; i >= from && line[i] === "\\"; i--) slashes++;
    return slashes % 2 === 1 ? line.length - 1 : null;
  }
  let end = line.length;
  while (end > from && line[end - 1] === " ") end--;
  return line.length - end >= 2 ? end : null;
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
    highlight: false,
    sub: false,
    sup: false,
    underline: false,
    href: "",
  };
}

/** How the inline scanner should treat math delimiters. */
export interface InlineOptions {
  /**
   * Recognise `H~2~O` and `X^2^`.
   *
   * Off by default, as in Typora. A tilde is a real character in prose and a
   * caret is a real character in code, and a document written before anyone
   * asked for subscripts should not suddenly grow them. The rule is
   * deliberately narrow — no spaces inside, no markup inside — which is what
   * keeps `~` from colliding with `~~strikethrough~~` and with itself.
   */
  subscript: boolean;
  superscript: boolean;
  /**
   * Recognise `==highlighted==` text.
   *
   * Off by default, as it is in Typora: `==` is not CommonMark, and a
   * document that writes it for something else — a rule, an equation — should
   * keep saying what it says.
   */
  highlight: boolean;
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
  subscript: false,
  superscript: false,
  highlight: false,
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
  const swaps: Format[] = [];
  const codeRanges: Array<[number, number]> = [];
  const delimiters = new InlineDelimiterIndex(body);
  /** Newlines the author marked as breaks, by backslash or trailing spaces. */
  const hardBreaks = new Set<number>();
  /** Where a <br> was written, in place of which a break is emitted. */
  const tagBreaks = new Set<number>();
  /** Label-local scan boundaries, including the emphasis stack they own. */
  const linkLabels: Array<{ start: number; close: number; end: number; openStart: number }> = [];

  // ---- pass one: find the real delimiters ------------------------------
  const open: Array<{ marker: string; at: number; contentAt: number; previous: number }> = [];
  const lastOpen = new Map<string, number>();
  const truncateOpen = (length: number): void => {
    while (open.length > length) {
      const removed = open.pop()!;
      lastOpen.set(removed.marker, removed.previous);
    }
  };
  let markerEnd = 0;
  let i = 0;
  while (i < body.length) {
    const label = linkLabels.at(-1);
    if (label && i === label.close) {
      // The label has already been scanned for inline formatting. Skip its
      // closing bracket and the complete destination so math or emphasis in
      // the URL cannot leak back into the rendered label.
      truncateOpen(label.openStart);
      linkLabels.pop();
      i = label.end;
      continue;
    }

    const limit = label?.close ?? body.length;
    const c = body[i];

    if (options.texDelimiters && c === "\\" && (body[i + 1] === "(" || body[i + 1] === "[")) {
      const display = body[i + 1] === "[";
      const close = delimiters.texCloser(i + 2, display);
      if (close > 0 && close + 2 <= limit) {
        swaps.push({
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
      i += 2;
      continue;
    }

    // Math is scanned before emphasis and code so that a formula's contents
    // are never reinterpreted as markdown.
    if (options.inlineMath && c === "$") {
      const found = delimiters.dollarMath(i, options.strictDollar, limit);
      if (found) {
        swaps.push({
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
      const code = delimiters.backticks(i, limit);
      if (code.close >= 0) {
        drops.push([i, code.contentAt], [code.close, code.end]);
        formats.push({ kind: "code", from: code.contentAt, to: code.close, href: "" });
        codeRanges.push([code.contentAt, code.close]);
      }
      i = code.end;
      continue;
    }

    if (c === "[" && body[i + 1] === "^") {
      const ref = delimiters.footnote(i, limit);
      if (ref) {
        swaps.push({
          kind: "note",
          from: i,
          to: ref.end,
          href: "",
          label: ref.label,
        });
        i = ref.end;
        continue;
      }
    }

    // An image is a link that resolves to a picture rather than to text, so
    // it becomes a placeholder like a formula: its alt text is a fallback,
    // not content, and the typesetter needs a box rather than characters.
    if (c === "!" && body[i + 1] === "[") {
      const close = delimiters.bracket(i + 1, limit);
      if (close > 0 && close < limit && body[close + 1] === "(") {
        const target = matchLinkDestination(body, close + 1, limit);
        if (target) {
          swaps.push({
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

    // Inline HTML. Typora renders a handful of tags rather than showing
    // their source, and does it with no preference to turn off — they are
    // how markdown has always written the things it has no syntax for.
    if (c === "<") {
      const br = INLINE_BREAK.exec(body.slice(i, limit));
      if (br) {
        // A <br> is a hard break like any other. All of the tag but its last
        // character is dropped; that character is what the break is emitted
        // in place of, so it survives the merging of adjacent dropped ranges
        // and the emitter can still find it.
        const at = i + br[0].length - 1;
        drops.push([i, at]);
        tagBreaks.add(at);
        i = at + 1;
        continue;
      }
      const tag = matchInlineTag(body, i, limit);
      if (tag) {
        drops.push([i, tag.contentAt], [tag.close, tag.end]);
        formats.push({ kind: tag.kind, from: tag.contentAt, to: tag.close, href: "" });
        i = tag.contentAt;
        continue;
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
      const close = delimiters.bracket(i, limit);
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

    // A subscript or a superscript is one narrow pair: no spaces inside, and
    // nothing inside re-read as markup. That is Typora's rule, and it is what
    // stops a lone `~` in prose or a `^` in a formula from opening one.
    if ((c === "~" && options.subscript) || (c === "^" && options.superscript)) {
      const run = markerRun(body, i, c, limit);
      // A tilde inside an unclosed `~~` belongs to the strikethrough that is
      // waiting to close, not to a subscript: Typora reaches the same answer
      // by testing its `del` rule first.
      const pending = c === "~" && open.some((o) => o.marker === "~~");
      if (run === 1 && !pending) {
        const found = shortPair(body, i, c, limit);
        if (found) {
          drops.push([i, i + 1], [found.close, found.close + 1]);
          for (const at of found.escapes) drops.push([at, at + 1]);
          formats.push({ kind: c === "~" ? "sub" : "sup", from: i + 1, to: found.close, href: "" });
          i = found.close + 1;
          continue;
        }
      }
      if (c === "^") {
        i += run;
        continue;
      }
    }

    if (c === "*" || c === "_" || c === "~" || (c === "=" && options.highlight)) {
      if (i >= markerEnd) {
        markerEnd = i + 1;
        while (markerEnd < limit && body[markerEnd] === c) markerEnd++;
      }
      const n = markerEnd - i;
      // A single tilde or equals is not a delimiter: `~~` is strikethrough and
      // `==` is a highlight, and a lone one of either is ordinary punctuation.
      const marker = c === "~" || c === "="
        ? (n >= 2 ? c + c : "")
        : n >= 2 ? c + c : c;
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
        const top = lastOpen.get(marker) ?? -1;
        if (canClose && top >= (label?.openStart ?? 0)) {
          const o = open[top];
          truncateOpen(top);
          drops.push([o.at, o.at + len], [i, i + len]);
          formats.push({
            kind: marker === "~~" ? "strike"
              : marker === "==" ? "highlight"
              : len === 2 ? "strong" : "em",
            from: o.contentAt,
            to: i,
            href: "",
          });
          i += len;
          continue;
        }
        if (canOpen) {
          lastOpen.set(marker, open.length);
          open.push({ marker, at: i, contentAt: i + len, previous: top });
          i += len;
          continue;
        }
      }
      i += len;
      continue;
    }
    i++;
  }

  // Pass one skips code as a whole, so neither formats nor drops can begin
  // inside it. Newline processing is the only later pass that needs opacity.
  // The disjoint ranges arrive in source order and each is visited once.
  let codeRange = 0;
  for (let k = 0; k < body.length; k++) {
    if (body[k] !== "\n") continue;
    while (codeRange < codeRanges.length && codeRanges[codeRange][1] <= k) codeRange++;
    if (codeRange < codeRanges.length && codeRanges[codeRange][0] <= k) continue;
    let run = k;
    while (run > 0 && body[run - 1] === " ") run--;
    if (k - run >= 2) {
      drops.push([run, k]);
      hardBreaks.add(k);
    }
  }

  // Merge overlapping omitted ranges once. Both the emitter and its newline
  // lookahead can now walk them monotonically rather than search every range.
  drops.sort((a, b) => a[0] - b[0]);
  const omitted: Array<[number, number]> = [];
  for (const range of drops) {
    const previous = omitted.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else omitted.push(range);
  }

  // ---- pass two: emit ---------------------------------------------------
  // Swaps are recorded as the scanner encounters them, already source-ordered.
  // Negative lookahead entries denote placeholders; -1 denotes end of input.
  const nextVisible = new Int32Array(body.length + 1);
  nextVisible[body.length] = -1;
  let d = omitted.length - 1;
  let w = swaps.length - 1;
  for (let k = body.length - 1; k >= 0; k--) {
    while (d >= 0 && k < omitted[d][0]) d--;
    while (w >= 0 && k < swaps[w].from) w--;
    nextVisible[k] = d >= 0 && k < omitted[d][1]
      ? nextVisible[omitted[d][1]]
      : w >= 0 && k < swaps[w].to
        ? -2
        : body[k] === "\n" ? nextVisible[k + 1] : k;
  }
  const nextEmitted = (from: number): string => {
    const at = nextVisible[from];
    return at === -2 ? OBJECT_REPLACEMENT : at === -1 ? "" : body[at];
  };

  const sweep = new FormatSweep(formats);
  const unformatted = plainSpan(0, 0);
  let text = "";
  const map: number[] = [];
  const spans: Span[] = [];
  let previousFormat: Span | undefined;
  const emit = (character: string, at: number, format: Span): void => {
    const start = text.length;
    text += character;
    map.push(src(at));
    if (previousFormat === format) spans[spans.length - 1].end = text.length;
    else spans.push({ ...format, start, end: text.length });
    previousFormat = format;
  };

  d = 0;
  w = 0;
  for (let k = 0; k < body.length; k++) {
    // A placeholder carries its own format, independently of surrounding
    // emphasis. Its source map still points to the start of the complete atom.
    while (w < swaps.length && swaps[w].to <= k) w++;
    if (w < swaps.length && k === swaps[w].from) {
      emit(OBJECT_REPLACEMENT, k, spanFrom([swaps[w]], 0, 0));
      k = swaps[w].to - 1;
      continue;
    }
    while (d < omitted.length && omitted[d][1] <= k) d++;
    if (d < omitted.length && k >= omitted[d][0]) {
      k = omitted[d][1] - 1;
      continue;
    }

    if (tagBreaks.has(k)) {
      if (text.length) emit(LINE_SEPARATOR, k, unformatted);
      let j = k + 1;
      while (j < body.length && (body[j] === " " || body[j] === "\t")) j++;
      k = j - 1;
      continue;
    }

    if (body[k] === "\n" && hardBreaks.has(k) && text.length) {
      emit(LINE_SEPARATOR, k, unformatted);
      let j = k + 1;
      while (j < body.length && (body[j] === " " || body[j] === "\t")) j++;
      k = j - 1;
      continue;
    }

    if (body[k] === "\n") {
      let j = k + 1;
      while (j < body.length && (body[j] === " " || body[j] === "\t")) j++;
      const before = text.length ? text[text.length - 1] : "";
      const after = nextEmitted(j);
      const redundant = before === "" || before === " ";
      const wide = options.cjkSoftBreaks && (isWide(before) || isWide(after));
      if (!redundant && !wide) emit(" ", k, unformatted);
      k = j - 1;
      continue;
    }

    emit(body[k], k, sweep.at(k, unformatted));
  }
  map.push(src(body.length));
  if (!spans.length) spans.push(plainSpan(0, text.length));
  return { text, spans, map: Int32Array.from(map) };
}

/**
 * Formatting changes at source boundaries, not at every output character.
 * Counts track boolean styles; a min-heap preserves the first-created link's
 * precedence when link labels nest. There is no per-character active array.
 */
class FormatSweep {
  private events: Array<{ at: number; id: number; entering: boolean }>;
  private cursor = 0;
  private active = new Set<number>();
  private changes = new Set<number>();
  private links: number[] = [];
  private counts = {
    strong: 0, em: 0, code: 0, strike: 0, highlight: 0, sub: 0, sup: 0, underline: 0,
  };
  private format: Span | undefined;

  constructor(private formats: Format[]) {
    this.events = [];
    formats.forEach((format, id) => {
      if (format.from < format.to) {
        this.events.push({ at: format.from, id, entering: true }, { at: format.to, id, entering: false });
      }
    });
    this.events.sort((a, b) => a.at - b.at);
  }

  at(position: number, unformatted: Span): Span {
    this.changes.clear();
    while (this.cursor < this.events.length && this.events[this.cursor].at <= position) {
      const { id, entering } = this.events[this.cursor++];
      const kind = this.formats[id].kind;
      if (entering) {
        this.active.add(id);
        if (kind === "link") this.addLink(id);
      } else this.active.delete(id);
      if (kind === "strong" || kind === "em" || kind === "code" || kind === "strike" ||
        kind === "highlight" || kind === "sub" || kind === "sup" || kind === "underline") {
        this.counts[kind] += entering ? 1 : -1;
      }
      // A format wholly hidden between emitted characters does not split a
      // visible run: its enter and exit cancel before we build the next span.
      if (this.changes.has(id)) this.changes.delete(id);
      else this.changes.add(id);
    }
    if (!this.active.size) return unformatted;
    if (!this.changes.size && this.format) return this.format;
    while (this.links.length && !this.active.has(this.links[0])) this.removeLink();
    const link = this.links.length ? this.formats[this.links[0]] : undefined;
    const strong = this.counts.strong > 0;
    const em = this.counts.em > 0;
    const code = this.counts.code > 0;
    const strike = this.counts.strike > 0;
    const highlight = this.counts.highlight > 0;
    const sub = this.counts.sub > 0;
    const sup = this.counts.sup > 0;
    const underline = this.counts.underline > 0;
    return this.format = {
      ...unformatted,
      kind: link ? "link"
        : code ? "code"
        : strong ? "strong"
        : em ? "em"
        : strike ? "strike"
        : highlight ? "highlight"
        : sup ? "sup"
        : sub ? "sub"
        : "text",
      strong, em, code, strike, highlight, sub, sup, underline, href: link?.href ?? "",
    };
  }

  private addLink(id: number): void {
    let at = this.links.length;
    this.links.push(id);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (this.links[parent] < id) break;
      this.links[at] = this.links[parent];
      at = parent;
    }
    this.links[at] = id;
  }

  private removeLink(): void {
    const last = this.links.pop()!;
    if (!this.links.length) return;
    let at = 0;
    while (at * 2 + 1 < this.links.length) {
      let child = at * 2 + 1;
      if (child + 1 < this.links.length && this.links[child + 1] < this.links[child]) child++;
      if (last <= this.links[child]) break;
      this.links[at] = this.links[child];
      at = child;
    }
    this.links[at] = last;
  }
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
      highlight: false,
      sub: false,
      sup: false,
      underline: false,
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
      highlight: false,
      sub: false,
      sup: false,
      underline: false,
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
      highlight: false,
      sub: false,
      sup: false,
      underline: false,
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
              : has("highlight")
                ? "highlight"
                : has("sup")
                  ? "sup"
                  : has("sub")
                    ? "sub"
                    : "text",
    start,
    end,
    strong: has("strong"),
    em: has("em"),
    code: has("code"),
    strike: has("strike"),
    highlight: has("highlight"),
    sub: has("sub"),
    sup: has("sup"),
    underline: has("underline"),
    href: link?.href ?? "",
  };
}

/** `<br>`, in the spellings HTML accepts for it. */
const INLINE_BREAK = /^<\s*(?:br|wbr)\s*\/?>/i;

/**
 * The HTML tags that stand for something this editor already sets, and what
 * they stand for. Anything else — a `<div>`, a `<span style=…>` — is left as
 * literal source, which is what a markdown editor showing its own source
 * ought to do with markup it cannot draw.
 */
const INLINE_TAGS: Record<string, Exclude<SpanKind, "text">> = {
  u: "underline",
  ins: "underline",
  b: "strong",
  strong: "strong",
  i: "em",
  em: "em",
  cite: "em",
  mark: "highlight",
  sub: "sub",
  sup: "sup",
  code: "code",
  kbd: "code",
  samp: "code",
  del: "strike",
  s: "strike",
  strike: "strike",
};

/**
 * A pair of inline HTML tags around some content.
 *
 * Only a bare tag with no attributes opens a pair: `<u>` is markup this
 * editor can draw, while `<u class=…>` carries more meaning than an underline
 * and is better left visible. The closing tag must be the matching one, and
 * nested pairs of the same name are counted so `<b>a<b>b</b>c</b>` closes
 * where it should.
 */
function matchInlineTag(
  body: string,
  from: number,
  limit: number,
): { kind: Exclude<SpanKind, "text">; contentAt: number; close: number; end: number } | null {
  const open = /^<([A-Za-z][A-Za-z0-9]*)>/.exec(body.slice(from, limit));
  if (!open) return null;
  const name = open[1].toLowerCase();
  const kind = INLINE_TAGS[name];
  if (!kind) return null;
  const contentAt = from + open[0].length;
  const closing = `</${name}>`;
  let depth = 1;
  let at = contentAt;
  while (at < limit) {
    if (body[at] !== "<") {
      at++;
      continue;
    }
    const rest = body.slice(at, limit);
    if (rest.toLowerCase().startsWith(closing)) {
      if (--depth === 0) {
        return at > contentAt
          ? { kind, contentAt, close: at, end: at + closing.length }
          : null;
      }
      at += closing.length;
      continue;
    }
    if (new RegExp(`^<${name}>`, "i").test(rest)) depth++;
    at++;
  }
  return null;
}

/** How long the run of `c` starting at `i` is. */
function markerRun(body: string, i: number, c: string, limit: number): number {
  let n = 1;
  while (i + n < limit && body[i + n] === c) n++;
  return n;
}

/**
 * The closing half of a subscript or superscript, if there is one.
 *
 * The content may hold no whitespace, which is what keeps the rule narrow
 * enough to be safe; a space that is genuinely wanted is written `\ `, and the
 * backslash is dropped from the rendered text. Lazy, so `~a~b~` is one
 * subscript followed by a stray tilde rather than the other way round.
 */
function shortPair(
  body: string,
  open: number,
  c: string,
  limit: number,
): { close: number; escapes: number[] } | null {
  const escapes: number[] = [];
  let i = open + 1;
  while (i < limit) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === " ") {
      escapes.push(i);
      i += 2;
      continue;
    }
    if (ch === c) return i > open + 1 ? { close: i, escapes } : null;
    if (isSpace(ch) || ch === "\n") return null;
    i++;
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
 * Backtick runs and balanced brackets are structural facts shared by label
 * recognition and inline parsing. Index runs once, then memoize every nested
 * bracket encountered while matching a label, including unmatched openers.
 * This avoids rescanning the remaining paragraph for each literal `[` or run.
 */
class InlineDelimiterIndex {
  private tickEnd = new Map<number, number>();
  private tickClose = new Map<number, number>();
  private brackets = new Map<number, number>();
  private dollars: number[] = [];
  private strictDollars: number[] = [];
  private doubleDollars: number[] = [];
  private blankLines: number[] = [];
  private texInline: number[] = [];
  private texDisplay: number[] = [];
  private noteStops: number[] | undefined;

  constructor(private body: string) {
    const runs: Array<[number, number]> = [];
    let tickStart = -1;
    let slashes = 0;
    for (let i = 0; i <= body.length; i++) {
      const c = body[i];
      if (c === "`") {
        if (tickStart < 0) tickStart = i;
      } else if (tickStart >= 0) {
        runs.push([tickStart, i]);
        tickStart = -1;
      }
      if (slashes % 2 === 0) {
        if (c === "$") {
          this.dollars.push(i);
          if (!isSpace(body[i - 1]) && !/\d/.test(body[i + 1] ?? "")) this.strictDollars.push(i);
          if (body[i + 1] === "$") this.doubleDollars.push(i);
        } else if (c === "\n" && body[i + 1] === "\n") this.blankLines.push(i);
        else if (c === "\\") {
          if (body[i + 1] === ")") this.texInline.push(i);
          else if (body[i + 1] === "]") this.texDisplay.push(i);
        }
      }
      slashes = c === "\\" ? slashes + 1 : 0;
    }
    const nextRun = new Map<number, number>();
    for (let r = runs.length - 1; r >= 0; r--) {
      const [start, end] = runs[r];
      for (let at = start; at < end; at++) {
        // An escaped first tick can leave a shorter opening suffix. Closers
        // must still be whole runs, even when preceded by a backslash.
        this.tickEnd.set(at, end);
        this.tickClose.set(at, nextRun.get(end - at) ?? -1);
      }
      nextRun.set(end - start, start);
    }
  }

  /** Each query finds the next eligible delimiter without scanning its suffix. */
  private next(positions: number[], from: number): number {
    let low = 0;
    let high = positions.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (positions[mid] < from) low = mid + 1;
      else high = mid;
    }
    return positions[low] ?? -1;
  }

  texCloser(from: number, display: boolean): number {
    return this.next(display ? this.texDisplay : this.texInline, from);
  }

  /** Pandoc dollar rules, with a blank line terminating either spelling. */
  dollarMath(at: number, strict: boolean, limit: number): {
    end: number; bodyStart: number; bodyEnd: number; display: boolean;
  } | null {
    const display = this.body[at + 1] === "$";
    const length = display ? 2 : 1;
    const bodyStart = at + length;
    if (bodyStart >= limit || (!display && strict && isSpace(this.body[bodyStart]))) return null;
    const close = this.next(display ? this.doubleDollars : strict ? this.strictDollars : this.dollars, bodyStart);
    const blank = this.next(this.blankLines, bodyStart);
    if (close < 0 || close + length > limit || (blank >= 0 && blank < close)) return null;
    return { end: close + length, bodyStart, bodyEnd: close, display };
  }

  footnote(from: number, limit: number): { end: number; label: string } | null {
    // Build only when a reference is encountered. An unfinished sequence of
    // references then shares the same delimiter lookup instead of repeatedly
    // running a greedy expression over the rest of the paragraph.
    if (!this.noteStops) {
      this.noteStops = [];
      for (let i = 0; i < this.body.length; i++) {
        if (this.body[i] === "]" || isSpace(this.body[i])) this.noteStops.push(i);
      }
    }
    const close = this.next(this.noteStops, from + 2);
    return close > from + 2 && close < limit && this.body[close] === "]"
      ? { end: close + 1, label: this.body.slice(from + 2, close) }
      : null;
  }

  backticks(from: number, limit: number): { contentAt: number; close: number; end: number } {
    const contentAt = Math.min(this.tickEnd.get(from)!, limit);
    const close = this.tickClose.get(from) ?? -1;
    const end = close >= 0 ? this.tickEnd.get(close)! : contentAt;
    return close >= 0 && end <= limit
      ? { contentAt, close, end }
      : { contentAt, close: -1, end: contentAt };
  }

  bracket(from: number, limit: number): number {
    const known = this.brackets.get(from);
    if (known !== undefined) return known < limit ? known : -1;
    const open: number[] = [];
    for (let i = from; i < limit; i++) {
      if (this.body[i] === "\\" && isEscapableAsciiPunctuation(this.body[i + 1])) {
        i++;
        continue;
      }
      if (this.body[i] === "`") {
        i = this.backticks(i, limit).end - 1;
        continue;
      }
      if (this.body[i] === "[") {
        const close = this.brackets.get(i);
        if (close !== undefined) {
          if (close < 0 || close >= limit) break;
          i = close;
        } else open.push(i);
      } else if (this.body[i] === "]" && open.length) {
        const start = open.pop()!;
        this.brackets.set(start, i);
        if (!open.length) return i;
      }
    }
    for (const start of open) this.brackets.set(start, -1);
    return -1;
  }
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
