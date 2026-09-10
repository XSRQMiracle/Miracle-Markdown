// The shortcut sheet.
//
// It is generated from the command table and the bindings, so what it can get
// wrong is not the content but the chords: how a binding is written for the
// reader, and whether every command is reachable at all.
import assert from "node:assert/strict";
import { formatChord, TYPING } from "../src/ui/shortcut-sheet.js";
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

// No chord means two things at once. The window's own keys live in the sheet's
// TYPING table and the editor's in BINDINGS, and nothing arbitrates between
// them at runtime — the editor sees the key first and the window handler
// yields, so a chord in both is a command the reader can no longer reach.
// Checked on both platforms, since `Mod` is Ctrl on one of them and a literal
// `Ctrl+…` binding would collide there and nowhere else.
for (const apple of [true, false]) {
  const editor = new Map<string, CommandId>();
  for (const b of BINDINGS) {
    const chord = formatChord(b.chord, apple);
    const already = editor.get(chord);
    assert.ok(
      already === undefined || already === b.command,
      `${chord} runs both ${already} and ${b.command}`,
    );
    editor.set(chord, b.command);
  }
  const seen = new Set<string>();
  for (const row of TYPING) {
    const chord = formatChord(row.chord, apple);
    assert.ok(
      !editor.has(chord),
      `${chord} (${row.label}) is also the editor's ${editor.get(chord)}`,
    );
    assert.ok(!seen.has(chord), `${chord} is listed twice in the sheet`);
    seen.add(chord);
  }
}

console.log("all passing");
