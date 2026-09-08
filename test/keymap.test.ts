// Chords and the commands they run.
//
// The awkward case is Alt on macOS: ⌥5 arrives as key "[" and ⌥I as a dead
// key, so a chord that uses Alt has to be matched on the physical code. Every
// lookup therefore tries both spellings, and these tests pin that down.
import assert from "node:assert/strict";
import { BINDINGS, commandFor } from "../src/editor/keymap.js";
import { COMMANDS } from "../src/editor/commands.js";

const press = (props: Record<string, unknown>) =>
  ({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...props }) as KeyboardEvent;

const on = (bindings: Array<{ chord: string; command: string }>) => bindings as never;

// Mod is the platform's own menu modifier.
const mod = on([{ chord: "Mod+z", command: "undo" }]);
assert.equal(commandFor(press({ key: "z", metaKey: true }), mod, true), "undo", "⌘Z on a Mac");
assert.equal(commandFor(press({ key: "z", ctrlKey: true }), mod, true), null, "but not ⌃Z");
assert.equal(commandFor(press({ key: "z", ctrlKey: true }), mod, false), "undo", "Ctrl+Z elsewhere");
assert.equal(commandFor(press({ key: "z", metaKey: true }), mod, false), null);

// A literal Ctrl stays Ctrl on both platforms — Typora's headings are ⌃1..⌃6.
const literal = on([{ chord: "Ctrl+1", command: "heading1" }]);
assert.equal(commandFor(press({ key: "1", ctrlKey: true }), literal, true), "heading1");
assert.equal(commandFor(press({ key: "1", ctrlKey: true }), literal, false), "heading1");

// Modifiers must match exactly, so a chord is not stolen by a superset.
const exact = on([{ chord: "Mod+z", command: "undo" }, { chord: "Mod+Shift+z", command: "redo" }]);
assert.equal(commandFor(press({ key: "z", metaKey: true, shiftKey: true }), exact, true), "redo");
assert.equal(commandFor(press({ key: "Z", metaKey: true, shiftKey: true }), exact, true), "redo",
  "a shifted letter arrives uppercased");

// Alt: the character the key produces is not the character on the key.
const alt = on([{ chord: "Alt+Shift+5", command: "strike" }]);
assert.equal(commandFor(press({ key: "5", code: "Digit5", altKey: true, shiftKey: true }), alt, false), "strike");
assert.equal(commandFor(press({ key: "fi", code: "Digit5", altKey: true, shiftKey: true }), alt, true), "strike",
  "⌥⇧5 on a Mac produces a ligature, and is matched on the physical key");

const brackets = on([{ chord: "Mod+]", command: "indent" }, { chord: "Ctrl+Shift+[", command: "orderedList" }]);
assert.equal(commandFor(press({ key: "]", code: "BracketRight", metaKey: true }), brackets, true), "indent");
assert.equal(commandFor(press({ key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true }), brackets, false),
  "orderedList", "a shifted bracket is matched on the physical key");

// Named keys pass through untouched.
const named = on([{ chord: "Alt+ArrowUp", command: "moveUp" }]);
assert.equal(commandFor(press({ key: "ArrowUp", code: "ArrowUp", altKey: true }), named, true), "moveUp");
assert.equal(commandFor(press({ key: "ArrowUp", code: "ArrowUp" }), named, true), null, "bare arrows are not commands");

// Every shipped binding names a command that exists.
for (const b of BINDINGS) {
  assert.ok(b.command in COMMANDS, `${b.chord} is bound to a real command (${b.command})`);
}

console.log("all passing");
