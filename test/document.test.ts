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

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
