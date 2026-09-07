// Equation numbering and cross-references.
//
// The awkward part is that a reference may point forward — a paragraph early
// in a document can cite an equation that appears much later — so numbering
// has to be settled before anything is typeset. These tests pin down what
// each equation is numbered and what each citation resolves to.
import { parseBlocks } from "../src/markdown/parse.js";
import { equationTag, numberEquations, resolveLatex } from "../src/engine/typeset.js";

let failures = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.log(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

type Mode = "none" | "ams" | "all";
const tag = (latex: string, mode: Mode, n = 1) => equationTag(latex, n, mode);

// --- what gets a number ---------------------------------------------------
eq(tag("x = 1", "none"), null, "none numbers nothing");
eq(tag("x = 1", "all"), "1", "all numbers a bare formula");
eq(tag("x = 1", "ams"), null, "ams leaves a bare formula unnumbered");
eq(tag("\\begin{equation} x \\end{equation}", "ams"), "1", "ams numbers an equation environment");
eq(tag("\\begin{align} x \\end{align}", "ams"), "1", "ams numbers align");
eq(tag("\\begin{align*} x \\end{align*}", "ams"), null, "ams leaves the starred form alone");
eq(tag("\\begin{gather*} x \\end{gather*}", "ams"), null, "and gather* too");

// An explicit tag always wins, and \notag always suppresses.
eq(tag("x \\tag{A.1}", "none"), "A.1", "an explicit tag beats the none setting");
eq(tag("x \\tag{*}", "ams"), "*", "and beats ams");
eq(tag("\\begin{equation} x \\notag \\end{equation}", "ams"), null, "notag suppresses");
eq(tag("x \\nonumber", "all"), null, "nonumber suppresses under all");

// A label is a request for something to cite, so it forces a number even
// when numbering is otherwise off. That is what makes "none" a usable
// default: no numbers until an equation asks for one.
eq(tag("x = 1 \\label{eq:a}", "none"), "1", "a label forces a number under none");
eq(tag("x = 1 \\label{eq:a}", "ams"), "1", "and under ams");
eq(tag("x \\label{eq:a} \\notag", "none"), null, "but notag still wins over a label");

// --- numbering across a document ------------------------------------------
{
  const doc = [
    "para",
    "",
    "$$ a = 1 \\label{eq:first} $$",
    "",
    "para",
    "",
    "$$ b = 2 $$",
    "",
    "$$ c = 3 \\label{eq:third} $$",
  ].join("\n");
  const blocks = parseBlocks(doc);
  const under = (mode: Mode) => numberEquations(blocks, mode);

  eq(
    [...under("none").labels],
    [["eq:first", "1"], ["eq:third", "2"]],
    "under none only the labelled equations are numbered, and consecutively",
  );
  eq(
    [...under("all").labels],
    [["eq:first", "1"], ["eq:third", "3"]],
    "under all the unlabelled one takes a number too, so the third is 3",
  );
}

// --- resolving citations --------------------------------------------------
{
  const labels = new Map([
    ["eq:cost", "2"],
    ["eq:main", "7"],
  ]);
  eq(resolveLatex("\\ref{eq:cost}", labels), "2", "ref gives the bare number");
  eq(resolveLatex("\\eqref{eq:cost}", labels), "(2)", "eqref parenthesises it");
  eq(resolveLatex("\\ref{ eq:main }", labels), "7", "surrounding space in the key is ignored");
  eq(
    resolveLatex("see \\eqref{eq:cost} and \\eqref{eq:main}", labels),
    "see (2) and (7)",
    "several citations in one formula",
  );
  eq(resolveLatex("\\ref{nope}", labels), "?", "an unresolved ref shows a question mark");
  eq(resolveLatex("\\eqref{nope}", labels), "(?)", "and an unresolved eqref keeps its parentheses");
  eq(resolveLatex("x = 1 \\label{eq:a}", labels), "x = 1 ", "the label itself is removed");
  eq(
    resolveLatex("a \\label{one} + b \\label{two}", labels),
    "a  + b ",
    "every label is removed",
  );
  eq(resolveLatex("x + y", labels), "x + y", "a formula with neither is untouched");
  eq(
    resolveLatex("\\reflectbox{x}", labels),
    "\\reflectbox{x}",
    "a command that merely starts with ref is not a citation",
  );
}

// --- forward references ---------------------------------------------------
{
  const doc = [
    "如式 $\\eqref{eq:later}$ 所示。",
    "",
    "$$ E = mc^2 \\label{eq:later} $$",
  ].join("\n");
  const blocks = parseBlocks(doc);
  const numbering = numberEquations(blocks, "none");
  eq(numbering.labels.get("eq:later"), "1", "an equation later in the document is numbered");
  eq(
    resolveLatex("\\eqref{eq:later}", numbering.labels),
    "(1)",
    "and a citation before it resolves",
  );
}

// --- the cache version --------------------------------------------------
{
  const before = numberEquations(parseBlocks("$$ a \\label{x} $$"), "none");
  const after = numberEquations(
    parseBlocks("$$ b \\label{y} $$\n\n$$ a \\label{x} $$"),
    "none",
  );
  const same = numberEquations(parseBlocks("$$ a \\label{x} $$"), "none");
  eq(before.version === same.version, true, "the same document gives the same version");
  eq(
    before.version !== after.version,
    true,
    "inserting an equation ahead of a label changes the version, so citations re-typeset",
  );
}

// Balanced tag bodies and executable command boundaries are preserved.
eq(tag(String.raw`x\tag{A{.1}}`, "all"), "A{.1}", "nested tag arguments are not truncated");
eq(tag("x % \\tag{ignored}", "none"), null, "commented tags do not assign numbers");
eq(tag(String.raw`\newcommand{\unused}{\tag{ignored}}x`, "all"), "1", "unused macro definitions do not assign tags");
eq(resolveLatex(String.raw`x\tag{A{.1}}\label{a}`, new Map()), String.raw`x\tag{A{.1}}`, "only document label metadata is removed");
eq(resolveLatex(String.raw`\newcommand{\cite}{\eqref{a}}\cite`, new Map([["a", "7"]])),
  String.raw`\newcommand{\cite}{(7)}\cite`, "stored macro references retain document context");
eq(resolveLatex(String.raw`x\tag{see \ref{a}}`, new Map([["a", "7"]])), String.raw`x\tag{see 7}`, "tag text may cite another equation");

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
