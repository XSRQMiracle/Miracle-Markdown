/**
 * Source transformations behind the editing commands.
 *
 * These are pure functions over markdown text: they take the document and a
 * selection and return the edit to make. Nothing here knows about the caret,
 * the canvas or the layout, which is what lets the whole of "what does ⌘B do
 * to this document" be tested on strings.
 *
 * An `Edit` is a single splice. Commands return one because that is also what
 * the undo stack wants: one keystroke, one entry, one thing to put back.
 */

import { DEFAULT_INLINE_OPTIONS, parseInline, type InlineOptions } from "./parse.js";

export interface Range {
  start: number;
  end: number;
}

export interface Edit {
  from: number;
  to: number;
  insert: string;
  /** Where the selection should end up. Defaults to after the insertion. */
  select?: Range;
}

/** One line with its inline markup removed. */
function stripLine(line: string, options: InlineOptions): string {
  if (!line) return line;
  const rendered = parseInline(line, 0, undefined, options);
  let out = "";
  for (let i = 0; i < rendered.text.length; i++) {
    const at = rendered.map[i];
    out += rendered.text[i] === line[at] ? rendered.text[i] : line.slice(at, rendered.map[i + 1]);
  }
  return out;
}

/**
 * Wrap the selection in a pair of delimiters, or take them off again.
 *
 * Whitespace at the edges of the selection is left outside the pair.
 * CommonMark will not close emphasis against a space — `**bold **` is literal
 * text — so wrapping a selection that ends in one would quietly produce
 * something that is not emphasis at all.
 */
export function toggleInline(
  text: string,
  sel: Range,
  open: string,
  close: string = open,
): Edit {
  const trimmed = trimRange(text, sel);
  const { start, end } = trimmed;

  // Already wrapped, with the delimiters just outside the selection.
  if (wraps(text, start, end, open, close)) {
    const inner = text.slice(start, end);
    return {
      from: start - open.length,
      to: end + close.length,
      insert: inner,
      select: { start: start - open.length, end: start - open.length + inner.length },
    };
  }

  // Already wrapped, with the delimiters inside the selection.
  if (
    end - start >= open.length + close.length &&
    wraps(text, start + open.length, end - close.length, open, close)
  ) {
    const inner = text.slice(start + open.length, end - close.length);
    return { from: start, to: end, insert: inner, select: { start, end: start + inner.length } };
  }

  const inner = text.slice(start, end);
  return {
    from: start,
    to: end,
    insert: open + inner + close,
    select: { start: start + open.length, end: start + open.length + inner.length },
  };
}

/**
 * Whether `[start, end)` already sits inside this pair of delimiters.
 *
 * Counting the run matters: the `*` before the `a` in `**a**` belongs to the
 * strong marker, so italic there has to nest rather than eat half of it. The
 * one exception is a run of three, which is the two emphasis markers written
 * together — toggling either takes back its own share and leaves the other.
 */
function wraps(text: string, start: number, end: number, open: string, close: string): boolean {
  const c = open[0];
  const uniform = open === c.repeat(open.length) && close === c.repeat(close.length);
  if (!uniform) {
    return text.slice(start - open.length, start) === open && text.slice(end, end + close.length) === close;
  }
  let before = 0;
  while (before < start && text[start - 1 - before] === c) before++;
  let after = 0;
  while (end + after < text.length && text[end + after] === c) after++;
  if (before === open.length && after === close.length) return true;
  const emphasis = c === "*" || c === "_";
  return emphasis && open.length <= 2 && before === 3 && after === 3;
}

// -- lines ----------------------------------------------------------------

/** Indentation and any blockquote markers: the part of a line that says where
 *  it sits rather than what it is. */
