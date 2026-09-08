/**
 * The editor's commands.
 *
 * One table, so that a key, a menu item and a test all reach the same code.
 * Each entry carries the label the command would show in a menu — Typora's
 * Chinese labels, since that is the vocabulary this editor's readers already
 * have — and a function that runs it against the editor.
 *
 * Commands are deliberately thin: the ones that rewrite markdown delegate to
 * the pure transformations in `markdown/edit.ts`, which know nothing about the
 * editor and can be tested on strings alone.
 */

import type { Editor } from "./editor.js";

export type CommandId =
  | "undo"
  | "redo"
  | "selectAll"
  | "strong"
  | "emphasis"
  | "inlineCode"
  | "strike"
  | "clearFormat"
  | "hyperlink";

export interface Command {
  /** Menu label. */
  label: string;
  run(editor: Editor): void;
}

export const COMMANDS: Record<CommandId, Command> = {
  undo: { label: "撤销", run: (e) => e.undo() },
  redo: { label: "重做", run: (e) => e.redo() },
  selectAll: { label: "全选", run: (e) => e.selectAll() },

  // Emphasis is written with asterisks rather than underscores: GFM ignores
  // an underscore inside a word, so `snake_case` would break `_emphasis_`.
  strong: { label: "加粗", run: (e) => e.toggleInline("**") },
  emphasis: { label: "斜体", run: (e) => e.toggleInline("*") },
  inlineCode: { label: "代码", run: (e) => e.toggleInline("`") },
  strike: { label: "删除线", run: (e) => e.toggleInline("~~") },
  clearFormat: { label: "清除样式", run: (e) => e.clearFormat() },
  hyperlink: { label: "超链接", run: (e) => e.toggleLink() },
};
