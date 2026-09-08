// Typographic punctuation, applied as it is typed.
//
// A keyboard has one vertical mark for two quotes and one hyphen for three
// dashes. These rules decide which was meant from what is already on the line,
// which is all they can see while someone is typing.
import assert from "node:assert/strict";
import { smartPunctuation } from "../src/editor/punctuation.js";

const type = (before: string, ch: string) => {
  const found = smartPunctuation(before, before.length, ch);
  return found ? before.slice(0, found.from) + found.insert : before + ch;
};

// --- quotes ---------------------------------------------------------------
assert.equal(type("", '"'), "“", "a quote at the start opens");
assert.equal(type("said ", '"'), "said “", "and after a space");
assert.equal(type("“hello", '"'), "“hello”", "one after a word closes");
assert.equal(type("(", '"'), "(“", "a bracket is an opening too");
assert.equal(type("——", '"'), "——“", "and so is a dash");
assert.equal(type("他说：", '"'), "他说：“", "Chinese punctuation opens the quote");
assert.equal(type("中文", '"'), "中文”", "but a Han character closes it");
assert.equal(type("", "'"), "‘", "single quotes follow the same rule");
assert.equal(type("don", "'"), "don’", "which is what makes an apostrophe come out right");
assert.equal(type("‘a", "'"), "‘a’");

// --- dashes ---------------------------------------------------------------
assert.equal(type("a-", "-"), "a–", "two hyphens are an en dash");
assert.equal(type("a–", "-"), "a—", "three are an em dash");
assert.equal(type("a", "-"), "a-", "one is a hyphen");
assert.equal(type("2010-2020 ", "-"), "2010-2020 -", "a lone hyphen after a space stays one");
// A line of dashes is a rule or the fence of a YAML block, and has to survive.
assert.equal(type("-", "-"), "--", "at the start of a line the dashes stay literal");
assert.equal(type("--", "-"), "---", "all the way to a horizontal rule");
assert.equal(type("  -", "-"), "  --", "indented too");

// --- ellipsis -------------------------------------------------------------
assert.equal(type("wait..", "."), "wait…", "three dots are one character");
assert.equal(type("wait.", "."), "wait..", "two are not");
assert.equal(type("", "."), ".", "and one certainly is not");

// Anything else is typed as it is.
assert.equal(smartPunctuation("abc", 3, "x"), null);
assert.equal(smartPunctuation("abc", 3, "!"), null);

console.log("all passing");