const LEAD = /^(\s*(?:>\s?)*)/;
/** An ATX heading marker. */
const ATX = /^(#{1,6})[ \t]+/;
/** A list marker, bullet or number, with any task box after it. */
const MARKER = /^(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;

export interface Line {
  start: number;
  end: number;
  text: string;
}

/** Every source line the selection touches, including a collapsed caret's. */
export function linesIn(text: string, sel: Range): Line[] {
  const from = text.lastIndexOf("\n", Math.max(0, sel.start - 1)) + 1;
  let last = Math.max(sel.start, sel.end);
  // A selection that stops exactly at the start of a line has not reached
  // into it: selecting "a\n" is one line, not two.
  if (sel.start !== sel.end && last > from && text[last - 1] === "\n") last--;
  let to = text.indexOf("\n", last);
  if (to < 0) to = text.length;
  const lines: Line[] = [];
  let at = from;
  while (at <= to) {
    let stop = text.indexOf("\n", at);
    if (stop < 0 || stop > to) stop = to;
    lines.push({ start: at, end: stop, text: text.slice(at, stop) });
    at = stop + 1;
  }
  return lines;
}

/**
 * Rewrite every line the selection touches.
 *
 * A collapsed caret keeps its distance from the end of its line, which is
 * what makes a prefix change — adding a `#`, indenting — leave the caret
 * sitting in the same place in the words rather than sliding through them.
 */
export function mapLines(
  text: string,
  sel: Range,
  rewrite: (line: string, index: number) => string,
): Edit | null {
  const lines = linesIn(text, sel);
  const rewritten = lines.map((l, i) => rewrite(l.text, i));
  if (rewritten.every((out, i) => out === lines[i].text)) return null;

  const from = lines[0].start;
  const to = lines[lines.length - 1].end;
  const insert = rewritten.join("\n");

  let select: Range;
  if (sel.start === sel.end) {
    const i = lines.findIndex((l) => sel.start >= l.start && sel.start <= l.end);
    const line = lines[Math.max(0, i)];
    const out = rewritten[Math.max(0, i)];
    const before = rewritten.slice(0, Math.max(0, i)).reduce((n, t) => n + t.length + 1, 0);
    const fromEnd = Math.max(0, line.end - sel.start);
    const at = from + before + Math.max(0, out.length - fromEnd);
    select = { start: at, end: at };
  } else {
    select = { start: from, end: from + insert.length };
  }
  return { from, to, insert, select };
}

/** The heading level of a line, 0 for anything that is not a heading. */
export function headingLevel(line: string): number {
  const lead = LEAD.exec(line)![1];
  return ATX.exec(line.slice(lead.length))?.[1].length ?? 0;
}

/**
 * Make the lines headings of `level`, or paragraphs again at level 0.
 *
 * Asking for the level a line already has takes the heading off instead —
 * Typora's toggle — so the same key both applies and removes it.
 */
export function setHeading(text: string, sel: Range, level: number, toggle = true): Edit | null {
  const first = linesIn(text, sel)[0];
  const target = toggle && level > 0 && headingLevel(first.text) === level ? 0 : level;
  return mapLines(text, sel, (line) => {
    const lead = LEAD.exec(line)![1];
    let body = line.slice(lead.length);
    const atx = ATX.exec(body);
    // A heading is not a list item, so its marker goes with the change.
    body = atx ? body.slice(atx[0].length) : body.replace(MARKER, "");
    if (!body && !target) return lead + body;
    return lead + (target ? "#".repeat(target) + " " : "") + body;
  });
}

/**
 * Promote or demote the heading under the caret.
 *
 * Typora's arithmetic: a paragraph counts as one past H6, so promoting one
 * makes it an H6 and demoting an H6 makes it a paragraph again. Promoting an
 * H1 or demoting a paragraph has nowhere to go.
 */
export function stepHeading(text: string, sel: Range, direction: 1 | -1): Edit | null {
  const level = headingLevel(linesIn(text, sel)[0].text);
  const next = direction > 0
    ? (level === 0 ? 6 : level === 1 ? 1 : level - 1)
    : (level === 0 ? 0 : level === 6 ? 0 : level + 1);
  if (next === level) return null;
  return setHeading(text, sel, next, false);
}

/** A line that opens a fenced block: a code fence, or a display formula. */
const FENCE_OPEN = /^\s*(?:```+|~~~+|\$\$|\\\[)/;
/** A line that closes one. */
const FENCE_CLOSE = /^\s*(?:```+|~~~+|\$\$|\\\])\s*$/;

/**
 * Put the lines the selection touches inside a fenced block.
 *
 * With nothing to enclose the fence is still written, with the caret on the
 * empty line between the halves — which is where the author was going to type
 * anyway.
 */
export function wrapFenced(text: string, sel: Range, open: string, close: string): Edit {
  const lines = linesIn(text, sel);
  const from = lines[0].start;
  const to = lines[lines.length - 1].end;
  const inner = text.slice(from, to);
  const insert = `${open}\n${inner}\n${close}`;
  const at = from + open.length + 1;
  return {
    from,
    to,
    insert,
    select: inner ? { start: at, end: at + inner.length } : { start: at, end: at },
  };
}

/** Take the fence off a block, leaving what was inside it. */
export function unwrapFenced(text: string, block: Range): Edit | null {
  const lines = text.slice(block.start, block.end).split("\n");
  // A one-line formula carries both delimiters: `$$ x $$`.
  if (lines.length === 1) {
    const bare = lines[0].replace(/^\s*(?:\$\$|\\\[)\s?/, "").replace(/\s?(?:\$\$|\\\])\s*$/, "");
    if (bare === lines[0]) return null;
    return {
      from: block.start,
      to: block.end,
      insert: bare,
      select: { start: block.start, end: block.start + bare.length },
    };
  }
  const first = FENCE_OPEN.test(lines[0]) ? 1 : 0;
  const last = lines.length > first && FENCE_CLOSE.test(lines[lines.length - 1])
    ? lines.length - 1
    : lines.length;
  if (first === 0 && last === lines.length) return null;
  const insert = lines.slice(first, last).join("\n");
  return {
    from: block.start,
    to: block.end,
    insert,
    select: { start: block.start, end: block.start + insert.length },
  };
}

export type ListKind = "bullet" | "ordered" | "task";

const TASK_ITEM = /^(?:[-*+])[ \t]+\[[ xX]\][ \t]+/;
const BULLET_ITEM = /^(?:[-*+])[ \t]+/;
const ORDERED_ITEM = /^\d+[.)][ \t]+/;

