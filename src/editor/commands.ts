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
  | "selectAll";

export interface Command {
  /** Menu label. */
  label: string;
  run(editor: Editor): void;
}

export const COMMANDS: Record<CommandId, Command> = {
  undo: { label: "撤销", run: (e) => e.undo() },
  redo: { label: "重做", run: (e) => e.redo() },
  selectAll: { label: "全选", run: (e) => e.selectAll() },
};
