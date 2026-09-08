/**
 * Finding text in the document source.
 *
 * The document being searched is markdown source rather than what the page
 * shows, which is the honest thing for an editor whose model *is* the source:
 * `**bold**` is findable, and every match has a source range the caret can be
 * put on. It also means a match may cover characters that are never drawn —
 * the asterisks themselves — which the highlighting has to tolerate.
 */

export interface SearchQuery {
  text: string;
  caseSensitive: boolean;
  /** Read the query as a regular expression rather than as literal text. */
  regex: boolean;
}

export interface Match {
  start: number;
  end: number;
  /** The matched text, for `$&` in a replacement. */
  text: string;
  /** Captured groups, for `$1` in a replacement. */
  groups: Array<string | undefined>;
}

const SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * The query as a regular expression, or null when there is nothing to search
 * for and `undefined` when the author's own pattern will not compile — a
 * half-typed one usually will not, so that is a state to show, not an error.
 */
export function compileSearch(query: SearchQuery): RegExp | null | undefined {
  if (!query.text) return null;
  const source = query.regex ? query.text : query.text.replace(SPECIAL, "\\$&");
  // No `u` flag: it would reject escapes that are harmless here and turn a
  // pattern that works in most editors into an error in this one.
  try {
    return new RegExp(source, query.caseSensitive ? "g" : "gi");
  } catch {
    return undefined;
  }
}

/** Every match, in document order. */
export function findMatches(text: string, query: SearchQuery): Match[] {
  const re = compileSearch(query);
  if (!re) return [];
  const found: Match[] = [];
  for (const m of text.matchAll(re)) {
    // A pattern that can match nothing ("x*") would otherwise report a match
    // at every position, which is noise rather than a result.
    if (!m[0]) continue;
    found.push({ start: m.index, end: m.index + m[0].length, text: m[0], groups: m.slice(1) });
    if (found.length >= 10000) break;
  }
  return found;
}

/**
 * A replacement with its group references filled in.
 *
 * `$1`-`$99`, `$&` and `$$` are honoured, as in String.replace; anything else
 * beginning with `$` is left alone, since in literal mode a `$` is far more
 * likely to be a dollar sign or the start of a formula than a reference.
 */
export function expandReplacement(template: string, match: Match): string {
  return template.replace(/\$(\$|&|\d{1,2})/g, (whole, ref: string) => {
    if (ref === "$") return "$";
    if (ref === "&") return match.text;
    const n = Number.parseInt(ref, 10);
    if (n < 1 || n > match.groups.length) return whole;
    return match.groups[n - 1] ?? "";
  });
}
