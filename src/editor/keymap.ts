/**
 * Chords, and the commands they run.
 *
 * Keeping the bindings in a table rather than in a switch is what lets one
 * command be reached from a key, a toolbar button and a test without being
 * written three times — and it makes the whole keyboard surface readable in
 * one place, which matters once there are dozens of them.
 *
 * The bindings follow Typora, because that is the editor most of this
 * program's readers already have their fingers trained on. Where Typora binds
 * a literal Ctrl on macOS (its headings are ⌃1…⌃6, not ⌘1…⌘6) that is kept,
 * and a ⌘ alias is added alongside for the Mac convention.
 *
 * A chord is written the way the platform writes it: "Cmd+B", "Ctrl+Shift+K",
 * "Alt+ArrowUp". `Cmd` means the Apple command key and nothing on Windows;
 * `Mod` means whichever of the two the platform uses for its menu shortcuts.
 */

import type { CommandId } from "./commands.js";

export interface Binding {
  chord: string;
  command: CommandId;
}

/**
 * Key names as `KeyboardEvent.key` reports them, lowercased for letters.
 *
 * Alt is the awkward one: on macOS ⌥5 arrives as `key: "["` and ⌥I as a dead
 * key, so a chord that uses Alt has to be matched on `code` instead — which is
 * why every lookup tries both spellings.
 */
function chordFor(e: KeyboardEvent, useCode: boolean): string {
  const parts: string[] = [];
  if (e.metaKey) parts.push("Cmd");
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  let key: string;
  if (useCode) {
    // "KeyB" -> "b", "Digit5" -> "5", "BracketLeft" -> "[", everything else
    // (ArrowUp, Enter, Tab) is already the name we want.
    const code = e.code;
    key = /^Key./.test(code) ? code.slice(3).toLowerCase()
      : /^Digit.$/.test(code) ? code.slice(5)
      : code === "BracketLeft" ? "["
      : code === "BracketRight" ? "]"
      : code === "Backquote" ? "`"
      : code === "Backslash" ? "\\"
      : code === "Minus" ? "-"
      : code === "Equal" ? "="
      : code === "Slash" ? "/"
      : code === "Period" ? "."
      : code === "Comma" ? ","
      : code === "Quote" ? "'"
      : code === "Semicolon" ? ";"
      : code;
  } else {
    key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  }
  parts.push(key);
  return parts.join("+");
}

/** Expand `Mod` to this platform's menu modifier, and normalise the order. */
function normalize(chord: string, apple: boolean): string {
  const pieces = chord.split("+");
  const key = pieces.pop()!;
  const mods = new Set(pieces.map((m) => (m === "Mod" ? (apple ? "Cmd" : "Ctrl") : m)));
  const order = ["Cmd", "Ctrl", "Alt", "Shift"].filter((m) => mods.has(m));
  return [...order, key.length === 1 ? key.toLowerCase() : key].join("+");
}

/** Look up the command a keystroke runs, or null. */
export function commandFor(
  e: KeyboardEvent,
  bindings: readonly Binding[],
  apple: boolean,
): CommandId | null {
  const table = compiled(bindings, apple);
  return table.get(chordFor(e, false)) ?? table.get(chordFor(e, true)) ?? null;
}

let cache: { bindings: readonly Binding[]; apple: boolean; table: Map<string, CommandId> } | null = null;

function compiled(bindings: readonly Binding[], apple: boolean): Map<string, CommandId> {
  if (cache && cache.bindings === bindings && cache.apple === apple) return cache.table;
  const table = new Map<string, CommandId>();
  // First binding wins, so an alias listed after the real chord cannot
  // shadow it.
  for (const b of bindings) {
    const chord = normalize(b.chord, apple);
    if (!table.has(chord)) table.set(chord, b.command);
  }
  cache = { bindings, apple, table };
  return table;
}

/** The default bindings, in Typora's arrangement. */
export const BINDINGS: readonly Binding[] = [
  { chord: "Mod+z", command: "undo" },
  { chord: "Mod+Shift+z", command: "redo" },
  { chord: "Mod+y", command: "redo" },
  { chord: "Mod+a", command: "selectAll" },

  // Format. ⌥⇧5 for strikethrough is Typora's binding, borrowed in turn from
  // Google Docs.
  { chord: "Mod+b", command: "strong" },
  { chord: "Mod+i", command: "emphasis" },
  { chord: "Mod+Shift+`", command: "inlineCode" },
  { chord: "Alt+Shift+5", command: "strike" },
  { chord: "Mod+\\", command: "clearFormat" },
  // Typora binds a literal Ctrl+K on both platforms; ⌘K is the Mac
  // convention, and nothing else here wants it.
  { chord: "Ctrl+k", command: "hyperlink" },
  { chord: "Mod+k", command: "hyperlink" },

  // Paragraph. Typora binds a literal Ctrl+1…6 on both platforms; ⌘1…6 is
  // what a Mac reader will reach for, so both are here.
  { chord: "Ctrl+1", command: "heading1" },
  { chord: "Ctrl+2", command: "heading2" },
  { chord: "Ctrl+3", command: "heading3" },
  { chord: "Ctrl+4", command: "heading4" },
  { chord: "Ctrl+5", command: "heading5" },
  { chord: "Ctrl+6", command: "heading6" },
  { chord: "Ctrl+0", command: "paragraph" },
  { chord: "Cmd+1", command: "heading1" },
  { chord: "Cmd+2", command: "heading2" },
  { chord: "Cmd+3", command: "heading3" },
  { chord: "Cmd+4", command: "heading4" },
  { chord: "Cmd+5", command: "heading5" },
  { chord: "Cmd+6", command: "heading6" },
  { chord: "Cmd+0", command: "paragraph" },
  { chord: "Ctrl+=", command: "increaseHeading" },
  { chord: "Ctrl+-", command: "decreaseHeading" },
  { chord: "Ctrl+Shift+q", command: "quote" },
  { chord: "Ctrl+Shift+]", command: "unorderedList" },
  { chord: "Ctrl+Shift+[", command: "orderedList" },
  // Typora leaves the task list unbound; ⌘⇧X is what the editors that do bind
  // it have settled on.
  { chord: "Mod+Shift+x", command: "taskList" },
];