/** Which kind of list item a line is, if it is one at all. */
function listKind(body: string): ListKind | null {
  if (TASK_ITEM.test(body)) return "task";
  if (BULLET_ITEM.test(body)) return "bullet";
  if (ORDERED_ITEM.test(body)) return "ordered";
  return null;
}

/**
 * Make the lines the selection touches list items, or plain lines again.
 *
 * Asking for the kind they already are removes the markers; asking for a
 * different kind restyles them in place, so a bulleted list becomes a
 * numbered one without going through a paragraph on the way.
 */
export function toggleList(text: string, sel: Range, kind: ListKind): Edit | null {
  const lines = linesIn(text, sel);
  const body = (line: string) => line.slice(LEAD.exec(line)![1].length);
  const content = lines.filter((l) => l.text.trim());
  const already = content.length > 0 && content.every((l) => listKind(body(l.text)) === kind);

  let n = 0;
  return mapLines(text, sel, (line) => {
    if (!line.trim()) return line;
    const lead = LEAD.exec(line)![1];
    const rest = line.slice(lead.length).replace(MARKER, "");
    if (already) return lead + rest;
    n++;
    const marker = kind === "ordered" ? `${n}. ` : kind === "task" ? "- [ ] " : "- ";
    return lead + marker + rest;
  });
}

/**
 * Move the lines the selection touches past the line above or below.
 *
 * Line-wise rather than block-wise: in a document that *is* its source, the
 * line is the thing the author can see moving, and inside a table it is the
 * row — which is what Typora binds these keys to.
 */
export function moveLines(text: string, sel: Range, direction: 1 | -1): Edit | null {
  const lines = linesIn(text, sel);
  const first = lines[0];
  const last = lines[lines.length - 1];
  const body = text.slice(first.start, last.end);

  if (direction < 0) {
    if (first.start === 0) return null;
    const above = text.lastIndexOf("\n", first.start - 2) + 1;
    const moved = text.slice(above, first.start - 1);
    const delta = -(moved.length + 1);
    return {
      from: above,
      to: last.end,
      insert: `${body}\n${moved}`,
      select: { start: sel.start + delta, end: sel.end + delta },
    };
  }

  if (last.end >= text.length) return null;
  let below = text.indexOf("\n", last.end + 1);
  if (below < 0) below = text.length;
  const moved = text.slice(last.end + 1, below);
  const delta = moved.length + 1;
  return {
    from: first.start,
    to: below,
    insert: `${moved}\n${body}`,
    select: { start: sel.start + delta, end: sel.end + delta },
  };
}

/** One level of list nesting, matching what the parser counts. */
export const INDENT = "  ";
/** Blockquote markers only — unlike LEAD this leaves the indentation, which
 *  is the very thing an indent command has to move. */
const QUOTED = /^((?:[ \t]*>[ \t]?)*)/;

/**
 * Indent or outdent the lines the selection touches.
 *
 * Indenting refuses on the first item of a list, as Typora does: an item with
 * nothing above it to nest under would only be an item with too much space in
 * front of it. Returning nothing there is what lets Tab fall through to
 * inserting a plain indent instead.
 *
 * Outdenting takes a level of list indent if there is one, and otherwise a
 * level of blockquote — the two ways a line can be nested.
 */
export function indentLines(text: string, sel: Range, direction: 1 | -1): Edit | null {
  const lines = linesIn(text, sel);
  if (direction > 0) {
    const first = lines[0];
    const lead = LEAD.exec(first.text)![1];
    if (listKind(first.text.slice(lead.length)) && !hasItemAbove(text, first.start)) return null;
    return mapLines(text, sel, (line) => {
      if (!line.trim()) return line;
      const at = QUOTED.exec(line)![1].length;
      return line.slice(0, at) + INDENT + line.slice(at);
    });
  }
  return mapLines(text, sel, (line) => {
    const at = QUOTED.exec(line)![1].length;
    const outdented = line.slice(0, at) + line.slice(at).replace(/^(?: {1,2}|\t)/, "");
    if (outdented !== line) return outdented;
    return line.replace(/^(\s*)>[ \t]?/, "$1");
  });
}

