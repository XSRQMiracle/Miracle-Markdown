/** The line-ending convention used when a document is written back to disk. */
export type LineEnding = "\n" | "\r\n" | "\r";

export interface DecodedDocument {
  /** Canonical editor text. Internally every line break is a single LF. */
  text: string;
  /** The predominant convention in the source, retained for saving. */
  lineEnding: LineEnding;
  /** Whether the file began with a byte order mark, retained for saving. */
  bom: boolean;
}

/**
 * The byte order mark, as it arrives once the bytes have been decoded.
 *
 * A UTF-8 file has no byte order to mark, but Windows editors write one anyway
 * as a note that the file is UTF-8 at all, and a decoder hands it on as an
 * ordinary U+FEFF at the head of the string. Every block rule in the parser
 * anchors at the start of a line, so one invisible character in front of a `#`
 * is the difference between a heading and a paragraph.
 */
const BOM = "﻿";

/**
 * Convert external text to the editor's canonical representation.
 *
 * Keeping this invariant at the document boundary is simpler and safer than
 * teaching every parser, mapper and editing operation about three different
 * newline widths. In particular, all document offsets remain UTF-16 offsets
 * into the exact string the editor owns.
 */
export function normalizeLineEndings(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/** Detect the predominant line ending, using the first one to break ties. */
export function detectLineEnding(text: string): LineEnding {
  const counts = new Map<LineEnding, number>([
    ["\n", 0],
    ["\r\n", 0],
    ["\r", 0],
  ]);
  let first: LineEnding | null = null;

  for (let i = 0; i < text.length; i++) {
    let ending: LineEnding | null = null;
    if (text[i] === "\r") {
      if (text[i + 1] === "\n") {
        ending = "\r\n";
        i++;
      } else {
        ending = "\r";
      }
    } else if (text[i] === "\n") {
      ending = "\n";
    }
    if (ending) {
      first ??= ending;
      counts.set(ending, counts.get(ending)! + 1);
    }
  }

  if (!first) return "\n";
  let best = first;
  for (const ending of ["\n", "\r\n", "\r"] as const) {
    if (counts.get(ending)! > counts.get(best)!) best = ending;
  }
  return best;
}

/**
 * Decode text at an I/O boundary while remembering how to write it back.
 *
 * Only a leading mark is taken off, and it is taken off here rather than in
 * the parser: U+FEFF is also a legal zero width no-break space, so a copy of
 * it further into the prose is the author's character and has to survive. One
 * boundary owning the question is what keeps the desktop and the browser from
 * disagreeing about what the first line of a file says.
 */
export function decodeDocumentText(source: string): DecodedDocument {
  const bom = source.startsWith(BOM);
  const body = bom ? source.slice(BOM.length) : source;
  return {
    text: normalizeLineEndings(body),
    lineEnding: detectLineEnding(body),
    bom,
  };
}

/**
 * Encode canonical editor text using the document's original convention.
 *
 * The mark goes back on for the same reason the line endings do: opening a
 * file and saving it again should not quietly rewrite bytes the author did not
 * ask about, and on Windows that mark is how some tools recognise the file as
 * UTF-8 at all.
 */
export function encodeDocumentText(
  text: string,
  lineEnding: LineEnding,
  bom = false,
): string {
  const canonical = normalizeLineEndings(text);
  const body = lineEnding === "\n" ? canonical : canonical.replace(/\n/g, lineEnding);
  return bom ? BOM + body : body;
}
