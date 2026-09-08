// The shortcut sheet.
//
// It is generated from the command table and the bindings, so what it can get
// wrong is not the content but the chords: how a binding is written for the
// reader, and whether every command is reachable at all.
import assert from "node:assert/strict";
import { formatChord } from "../src/ui/shortcut-sheet.js";
import { BINDINGS } from "../src/editor/keymap.js";
import { COMMANDS, type CommandId } from "../src/editor/commands.js";

assert.equal(formatChord("Mod+b", true), "⌘B", "the platform's own symbols on a Mac");
assert.equal(formatChord("Mod+b", false), "Ctrl+B", "and its own words elsewhere");
assert.equal(formatChord("Ctrl+Shift+k", true), "⌃⇧K", "a literal Ctrl stays Ctrl");
assert.equal(formatChord("Alt+Shift+5", true), "⌥⇧5");
assert.equal(formatChord("Alt+ArrowUp", true), "⌥↑", "arrows are drawn, not spelled");
assert.equal(formatChord("Mod+Shift+Enter", true), "⌘⇧↵");
assert.equal(formatChord("Ctrl+Shift+Backspace", false), "Ctrl+Shift+⌫");
assert.equal(formatChord("Mod+/", true), "⌘/");

// Every command is bound to something, or nobody can reach it.
const bound = new Set<CommandId>(BINDINGS.map((b) => b.command));
for (const id of Object.keys(COMMANDS) as CommandId[]) {
  assert.ok(bound.has(id), `${id} (${COMMANDS[id].label}) has a chord`);
}
// And every command says which part of the sheet it belongs in.
for (const [id, command] of Object.entries(COMMANDS)) {
  assert.ok(command.label && command.group, `${id} is labelled and grouped`);
}

console.log("all passing");
