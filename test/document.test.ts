import {
  decodeDocumentText,
  detectLineEnding,
  encodeDocumentText,
  normalizeLineEndings,
} from "../src/markdown/document.js";
import { parseBlocks, renderBlock } from "../src/markdown/parse.js";

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

eq(normalizeLineEndings("a\r\nb\rc\n"), "a\nb\nc\n", "all external endings become LF");
eq(detectLineEnding("a\r\nb\r\n"), "\r\n", "detects CRLF");
eq(detectLineEnding("a\rb\r"), "\r", "detects CR-only files");
eq(detectLineEnding("a\nb\n"), "\n", "detects LF");
eq(detectLineEnding("a\r\nb\nc\r\n"), "\r\n", "uses the predominant convention");
eq(detectLineEnding("no breaks"), "\n", "new documents default to LF");

{
  const source = "# Heading\r\n\r\n- item\r\n";
  const decoded = decodeDocumentText(source);
  const blocks = parseBlocks(decoded.text);
  eq(decoded.lineEnding, "\r\n", "decode remembers the disk convention");
  eq(blocks.map((b) => b.type), ["heading", "blank", "list"], "canonical text parses normally");
  eq(blocks.map((b) => renderBlock(b, false).text), ["Heading", "", "item"], "no carriage returns reach rendering");
  eq(encodeDocumentText(decoded.text, decoded.lineEnding), source, "saving restores CRLF");
}

// A byte order mark.
//
// A UTF-8 file has no byte order to mark, but Windows editors write one as a
// note that the file is UTF-8 at all, and it reaches the decoder as an ordinary
// U+FEFF in front of everything. Every block rule anchors at the start of a
// line, so until it is taken off, the first line of the document is not the
// first line of the document.
{
  const decoded = decodeDocumentText("﻿# BOM heading\n");
  eq(decoded.bom, true, "the mark is noticed");
  eq(decoded.text, "# BOM heading\n", "and taken off, so the line starts where it looks like it starts");
  eq(parseBlocks(decoded.text).map((b) => b.type), ["heading"], "a marked heading is a heading");
  eq(encodeDocumentText(decoded.text, decoded.lineEnding, decoded.bom), "﻿# BOM heading\n",
    "and saving puts the author's mark back rather than quietly dropping it");
}
{
  const source = "﻿---\na: 1\n---\n\nbody\n";
  const decoded = decodeDocumentText(source);
  eq(parseBlocks(decoded.text).map((b) => b.type), ["frontmatter", "blank", "paragraph"],
    "marked frontmatter is frontmatter, not a rule and a setext heading");
  eq(encodeDocumentText(decoded.text, decoded.lineEnding, decoded.bom), source, "and round trips");
}
{
  const decoded = decodeDocumentText("﻿# h\r\nx\r\n");
  eq(decoded.lineEnding, "\r\n", "a mark does not hide the line ending behind it");
  eq(encodeDocumentText(decoded.text, decoded.lineEnding, decoded.bom), "﻿# h\r\nx\r\n",
    "and both conventions are restored together");
}
{
  // U+FEFF is also a zero width no-break space, so a second one is the
  // author's character and has nothing to do with the file's encoding.
  const decoded = decodeDocumentText("﻿a﻿b\n");
  eq(decoded.text, "a﻿b\n", "only a leading mark is taken off");
  eq(decodeDocumentText("mid﻿text").text, "mid﻿text", "and one inside a line is left alone");
  eq(decodeDocumentText("mid﻿text").bom, false, "and is not mistaken for a mark");
}
{
  eq(decodeDocumentText("").bom, false, "an empty file carries no mark");
  eq(decodeDocumentText("").text, "", "and stays empty");
  const only = decodeDocumentText("﻿");
  eq([only.bom, only.text], [true, ""], "a file that is only a mark decodes to nothing");
  eq(encodeDocumentText("", "\n", false), "", "and an unmarked empty document writes nothing");
}
{
  const plain = decodeDocumentText("# plain\n");
  eq(plain.bom, false, "a file without a mark says so");
  eq(encodeDocumentText(plain.text, plain.lineEnding, plain.bom), "# plain\n",
    "and does not grow one by being opened and saved");
}

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
