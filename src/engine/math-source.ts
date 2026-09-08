/**
 * Document-owned TeX metadata. This is a token scanner, not a TeX expander:
 * command boundaries, comments, escaped characters and balanced arguments
 * matter even for the small set of directives the document consumes.
 * The editor always retains the original source; only the rendering copy is
 * rewritten. Bodies interpreted as text or macro definitions are opaque.
 */
export interface MathDirective {
  name: "tag" | "label" | "ref" | "eqref" | "notag" | "nonumber" | "begin";
  start: number;
  end: number;
  value: string;
  starred: boolean;
}

interface Argument { start: number; end: number; value: string }

function whitespace(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    if (/\s/.test(source[i])) i++;
    else if (source[i] === "%") {
      const newline = source.indexOf("\n", i);
      i = newline < 0 ? source.length : newline + 1;
    } else break;
  }
  return i;
}

function commandEnd(source: string, start: number): number {
  let i = start + 1;
  if (/[a-zA-Z]/.test(source[i] ?? "")) {
    while (i < source.length && /[a-zA-Z]/.test(source[i])) i++;
  } else if (i < source.length) i++;
  return i;
}

function argument(source: string, start: number, open = "{", close = "}"): Argument | null {
  const i = whitespace(source, start);
  if (source[i] !== open) return null;
  let depth = 1;
  let end = i + 1;
  while (end < source.length) {
    const ch = source[end];
    if (ch === "\\") end = commandEnd(source, end);
    else if (ch === "%") end = whitespace(source, end);
    else {
      end++;
      if (ch === open) depth++;
      if (ch === close && --depth === 0) return { start: i, end, value: source.slice(i + 1, end - 1) };
    }
  }
  return null;
}

// Commands whose next argument is text, a name, a URL, or stored TeX rather
// than immediately evaluated mathematics. A \tag inside one is not a tag on
// the enclosing equation. Subsequent math arguments still get scanned.
const OPAQUE = new Set([
  "text", "textrm", "textnormal", "textsf", "texttt", "textup", "textit", "textsl", "textsc", "textbf", "textmd",
  "mbox", "hbox", "operatorname", "url", "href", "class", "cssId", "style", "color", "textcolor", "definecolor",
]);
const DEFINITIONS = new Set(["newcommand", "renewcommand", "providecommand", "newenvironment", "renewenvironment"]);

/** Return only executable metadata commands, in source order. */
export function mathDirectives(source: string, storedReferences = false): MathDirective[] {
  const result: MathDirective[] = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] === "%") { i = whitespace(source, i); continue; }
    if (source[i] !== "\\") { i++; continue; }
    const start = i;
    const end = commandEnd(source, i);
    const name = source.slice(i + 1, end);
    i = end;
    if (!storedReferences && DEFINITIONS.has(name)) {
      i = whitespace(source, i);
      if (source[i] === "*") i = whitespace(source, i + 1);
      const macro = argument(source, i);
      i = macro?.end ?? (source[i] === "\\" ? commandEnd(source, i) : i);
      for (let n = 0; n < 2; n++) i = argument(source, i, "[", "]")?.end ?? i;
      i = argument(source, i)?.end ?? source.length;
      if (name.endsWith("environment")) i = argument(source, i)?.end ?? source.length;
      continue;
    }
    if (!storedReferences && ["def", "gdef", "edef", "xdef"].includes(name)) {
      // Parameter tokens precede the replacement body; neither is executed.
      while (i < source.length && source[i] !== "{") {
        i = source[i] === "\\" ? commandEnd(source, i) : source[i] === "%" ? whitespace(source, i) : i + 1;
      }
      i = argument(source, i)?.end ?? source.length;
      continue;
    }
    if (name === "verb") {
      if (source[i] === "*") i++;
      const delimiter = source[i++];
      const close = source.indexOf(delimiter, i);
      i = close < 0 ? source.length : close + 1;
      continue;
    }
    if (!storedReferences && OPAQUE.has(name)) {
      const next = whitespace(source, i);
      i = argument(source, source[next] === "*" ? next + 1 : next)?.end ?? i;
      continue;
    }
    if (name === "notag" || name === "nonumber") {
      result.push({ name, start, end, value: "", starred: false });
      continue;
    }
    if (!["tag", "label", "ref", "eqref", "begin"].includes(name)) continue;
    let next = whitespace(source, i);
    const starred = name === "tag" && source[next] === "*";
    if (starred) next = whitespace(source, next + 1);
    const value = argument(source, next);
    if (!value) continue; // Leave incomplete/invalid syntax to MathJax's error path.
    // Tags are opaque for numbering, but their text may itself cite another
    // equation. The reference rewrite descends into those arguments too.
    i = storedReferences && name === "tag" ? end : value.end;
    result.push({ name: name as MathDirective["name"], start, end: i, value: value.value, starred });
  }
  return result;
}

/** Render source with document labels removed and references resolved. */
export function resolveMathSource(source: string, labels: Map<string, string>): string {
  // Labels inside stored macro bodies are not declarations until TeX invokes
  // them. References in those bodies still need document context, just like
  // references in text/tag arguments; rewriting them retains the existing
  // document-reference contract without claiming ownership of tag syntax.
  const directives = [
    ...mathDirectives(source).filter((directive) => directive.name === "label"),
    ...mathDirectives(source, true).filter((directive) => directive.name === "ref" || directive.name === "eqref"),
  ].sort((a, b) => a.start - b.start);
  let out = "";
  let position = 0;
  for (const directive of directives) {
    if (directive.start < position) continue;
    out += source.slice(position, directive.start);
    if (directive.name === "ref" || directive.name === "eqref") {
      const value = labels.get(directive.value.trim()) ?? "?";
      out += directive.name === "eqref" ? `(${value})` : value;
    }
    position = directive.end;
  }
  return out + source.slice(position);
}
