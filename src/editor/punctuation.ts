/**
 * Typographic punctuation, applied as it is typed.
 *
 * A keyboard has one vertical mark for two different quotes and one hyphen
 * for three different dashes, and the difference between them is exactly the
 * kind of thing this editor exists to get right. So `"` becomes a real
 * quotation mark that knows which end of the phrase it is on, `--` becomes an
 * en dash, `---` an em dash, and `...` the single ellipsis character.
 *
 * The substitutions happen at the keystroke rather than at render time, so
 * what the author saves is the character they meant. They are also plain
 * edits, which means one press of undo puts the typed character back.
 */

export interface Substitution {
  /** Where the replacement starts; the caret is its end. */
  from: number;
  insert: string;
}

/** After these, a quotation mark is opening rather than closing. */
const BEFORE_OPENING = /[\s(\[{<“‘„‚—–　-〿！-･]/;

/**
 * What a typed character should really become, or null to leave it alone.
 *
 * `at` is the caret, and everything before it is what the decision is made
 * from — which is all a rule of this kind can see while someone is typing.
 */
export function smartPunctuation(text: string, at: number, ch: string): Substitution | null {
  const before = at > 0 ? text[at - 1] : "";

  if (ch === '"' || ch === "'") {
    const opening = !before || BEFORE_OPENING.test(before);
    const pair = ch === '"' ? ["“", "”"] : ["‘", "’"];
    return { from: at, insert: opening ? pair[0] : pair[1] };
  }

  if (ch === "-" && (before === "-" || before === "–")) {
    // A line of nothing but dashes is a rule, or the fence of a YAML block.
    // Those have to stay as they were written.
    if (onlyDashes(text, at)) return null;
    return { from: at - 1, insert: before === "-" ? "–" : "—" };
  }

  if (ch === "." && text.slice(at - 2, at) === "..") {
    return { from: at - 2, insert: "…" };
  }

  return null;
}

/** Whether the line up to `at` holds nothing but dashes and space. */
function onlyDashes(text: string, at: number): boolean {
  const from = text.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  return /^[\s-]*$/.test(text.slice(from, at));
}

/** The pair a quotation mark wraps a selection in. */
export function smartPair(ch: string): [string, string] | null {
  if (ch === '"') return ["“", "”"];
  if (ch === "'") return ["‘", "’"];
  return null;
}
