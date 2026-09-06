/** Soft-wrap source without dropping whitespace or changing physical lines. */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });

export function sourceLineEnds(
  text: string,
  width: number,
  measure: (text: string) => number,
): number[] {
  if (!text || measure(text) <= width) return [text.length];

  const boundaries = [0, ...Array.from(graphemes.segment(text), (s) => s.index + s.segment.length)];
  const wordEnds = new Set(Array.from(words.segment(text), (s) => s.index + s.segment.length));
  const last = boundaries.length - 1;
  const ends: number[] = [];
  for (let start = 0; start < last;) {
    const fits = (end: number) => measure(text.slice(boundaries[start], boundaries[end])) <= width;
    // Probe only nearby prefixes, so very long physical lines do not require
    // repeatedly shaping half of the remaining document for each visual line.
    let lo = start;
    let hi = start + 1;
    while (fits(hi)) {
      lo = hi;
      if (hi === last) break;
      hi = Math.min(last, start + (hi - start) * 2);
    }
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    // A single grapheme can be wider than the measure; keep it intact and
    // guarantee progress instead of splitting a surrogate/combining sequence.
    let end = Math.max(start + 1, lo);
    if (end < last) {
      for (let candidate = end; candidate > start; candidate--) {
        if (wordEnds.has(boundaries[candidate])) {
          end = candidate;
          break;
        }
      }
    }
    ends.push(boundaries[end]);
    start = end;
  }
  return ends;
}
