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
