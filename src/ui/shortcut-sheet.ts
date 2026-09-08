/**
 * The shortcut sheet.
 *
 * Typora's keyboard is discoverable because it has a menu bar to read it off.
 * This editor has a toolbar of typographic switches instead, so the keys need
 * somewhere to be seen — and rather than a hand-written list that would drift
 * out of date on the first rename, the sheet is generated from the command
 * table and the bindings themselves. A chord with no command, or a command
 * with no chord, cannot appear here without appearing in the editor too.
 */

import { COMMANDS, type CommandGroup, type CommandId } from "../editor/commands.js";
import { BINDINGS } from "../editor/keymap.js";

/** Keys that are not commands — they are handled where the typing is. */
const TYPING: Array<{ group: CommandGroup; chord: string; label: string }> = [
  { group: "编辑", chord: "Enter", label: "换行；在列表中续下一项" },
  { group: "编辑", chord: "Shift+Enter", label: "段内强制换行" },
  { group: "编辑", chord: "Tab", label: "缩进；在表格中移到下一格" },
  { group: "编辑", chord: "Shift+Tab", label: "减少缩进；上一格" },
  { group: "编辑", chord: "Mod+c", label: "复制（未选中时复制整行）" },
  { group: "编辑", chord: "Mod+x", label: "剪切（未选中时剪切整行）" },
  { group: "移动", chord: "Alt+ArrowLeft", label: "按词移动（配 →）" },
  { group: "移动", chord: "Mod+ArrowLeft", label: "行首 / 行尾（配 →）" },
  { group: "移动", chord: "Mod+ArrowUp", label: "文首 / 文末（配 ↓）" },
  { group: "移动", chord: "Home", label: "行首 / 行尾（配 End）" },
  { group: "移动", chord: "Mod+Click", label: "打开链接" },
  { group: "视图", chord: "Mod+f", label: "查找" },
  { group: "视图", chord: "Mod+g", label: "查找下一个（⇧ 为上一个）" },
  { group: "视图", chord: "Mod+Alt+f", label: "查找并替换" },
  { group: "视图", chord: "F1", label: "本表" },
  { group: "文件", chord: "Mod+o", label: "打开" },
  { group: "文件", chord: "Mod+s", label: "保存（⇧ 为另存为）" },
];

const ORDER: CommandGroup[] = ["格式", "段落", "选择", "移动", "编辑", "表格", "视图", "文件"];

const MAC_SYMBOL: Record<string, string> = { Cmd: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
const KEY_SYMBOL: Record<string, string> = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Enter: "↵", Backspace: "⌫", Tab: "⇥", Click: "点击", Home: "Home",
};

/** A chord as this platform writes it. */
export function formatChord(chord: string, apple: boolean): string {
  const parts = chord.split("+");
  const key = parts.pop()!;
  const mods = parts.map((m) => (m === "Mod" ? (apple ? "Cmd" : "Ctrl") : m));
  const name = KEY_SYMBOL[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  if (apple) return mods.map((m) => MAC_SYMBOL[m] ?? m).join("") + name;
  return [...mods, name].join("+");
}

export function buildShortcutSheet(root: HTMLElement, apple: boolean): {
  toggle(): void;
  close(): void;
  readonly isOpen: boolean;
} {
  const rows = new Map<CommandGroup, Array<[string, string]>>();
  const add = (group: CommandGroup, chord: string, label: string) => {
    const list = rows.get(group) ?? [];
    list.push([formatChord(chord, apple), label]);
    rows.set(group, list);
  };

  // One row per command, taking the first chord bound to it; a command bound
  // twice (⌃1 and ⌘1 for a heading) reads better as one line.
  const seen = new Set<CommandId>();
  for (const binding of BINDINGS) {
    if (seen.has(binding.command)) continue;
    seen.add(binding.command);
    const command = COMMANDS[binding.command];
    add(command.group, binding.chord, command.label);
  }
  for (const row of TYPING) add(row.group, row.chord, row.label);

  root.innerHTML = "";
  const title = document.createElement("h3");
  title.textContent = "快捷键";
  root.appendChild(title);
  const columns = document.createElement("div");
  columns.className = "sheet-columns";
  for (const group of ORDER) {
    const list = rows.get(group);
    if (!list) continue;
    const section = document.createElement("section");
    const heading = document.createElement("h4");
    heading.textContent = group;
    section.appendChild(heading);
    for (const [chord, label] of list) {
      const row = document.createElement("div");
      row.className = "sheet-row";
      const key = document.createElement("kbd");
      key.textContent = chord;
      const text = document.createElement("span");
      text.textContent = label;
      row.append(key, text);
      section.appendChild(row);
    }
    columns.appendChild(section);
  }
  root.appendChild(columns);

  const sheet = {
    get isOpen() {
      return !root.hidden;
    },
    toggle() {
      root.hidden = !root.hidden;
    },
    close() {
      root.hidden = true;
    },
  };
  root.addEventListener("mousedown", (e) => e.stopPropagation());
  return sheet;
}
