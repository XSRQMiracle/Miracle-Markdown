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
  | "hyperlink"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading4"
  | "heading5"
  | "heading6"
  | "paragraph"
  | "increaseHeading"
  | "decreaseHeading"
  | "quote"
  | "unorderedList"
  | "orderedList"
  | "taskList"
  | "codeFence"
  | "mathBlock"
  | "indent"
  | "outdent"
  | "moveLineUp"
  | "moveLineDown"
  | "selectWord"
  | "selectLine"
  | "selectBlock"
  | "selectStyledScope"
  | "deleteWord"
  | "deleteLine"
  | "insertParagraphBefore"
  | "insertParagraphAfter"
  | "insertTable"
  | "toggleTask"
  | "sourceMode";

/** The heading a command sits under in the shortcut sheet. */
export type CommandGroup = "编辑" | "选择" | "移动" | "段落" | "格式" | "表格" | "视图" | "文件";

export interface Command {
  /** Menu label. */
  label: string;
  group: CommandGroup;
  run(editor: Editor): void;
}

export const COMMANDS: Record<CommandId, Command> = {
  undo: { label: "撤销", group: "编辑", run: (e) => e.undo() },
  redo: { label: "重做", group: "编辑", run: (e) => e.redo() },
  selectAll: { label: "全选", group: "选择", run: (e) => e.selectAll() },

  // Emphasis is written with asterisks rather than underscores: GFM ignores
  // an underscore inside a word, so `snake_case` would break `_emphasis_`.
  strong: { label: "加粗", group: "格式", run: (e) => e.toggleInline("**") },
  emphasis: { label: "斜体", group: "格式", run: (e) => e.toggleInline("*") },
  inlineCode: { label: "代码", group: "格式", run: (e) => e.toggleInline("`") },
  strike: { label: "删除线", group: "格式", run: (e) => e.toggleInline("~~") },
  clearFormat: { label: "清除样式", group: "格式", run: (e) => e.clearFormat() },
  hyperlink: { label: "超链接", group: "格式", run: (e) => e.toggleLink() },

  // Headings apply to the lines the selection touches. A markdown heading is
  // one line, so a paragraph written over several source lines becomes a
  // heading plus the paragraph that follows it — which is what the source
  // then says, rather than a silent reflow of the author's line breaks.
  heading1: { label: "一级标题", group: "段落", run: (e) => e.setHeading(1) },
  heading2: { label: "二级标题", group: "段落", run: (e) => e.setHeading(2) },
  heading3: { label: "三级标题", group: "段落", run: (e) => e.setHeading(3) },
  heading4: { label: "四级标题", group: "段落", run: (e) => e.setHeading(4) },
  heading5: { label: "五级标题", group: "段落", run: (e) => e.setHeading(5) },
  heading6: { label: "六级标题", group: "段落", run: (e) => e.setHeading(6) },
  paragraph: { label: "段落", group: "段落", run: (e) => e.setHeading(0) },
  increaseHeading: { label: "提升标题级别", group: "段落", run: (e) => e.stepHeading(1) },
  decreaseHeading: { label: "降低标题级别", group: "段落", run: (e) => e.stepHeading(-1) },
  quote: { label: "引用", group: "段落", run: (e) => e.toggleQuote() },
  unorderedList: { label: "无序列表", group: "段落", run: (e) => e.toggleList("bullet") },
  orderedList: { label: "有序列表", group: "段落", run: (e) => e.toggleList("ordered") },
  taskList: { label: "任务列表", group: "段落", run: (e) => e.toggleList("task") },
  toggleTask: { label: "切换任务状态", group: "段落", run: (e) => e.toggleTask() },
  sourceMode: { label: "源代码模式", group: "视图", run: (e) => e.toggleSourceMode() },
  codeFence: { label: "代码块", group: "段落", run: (e) => e.toggleFenced("code") },
  mathBlock: { label: "公式块", group: "段落", run: (e) => e.toggleFenced("math") },
  indent: { label: "增加缩进", group: "段落", run: (e) => e.indent(1) },
  outdent: { label: "减少缩进", group: "段落", run: (e) => e.indent(-1) },
  moveLineUp: { label: "上移该行", group: "编辑", run: (e) => e.moveLines(-1) },
  moveLineDown: { label: "下移该行", group: "编辑", run: (e) => e.moveLines(1) },

  selectWord: { label: "选中当前词", group: "选择", run: (e) => e.selectWord() },
  selectLine: { label: "选中当前行", group: "选择", run: (e) => e.selectLine() },
  selectBlock: { label: "选择段落或块", group: "选择", run: (e) => e.selectBlock() },
  selectStyledScope: { label: "选中当前格式文本", group: "选择", run: (e) => e.selectStyledScope() },

  deleteWord: { label: "删除当前词", group: "编辑", run: (e) => e.deleteWord() },
  deleteLine: { label: "删除当前行", group: "编辑", run: (e) => e.deleteLine() },

  insertTable: { label: "插入表格", group: "表格", run: (e) => e.insertTable() },
  insertParagraphBefore: { label: "在上方插入段落", group: "编辑", run: (e) => e.insertParagraph(true) },
  // In a table this adds a row, which is what Typora binds ⌘↵ to there.
  insertParagraphAfter: { label: "在下方插入段落 / 下方插入行", group: "编辑", run: (e) => e.insertParagraph(false) },
};
