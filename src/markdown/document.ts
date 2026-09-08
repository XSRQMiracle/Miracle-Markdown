/** The line-ending convention used when a document is written back to disk. */
export type LineEnding = "\n" | "\r\n" | "\r";

export interface DecodedDocument {
  /** Canonical editor text. Internally every line break is a single LF. */
  text: string;
  /** The predominant convention in the source, retained for saving. */
  lineEnding: LineEnding;
}

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

/** Decode text at an I/O boundary while remembering how to write it back. */
export function decodeDocumentText(source: string): DecodedDocument {
  return {
    text: normalizeLineEndings(source),
    lineEnding: detectLineEnding(source),
  };
}

/** Encode canonical editor text using the document's original convention. */
export function encodeDocumentText(text: string, lineEnding: LineEnding): string {
  const canonical = normalizeLineEndings(text);
  return lineEnding === "\n" ? canonical : canonical.replace(/\n/g, lineEnding);
}
