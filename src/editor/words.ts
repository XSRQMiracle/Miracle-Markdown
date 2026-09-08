/**
 * Word boundaries.
 *
 * A double-click, and a word-wise caret move, both need to know where a word
 * ends — and in a document that mixes scripts that is not a question a regular
 * expression can answer. Chinese and Japanese are written without spaces, so
 * the boundaries inside 中文排版 are a matter of the language rather than of
 * the characters: no pattern over code points can find them.
 *
 * `Intl.Segmenter` is the browser's own segmenter, the same one a native text
 * field uses, and it does know. Where it is missing the fallback groups runs
 * of one character class, which is right for Latin and merely harmless for
 * Han — selecting a whole run rather than a word.
 */

export interface WordRange {
  start: number;
  end: number;
}

type Segmenter = {
  segment(input: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }>;
};

let segmenter: Segmenter | null | undefined;

function wordSegmenter(): Segmenter | null {
  if (segmenter !== undefined) return segmenter;
  const ctor = (Intl as unknown as { Segmenter?: new (locale?: string, options?: object) => Segmenter })
    .Segmenter;
  segmenter = ctor ? new ctor(undefined, { granularity: "word" }) : null;
  return segmenter;
}

/** Character classes coarse enough to group a run, for the fallback path. */
type Kind = "space" | "word" | "han" | "other";

const HAN = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;

function kindOf(c: string): Kind {
  if (/\s/.test(c)) return "space";
  if (HAN.test(c)) return "han";
  // Underscores and digits belong to the identifiers a writer double-clicks.
  if (/[\p{L}\p{N}_]/u.test(c)) return "word";
  return "other";
}

/**
 * The word containing `offset`, or the run of like characters around it.
 *
 * A click on the boundary between two words takes the one to the left, which
 * is what a native text field does: the caret sitting after a word is still
 * understood to be in it.
 */
export function wordAt(text: string, offset: number): WordRange {
  if (!text.length) return { start: 0, end: 0 };
  const at = Math.max(0, Math.min(text.length, offset));

  const segments = wordSegmenter();
  if (segments) {
    let fallback: WordRange | null = null;
    for (const piece of segments.segment(text)) {
      const start = piece.index;
      const end = start + piece.segment.length;
      if (end <= at) {
        // Remember the last word that ended exactly here, for a caret sitting
        // on a boundary.
        if (end === at && piece.isWordLike) fallback = { start, end };
        continue;
      }
      if (start > at) break;
      if (piece.isWordLike) return { start, end };
      // Whitespace or punctuation under the caret: prefer the word just
      // before it, and otherwise select the run itself.
      return fallback ?? { start, end };
    }
    if (fallback) return fallback;
  }

  return runAt(text, at);
}

/** The run of one character class around `offset`. */
function runAt(text: string, at: number): WordRange {
  const index = at < text.length ? at : at - 1;
  const kind = kindOf(text[index]);
  let start = index;
  let end = index + 1;
  while (start > 0 && kindOf(text[start - 1]) === kind) start--;
  while (end < text.length && kindOf(text[end]) === kind) end++;
  return { start, end };
}

/**
 * The offset one word away, in the direction given.
 *
 * Modelled on a native field rather than on `wordAt`: moving left lands on the
 * start of the word behind the caret, moving right on the end of the word
 * ahead, so repeated presses walk the text without ever standing still.
 */
export function wordBoundary(text: string, offset: number, direction: -1 | 1): number {
  const at = Math.max(0, Math.min(text.length, offset));
  if (direction < 0 ? at === 0 : at === text.length) return at;

  const segments = wordSegmenter();
  if (segments) {
    const stops: number[] = [];
    for (const piece of segments.segment(text)) {
      if (piece.isWordLike) {
        stops.push(direction < 0 ? piece.index : piece.index + piece.segment.length);
      }
    }
    const found = direction < 0
      ? [...stops].reverse().find((s) => s < at)
      : stops.find((s) => s > at);
    if (found !== undefined) return found;
    return direction < 0 ? 0 : text.length;
  }

  // Fallback: skip the whitespace between words, then the run itself.
  let i = at;
  const step = direction;
  const peek = () => (direction < 0 ? text[i - 1] : text[i]);
  while (i > 0 && i < text.length && kindOf(peek()) === "space") i += step;
  const kind: Kind = i > 0 && i < text.length ? kindOf(peek()) : "space";
  while (i > 0 && i < text.length && kindOf(peek()) === kind) i += step;
  return i;
}