/** Whether the line above is a list item this one could nest under. */
function hasItemAbove(text: string, lineStart: number): boolean {
  let at = lineStart;
  while (at > 0) {
    const stop = at - 1;
    const from = text.lastIndexOf("\n", stop - 1) + 1;
    const line = text.slice(from, stop);
    if (line.trim()) return listKind(line.slice(LEAD.exec(line)![1].length)) !== null;
    at = from;
  }
  return false;
}

/**
 * Quote the lines the selection touches, or unquote them.
 *
 * Blank lines inside the range are given a bare `>` rather than being left
 * alone: an unmarked blank line ends a blockquote, so quoting a run of
 * paragraphs without it would produce several quotes instead of one.
 */
export function toggleQuote(text: string, sel: Range): Edit | null {
  const lines = linesIn(text, sel);
  const marked = (line: string) => /^\s*>/.test(line);
  const quoted = lines.some((l) => marked(l.text)) &&
    lines.every((l) => !l.text.trim() || marked(l.text));
  return mapLines(text, sel, (line) => {
    if (quoted) return line.replace(/^(\s*)>[ \t]?/, "$1");
    return line.trim() ? "> " + line : ">";
  });
}

/** Something that can only have been meant as a URL. */
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|www\.)\S+$/i;

/**
 * Make the selection a link, or take the link off it.
 *
 * A selection that is itself a URL becomes the destination and the caret goes
 * to the empty label; anything else becomes the label and the caret goes to
 * the empty destination. Either way the next thing typed is the part that is
 * still missing.
 */
export function toggleLink(text: string, sel: Range): Edit {
  const inside = linkAround(text, sel);
  if (inside) {
    const label = text.slice(inside.label.start, inside.label.end);
    return {
      from: inside.start,
      to: inside.end,
      insert: label,
      select: { start: inside.start, end: inside.start + label.length },
    };
  }

  const { start, end } = trimRange(text, sel);
  const inner = text.slice(start, end);
  if (URL_LIKE.test(inner)) {
    return { from: start, to: end, insert: `[](${inner})`, select: { start: start + 1, end: start + 1 } };
  }
  return {
    from: start,
    to: end,
    insert: `[${inner}]()`,
    select: { start: start + inner.length + 3, end: start + inner.length + 3 },
  };
}

/** The inline link the selection sits inside, label and all. */
function linkAround(text: string, sel: Range): { start: number; end: number; label: Range } | null {
  // Walk back to the `[` that could open a label containing the selection,
  // stopping at a line break: a link's label does not span one here.
  for (let open = sel.start; open >= 0; open--) {
    const c = text[open];
    if (c === "\n") break;
    if (c !== "[" || text[open - 1] === "!" || text[open - 1] === "\\") continue;
    const close = text.indexOf("]", open);
    if (close < 0 || text[close + 1] !== "(") break;
    const shut = text.indexOf(")", close);
    if (shut < 0 || text.slice(close, shut).includes("\n")) break;
    if (sel.start >= open && sel.end <= shut + 1) {
      return { start: open, end: shut + 1, label: { start: open + 1, end: close } };
    }
    break;
  }
  return null;
}

/** The selection with any whitespace at its edges given back. */
function trimRange(text: string, sel: Range): Range {
  let { start, end } = sel;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return start < end ? { start, end } : sel;
}

/**
 * Strip inline markup from the selection.
 *
 * Rather than hunting for delimiters with patterns of its own, this asks the
 * inline parser what it would drop: the rendered text of the selection *is*
 * the selection with its markup removed. The one thing that cannot be taken
 * from the rendered text is an object — a formula, an image, a footnote
 * reference all render as U+FFFC — so wherever a rendered character is not the
 * source character it came from, the source is put back instead.
 *
 * Formulas therefore survive with their delimiters, which is right: `$x$` is
 * content, not styling.
 */
export function clearFormat(
  text: string,
  sel: Range,
  options: InlineOptions = DEFAULT_INLINE_OPTIONS,
): Edit | null {
  const source = text.slice(sel.start, sel.end);
  if (!source) return null;
  // Line by line: the inline parser is given one block's body at a time, and
  // a newline handed to it is a *soft* break that the CJK rule may discard —
  // which would silently weld two paragraphs together.
  const out = source.split("\n").map((line) => stripLine(line, options)).join("\n");
  if (out === source) return null;
  return {
    from: sel.start,
    to: sel.end,
    insert: out,
    select: { start: sel.start, end: sel.start + out.length },
  };
}
