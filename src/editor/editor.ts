/**
 * The editor.
 *
 * Because the engine owns the layout, the things that are painful in a
 * DOM editor become easy here: hit testing is a search through positions we
 * computed ourselves, and the caret is wherever we say it is. What the DOM
 * would have given us for free, and now has to be built, is text input — so a
 * hidden textarea rides along at the caret and does nothing but collect
 * keystrokes and IME composition.
 *
 * Editing model: the document is markdown source, and the block holding the
 * caret shows that source verbatim while every other block is typeset. That
 * avoids the unanswerable question of where a caret sits "inside" a pair of
 * asterisks, and keeps the caret's mapping to the source an identity exactly
 * where it needs to be.
 */

import {
  checkboxRect,
  Renderer,
  type Scrollbar,
  type SelectionRect,
  type Viewport,
} from "../render/canvas.js";
import {
  listItemMarker,
  OBJECT_REPLACEMENT,
  renderBlock,
  sourceRangeOwnsPosition,
  type Block,
  type BlockType,
} from "../markdown/parse.js";
import { normalizeLineEndings } from "../markdown/document.js";
import { wordAt, wordBoundary } from "./words.js";
import { smartPair, smartPunctuation } from "./punctuation.js";
import { compileSearch, expandReplacement, findMatches, type Match, type SearchQuery } from "./search.js";
import { BINDINGS, commandFor } from "./keymap.js";
import { COMMANDS, type CommandId } from "./commands.js";
import {
  clearFormat,
  DEFAULT_WRITING_STYLE,
  indentLines,
  completeTable,
  insertParagraph,
  insertTable,
  insertTableRow,
  linesIn,
  moveLines,
  setHeading,
  stepHeading,
  toggleInline,
  toggleList,
  toggleQuote,
  toggleTask,
  unwrapFenced,
  wrapFenced,
  type ListKind,
  type WritingStyle,
  toggleLink,
  type Edit,
} from "../markdown/edit.js";
import {
  DEFAULT_OPTIONS,
  DEFAULT_THEME,
  Typesetter,
  type LaidBlock,
  type LaidLine,
  type LaidRun,
  type Theme,
  type TypesetOptions,
} from "../engine/typeset.js";

/** Smallest margin the page will shrink to before the column starts giving
 *  way instead. */
const MIN_GUTTER = 48;
/** Below this the column stops shrinking and the window simply clips. */
const MIN_MEASURE = 240;
/** Space above the first block. */
const PAGE_TOP = 56;
/** Width of the strip along the right edge that the scrollbar answers to. */
const SCROLLBAR_WIDTH = 14;
/** A thumb shorter than this is hard to catch, however long the document. */
const MIN_THUMB = 32;

/**
 * Delimiters that close themselves when one is typed.
 *
 * Kept to the brackets and the backtick. The emphasis characters are absent
 * on purpose: `*` opens a bullet far more often than a pair, and `_` falls
 * inside identifiers — auto-closing either would fight the writer. They can
 * still wrap a selection, where the intent is unambiguous.
 */
const AUTO_CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}", "`": "`" };
const CLOSERS = new Set(Object.values(AUTO_CLOSE));
/** What a typed character wraps a selection in. */
const WRAPPERS: Record<string, string> = {
  ...AUTO_CLOSE, '"': '"', "'": "'", "*": "*", "_": "_", "~": "~", "$": "$",
  "“": "”", "‘": "’", "（": "）", "【": "】", "「": "」", "《": "》",
};
/** Blocks whose content is literal, where a typed delimiter is just text. */
const VERBATIM: BlockType[] = ["code", "frontmatter", "html", "math", "table"];

/**
 * Whether the keyboard follows Apple's conventions.
 *
 * The two platforms disagree about which modifier does what: macOS moves by
 * word with ⌥ and to the ends of a line or document with ⌘, while Windows and
 * Linux move by word with Ctrl. Binding one of them everywhere would leave the
 * other's ⌘←/Ctrl← doing nothing recognisable, so the bindings follow the host.
 *
 * Read per keystroke rather than cached, so a test can state which keyboard it
 * means; the cost is a regex over a short string.
 */
function applePlatform(): boolean {
  const nav = globalThis.navigator as { platform?: string; userAgent?: string } | undefined;
  return /Mac|iPhone|iPad/.test(nav?.platform || nav?.userAgent || "");
}

interface Snapshot {
  text: string;
  start: number;
  end: number;
}

type CaretAffinity = "upstream" | "downstream";
/** How much text one step of a mouse gesture selects. */
type Granularity = "char" | "word" | "block";
interface CaretPosition {
  offset: number;
  /** Which visual line owns a source offset shared by a soft wrap. */
  affinity: CaretAffinity;
}

export class Editor {
  private renderer: Renderer;
  private typesetter: Typesetter;
  private input: HTMLTextAreaElement;

  private text = "";
  private selStart = 0;
  private selEnd = 0;
  private caretAffinity: CaretAffinity = "downstream";
  private preferredX: number | null = null;

  private blocks: LaidBlock[] = [];
  private docHeight = 0;
  private scrollTop = 0;

  private composing: {
    before: Snapshot;
    affinity: CaretAffinity;
    start: number;
    end: number;
    value: string;
    updated: boolean;
  } | null = null;
  private search: SearchQuery | null = null;
  private matches: Match[] = [];
  /** The text `matches` was computed from, so a stale set is never shown. */
  private matchesFor: string | null = null;
  /** Which match the selection is on, or -1. */
  private current = -1;

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastEditAt = -Infinity;

  /** Pointer over the scrollbar, or dragging it. */
  private scrollbarActive = false;

  private caretVisible = true;
  private hasFocus = false;
  /** Set once the reader has placed the caret deliberately. Until then the
   *  document is shown fully typeset, even though the surface is focused and
   *  ready to accept input. */
  private interacted = false;
  private blinkTimer = 0;
  private frame = 0;
  private dirty = true;

  /** Options that belong to typing rather than to typesetting. */
  private editingOptions: EditingOptions = { ...DEFAULT_EDITING_OPTIONS };

  /** Last measured typesetting time, surfaced in the status bar. */
  lastLayoutMs = 0;
  onStatus: ((info: StatusInfo) => void) | null = null;
  /** Fires after every text change, including undo/redo and IME updates. */
  onChange: (() => void) | null = null;
  /** Fires when an editing option is toggled from the keyboard. */
  onEditingChange: (() => void) | null = null;
  /** Fires when the theme is changed from the keyboard, so the chrome that
   *  also sets it — a slider, say — can follow along. */
  onThemeChange: (() => void) | null = null;
  /** Called when a link is followed. Opening it belongs to the host, which
   *  knows whether it is running in a browser or in the desktop shell. */
  onFollowLink: ((href: string) => void) | null = null;

  constructor(
    private host: HTMLElement,
    private canvas: HTMLCanvasElement,
    theme: Theme = { ...DEFAULT_THEME },
    options: TypesetOptions = { ...DEFAULT_OPTIONS },
  ) {
    this.renderer = new Renderer(canvas);
    this.typesetter = new Typesetter(theme, options);

    this.input = document.createElement("textarea");
    this.input.className = "hidden-input";
    this.input.setAttribute("autocapitalize", "off");
    this.input.setAttribute("autocomplete", "off");
    this.input.setAttribute("spellcheck", "false");
    host.appendChild(this.input);

    this.attach();
  }

  get theme(): Theme {
    return this.typesetter.theme;
  }
  get editing(): EditingOptions {
    return this.editingOptions;
  }

  setEditing(patch: Partial<EditingOptions>): void {
    const before = this.editingOptions;
    this.editingOptions = { ...before, ...patch };
    // Source mode changes what every block looks like, so the page has to be
    // laid out again; the other options only affect the next keystroke.
    if (this.editingOptions.sourceMode !== before.sourceMode) this.invalidate();
    else if (this.editingOptions.focusMode !== before.focusMode) this.schedule();
    if (this.editingOptions.typewriter && !before.typewriter) this.scrollCaretIntoView();
  }

  /**
   * Step the type size, or put it back where it started.
   *
   * Zooming a page of text means changing the size of the type; the column
   * stays where it is, because the margins here are a property of the window
   * rather than of the em.
   */
  zoom(step: number): void {
    const size = step === 0
      ? DEFAULT_THEME.bodySize
      : Math.max(12, Math.min(32, Math.round(this.theme.bodySize + step)));
    if (size === this.theme.bodySize) return;
    this.setTheme({ bodySize: size });
    this.onThemeChange?.();
  }

  /** Show the whole document as source, or go back to the typeset page. */
  toggleSourceMode(): void {
    this.setEditing({ sourceMode: !this.editingOptions.sourceMode });
    this.onEditingChange?.();
  }

  /** Veil everything but the line being written. */
  toggleFocusMode(): void {
    this.setEditing({ focusMode: !this.editingOptions.focusMode });
    this.onEditingChange?.();
  }

  /** Keep the line being written at the middle of the window. */
  toggleTypewriter(): void {
    this.setEditing({ typewriter: !this.editingOptions.typewriter });
    this.onEditingChange?.();
  }

  get options(): TypesetOptions {
    return this.typesetter.options;
  }

  setOptions(patch: Partial<TypesetOptions>): void {
    Object.assign(this.typesetter.options, patch);
    this.typesetter.invalidate();
    this.invalidate();
  }

  /** How far down the document the window is, in document pixels. */
  get scrollOffset(): number {
    return this.scrollTop;
  }

  /** How far it could scroll, and how tall the window is. Together with
   *  `scrollOffset` this is enough to tell that the end of the document is on
   *  screen — which the outline needs, because the last few headings may never
   *  reach the top of the window. */
  get scrollExtent(): { max: number; viewport: number } {
    return { max: this.scrollMax, viewport: this.host.clientHeight };
  }

  /**
   * The document's headings, in order.
   *
   * Read off the laid-out blocks rather than re-parsed, so the `y` each entry
   * carries is the one the page was actually painted at and the outline can
   * follow the scroll without a second layout.
   */
  outline(): OutlineEntry[] {
    if (this.dirty) this.relayout();
    const entries: OutlineEntry[] = [];
    for (const b of this.blocks) {
      if (b.block.type !== "heading") continue;
      entries.push({
        level: b.block.level,
        text: b.rendered.text.trim(),
        start: b.block.start,
        y: b.y,
      });
    }
    return entries;
  }

  /** Put the caret at `offset` and bring it into view. */
  revealOffset(offset: number): void {
    this.select(offset, offset);
  }

  /**
   * Put the caret at `offset` and bring its block to the *top* of the window.
   *
   * `revealOffset` only scrolls far enough to make the caret visible, which is
   * right for typing and wrong for the outline: picking a heading that already
   * happens to be on screen — three short sections often are — would not move
   * the page at all, and nothing would say the request had been honoured.
   * Returns where it ended up, which is not the requested position once the
   * document runs out of room to scroll.
   */
  revealBlockAtTop(offset: number): number {
    this.select(offset, offset);
    if (this.dirty) this.relayout();
    const block = this.blocks.find((b) => offset >= b.block.start && offset <= b.block.end) ??
      this.blocks.find((b) => b.block.start >= offset);
    if (block) this.scrollTo(block.y - this.theme.bodySize * 0.6);
    return this.scrollTop;
  }

  /** Re-typeset after the math engine has loaded or its options changed. */
  invalidateMath(): void {
    this.typesetter.invalidate();
    this.invalidate();
  }

  setTheme(patch: Partial<Theme>): void {
    Object.assign(this.typesetter.theme, patch);
    this.typesetter.invalidate();
    this.invalidate();
  }

  async ready(): Promise<void> {
    await this.typesetter.ready;
    this.typesetter.invalidate();
    this.invalidate();
  }

  setText(text: string): void {
    const wasComposing = this.composing !== null;
    this.composing = null;
    this.input.value = "";
    if (wasComposing) this.input.blur();
    this.text = normalizeLineEndings(text);
    this.selStart = this.selEnd = 0;
    this.caretAffinity = "downstream";
    this.undoStack = [];
    this.redoStack = [];
    this.lastEditAt = -Infinity;
    this.invalidate();
  }

  getText(): string {
    return this.text;
  }

  /**
   * Apply a source transformation, and put the selection where it asks.
   *
   * One edit, one undo entry: a command is a single act however much text it
   * rewrites.
   */
  applyEdit(edit: Edit | null): void {
    if (!edit) return;
    this.replace(edit.from, edit.to, edit.insert, false);
    if (edit.select) this.select(edit.select.start, edit.select.end);
  }

  /**
   * Wrap the selection in a pair of delimiters, or take them off.
   *
   * With nothing selected the word under the caret is taken instead, which is
   * what makes ⌘B usable without reaching for the mouse first. Where there is
   * no word — the caret sits on a space, or in an empty document — an empty
   * pair is written and the caret goes between the halves.
   */
  toggleInline(open: string, close: string = open): void {
    if (this.dirty) this.relayout();
    const type = this.blockTypeAt(Math.min(this.selStart, this.selEnd));
    if (type && VERBATIM.includes(type)) return;

    let lo = Math.min(this.selStart, this.selEnd);
    let hi = Math.max(this.selStart, this.selEnd);
    if (lo === hi) {
      const word = wordAt(this.text, lo);
      // Only a real word is taken: on a space or a bracket the author is
      // asking for an empty pair to type into.
      if (/[\p{L}\p{N}]/u.test(this.text.slice(word.start, word.end))) {
        lo = word.start;
        hi = word.end;
      }
    }
    this.applyEdit(toggleInline(this.text, { start: lo, end: hi }, open, close));
  }

  /** Make the lines the selection touches headings, or paragraphs at 0. */
  setHeading(level: number): void {
    if (this.blockedBlock()) return;
    this.applyEdit(setHeading(this.text, this.range(), level));
  }

  /** Promote or demote the heading under the caret. */
  stepHeading(direction: 1 | -1): void {
    if (this.blockedBlock()) return;
    this.applyEdit(stepHeading(this.text, this.range(), direction));
  }

  /** Tick or untick the task items the selection touches. */
  toggleTask(range = this.range()): void {
    this.applyEdit(toggleTask(this.text, range));
  }

  /**
   * The task item whose checkbox is under a point.
   *
   * The box is drawn in the margin rather than set as text, so it has no
   * source position to hit-test against: its rectangle has to be recomputed
   * the way the renderer computes it, from the same function.
   */
  private checkboxAt(clientX: number, clientY: number): LaidBlock | null {
    const boxes = this.blocks.filter((b) => b.block.task !== "none" && b.lines.length);
    // Most documents have no checkbox at all; the layout read is worth
    // skipping on every click in those.
    if (!boxes.length) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left - this.gutter;
    const y = clientY - rect.top - this.originY + this.scrollTop;
    for (const b of boxes) {
      const style = b.lines[0].runs[0]?.style;
      if (!style) continue;
      const box = checkboxRect(b, style.size, b.y + b.lines[0].baseline, this.theme);
      // A little room around it: the box is small, and a pointer is not.
      const slack = 3;
      if (x >= box.x - slack && x <= box.x + box.w + slack &&
        y >= box.y - slack && y <= box.y + box.h + slack) {
        return b;
      }
    }
    return null;
  }

  /** Quote the lines the selection touches, or unquote them. */
  toggleQuote(): void {
    if (this.blockedBlock()) return;
    this.applyEdit(toggleQuote(this.text, this.range()));
  }

  /** Make the lines the selection touches list items, or plain lines. */
  toggleList(kind: ListKind): void {
    if (this.blockedBlock()) return;
    this.applyEdit(toggleList(this.text, this.range(), kind, this.editingOptions.writing));
  }

  /**
   * Put the selection in a code fence or a display formula, or take it out.
   *
   * The way out has to come from the parse rather than from the text: the
   * caret inside a fence sees only its content, and the delimiters that have
   * to go are the block's, wherever they are.
   */
  toggleFenced(kind: "code" | "math"): void {
    if (this.dirty) this.relayout();
    const at = this.range().start;
    const block = this.blockAt(at);
    if (block && block.type === kind) {
      this.applyEdit(unwrapFenced(this.text, { start: block.start, end: block.end }));
      return;
    }
    // Anywhere else that takes its text literally, a fence would be content.
    if (block && VERBATIM.includes(block.type)) return;
    const fence = kind === "code" ? "```" : "$$";
    this.applyEdit(wrapFenced(this.text, this.range(), fence, fence));
  }

  /** Indent or outdent the lines the selection touches. */
  indent(direction: 1 | -1): boolean {
    if (this.blockedBlock()) return false;
    const edit = indentLines(this.text, this.range(), direction, this.editingOptions.writing);
    this.applyEdit(edit);
    return edit !== null;
  }

  /** Move the lines the selection touches past their neighbour. */
  moveLines(direction: 1 | -1): void {
    this.applyEdit(moveLines(this.text, this.range(), direction));
  }

  /**
   * Delete the word under the caret, and the space after it.
   *
   * Taking the following space is what makes repeated presses eat a sentence
   * cleanly rather than leaving a trail of gaps behind them.
   */
  deleteWord(): void {
    const { start, end } = this.range();
    if (start !== end) {
      this.replace(start, end, "");
      return;
    }
    const word = wordAt(this.text, start);
    const to = this.text[word.end] === " " ? word.end + 1 : word.end;
    this.replace(word.start, to, "");
  }

  /** Delete the lines the selection touches — in a table, its rows. */
  deleteLine(): void {
    const lines = linesIn(this.text, this.range());
    let from = lines[0].start;
    let to = lines[lines.length - 1].end;
    // The line goes with its newline, so the ones around it close up. At the
    // end of the document there is none, so the one before it goes instead.
    if (to < this.text.length) to++;
    else if (from > 0) from--;
    this.replace(from, to, "");
  }

  /**
   * Finish a table the author began by typing its header row.
   *
   * The one input rule worth having: everything else Typora converts on
   * Return — a heading, a list, a quote — is already what our source says.
   *
   * Returns whether it handled the key.
   */
  private completeTable(): boolean {
    if (this.dirty) this.relayout();
    const { start, end } = this.range();
    if (start !== end) return false;
    const type = this.blockTypeAt(start);
    if (type === "table" || (type && VERBATIM.includes(type))) return false;
    const line = linesIn(this.text, { start, end })[0];
    // Only from the end of the row: mid-line, Return is a line break.
    if (start !== line.end) return false;
    const edit = completeTable(this.text, line);
    this.applyEdit(edit);
    return edit !== null;
  }

  /**
   * Walk the cells of a table with Tab.
   *
   * The cell's contents are selected rather than the caret merely placed, so
   * that typing replaces what is there — which is what makes tabbing through
   * a table to fill it in work at all. Tab out of the last cell writes
   * another row, so a table grows by being typed into.
   *
   * Returns whether it handled the key.
   */
  private moveCell(direction: 1 | -1): boolean {
    if (this.dirty) this.relayout();
    const at = this.range().start;
    const block = this.blockAt(at);
    if (!block || block.type !== "table") return false;

    const cells = block.rows.flat();
    if (!cells.length) return false;
    // The delimiter row has no cells of its own, so a caret on it counts as
    // being at the end of the header.
    let index = -1;
    for (let i = 0; i < cells.length; i++) if (cells[i].start <= at) index = i;
    const next = index + direction;

    if (next < 0) return true;
    if (next >= cells.length) {
      this.applyEdit(insertTableRow(this.text, block.end, block.rows[0]?.length ?? 1));
      return true;
    }
    const cell = cells[next];
    if (cell.text) this.select(cell.start, cell.end);
    else {
      // An empty cell's text sits at the end of its padding, which would put
      // the caret hard against the closing pipe. One space in from the
      // opening one keeps what is typed padded on both sides.
      let from = cell.start;
      while (from > 0 && this.text[from - 1] === " ") from--;
      const at = Math.min(from + 1, cell.start);
      this.select(at, at);
    }
    return true;
  }

  /** Put a fresh table where the caret is. */
  insertTable(): void {
    if (this.blockedBlock()) return;
    this.applyEdit(insertTable(this.text, linesIn(this.text, this.range())[0]));
  }

  /**
   * Make room after the current block — or, in a table, after the row.
   *
   * One key for "another one of these": a row where rows are what the block
   * is made of, and a paragraph everywhere else. It is also the only way to
   * put a paragraph in front of a table that opens the document.
   */
  insertParagraph(before: boolean): void {
    if (this.dirty) this.relayout();
    const at = this.range().start;
    const block = this.blockAt(at);
    if (!block) {
      this.insert("\n", false);
      return;
    }
    if (!before && block.type === "table") {
      let lineEnd = this.text.indexOf("\n", at);
      if (lineEnd < 0 || lineEnd > block.end) lineEnd = block.end;
      this.applyEdit(insertTableRow(this.text, lineEnd, block.rows[0]?.length ?? 1));
      return;
    }
    this.applyEdit(insertParagraph(this.text, { start: block.start, end: block.end }, before));
  }

  // -- selection commands -------------------------------------------------

  /** Select the word under the caret. */
  selectWord(): void {
    const { start } = this.range();
    const word = wordAt(this.text, start);
    this.select(word.start, word.end);
  }

  /** Select the source line the caret is on. */
  selectLine(): void {
    const { start, end } = this.range();
    const from = this.text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    let to = this.text.indexOf("\n", end);
    if (to < 0) to = this.text.length;
    this.select(from, to);
  }

  /** Select the whole block the caret is in. */
  selectBlock(): void {
    const range = this.blockRangeAt(this.range().start);
    this.select(range.start, range.end);
  }

  /**
   * Select the styled run the caret sits in — the whole bold phrase, the
   * whole code span, the text of the whole link.
   *
   * What is selected is the run's *content*, not its delimiters: the point of
   * the command is to replace the words, and the markup around them should
   * survive that. Where the caret is in plain text there is no scope to take,
   * so it falls back to the word, as Typora's does.
   */
  selectStyledScope(): void {
    if (this.dirty) this.relayout();
    const at = this.range().start;
    const block = this.blockAt(at);
    if (!block) return this.selectWord();
    const rendered = renderBlock(block, false, this.options.inline);
    for (const span of rendered.spans) {
      const from = rendered.map[span.start];
      // The map's exclusive end is where the *next* rendered character came
      // from, which is past any markup the span closes with. The content ends
      // one character after its last one — unless that one is an object,
      // whose source is longer than the U+FFFC standing in for it.
      const last = span.end - 1;
      const to = rendered.text[last] === OBJECT_REPLACEMENT
        ? rendered.map[span.end]
        : rendered.map[last] + 1;
      if (at < from || at > to) continue;
      const styled = span.kind !== "text" || span.strong || span.em || span.code || span.strike;
      if (!styled) break;
      // Pressing it again on a scope already selected takes the delimiters
      // too, which is the way to remove the styling with one more keystroke.
      if (this.selStart === from && this.selEnd === to) break;
      this.select(from, to);
      return;
    }
    this.selectWord();
  }

  /**
   * What copy and cut act on.
   *
   * With nothing selected that is the whole line, newline and all — the
   * convention every editor has settled on, and the reason ⌘X ⌘V moves a line
   * rather than doing nothing at all.
   */
  private clipboardRange(): { from: number; to: number } {
    const { start, end } = this.range();
    if (start !== end) return { from: start, to: end };
    const from = this.text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const stop = this.text.indexOf("\n", start);
    return { from, to: stop < 0 ? this.text.length : stop + 1 };
  }

  /** The selection, low end first. */
  private range(): { start: number; end: number } {
    return {
      start: Math.min(this.selStart, this.selEnd),
      end: Math.max(this.selStart, this.selEnd),
    };
  }

  /** What a plain Tab writes. Code has its own convention for how wide an
   *  indent is, and it is wider than prose's. */
  private tabText(): string {
    const { indent, codeIndent } = this.editingOptions.writing;
    return this.blockTypeAt(this.range().start) === "code" ? codeIndent : indent;
  }

  /** Whether Tab should indent rather than write spaces: a run of lines is
   *  selected, or the caret sits in a list. */
  private indentable(): boolean {
    const { start, end } = this.range();
    if (this.text.slice(start, end).includes("\n")) return true;
    return this.blockTypeAt(start) === "list";
  }

  /** Whether the caret sits in a block whose text is taken literally, where a
   *  markdown command would write characters rather than markup. */
  private blockedBlock(): boolean {
    if (this.dirty) this.relayout();
    const type = this.blockTypeAt(Math.min(this.selStart, this.selEnd));
    return type !== null && VERBATIM.includes(type);
  }

  /** Make the selection a link, or take the link off it. */
  toggleLink(): void {
    if (this.dirty) this.relayout();
    const lo = Math.min(this.selStart, this.selEnd);
    const type = this.blockTypeAt(lo);
    if (type && VERBATIM.includes(type)) return;
    this.applyEdit(toggleLink(this.text, { start: lo, end: Math.max(this.selStart, this.selEnd) }));
  }

  /**
   * Write the typographic form of what was typed, where there is one.
   *
   * Refused in blocks that take their text literally: a code fence full of
   * curly quotes would not compile, and a formula's dashes are minus signs.
   *
   * Returns whether it handled the character.
   */
  private smarten(ch: string): boolean {
    if (!this.editingOptions.smartPunctuation) return false;
    const { start, end } = this.range();
    if (start !== end) return false;
    if (this.blockedBlock()) return false;
    const found = smartPunctuation(this.text, start, ch);
    if (!found) return false;
    this.replace(found.from, start, found.insert, true);
    return true;
  }

  /** Strip inline markup from the selection. */
  clearFormat(): void {
    const lo = Math.min(this.selStart, this.selEnd);
    const hi = Math.max(this.selStart, this.selEnd);
    this.applyEdit(clearFormat(this.text, { start: lo, end: hi }, this.options.inline));
  }

  selectAll(): void {
    this.lastEditAt = -Infinity;
    this.selStart = 0;
    this.selEnd = this.text.length;
    this.invalidate();
  }

  /** The selected source text, for seeding a search with it. */
  selectedText(): string {
    return this.text.slice(
      Math.min(this.selStart, this.selEnd),
      Math.max(this.selStart, this.selEnd),
    );
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  // -- layout ------------------------------------------------------------

  // The text column's geometry depends on the window and on the reader's
  // column-width preference — never on the font size. Deriving it from the em
  // is tempting, since line length is properly measured in characters, but it
  // makes the margins slide around while the size is being adjusted, which
  // reads as the page coming apart rather than as the type growing.

  /** Left and right margin, in pixels. */
  private get gutter(): number {
    const available = this.host.clientWidth;
    return Math.max(MIN_GUTTER, (available - this.theme.columnWidth) / 2);
  }

  /** The width lines are set to. */
  private get measure(): number {
    return Math.max(MIN_MEASURE, this.host.clientWidth - this.gutter * 2);
  }

  /** Space above the first block. */
  private get originY(): number {
    return PAGE_TOP;
  }


  invalidate(): void {
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private relayout(): void {
    const t0 = performance.now();
    const result = this.typesetter.layoutDocument(
      this.text,
      this.measure,
      this.hasFocus && this.interacted ? this.selEnd : -1,
      this.editingOptions.sourceMode,
    );
    this.blocks = result.blocks;
    this.docHeight = result.height;
    this.lastLayoutMs = performance.now() - t0;
    this.dirty = false;
    // A shorter document, or a taller window, can leave the page scrolled
    // past what there is left to see.
    this.scrollTop = Math.min(this.scrollTop, this.scrollMax);
  }

  private render(): void {
    if (this.dirty) this.relayout();

    const view: Viewport = {
      scrollTop: this.scrollTop,
      width: this.host.clientWidth,
      height: this.host.clientHeight,
      originX: this.gutter,
      originY: this.originY,
    };
    this.renderer.resize(view.width, view.height);

    const caret = this.caretRect();
    const selection = this.selStart !== this.selEnd ? this.selectionRects() : [];

    this.renderer.draw(
      this.blocks,
      view,
      this.theme,
      // Matches go under the selection, which marks the current one.
      [...this.matchRects(view), ...selection],
      caret,
      this.caretVisible && this.hasFocus && this.interacted,
      this.options.showBadness,
      this.scrollbar(),
      this.focusBand(),
    );

    if (caret) {
      // The IME candidate window follows the textarea, so it has to sit where
      // the caret is or the popup appears in the wrong place entirely.
      this.input.style.left = `${view.originX + caret.x}px`;
      this.input.style.top = `${view.originY + caret.y - this.scrollTop}px`;
      this.input.style.height = `${caret.h}px`;
      this.input.style.fontSize = `${this.theme.bodySize}px`;
    }

    this.onStatus?.({
      chars: this.text.length,
      blocks: this.blocks.length,
      lines: this.blocks.reduce((n, b) => n + b.lines.length, 0),
      layoutMs: this.lastLayoutMs,
      measure: this.measure,
      badness: this.averageBadness(),
    });
  }

  private averageBadness(): number {
    let total = 0;
    let n = 0;
    for (const b of this.blocks) {
      for (let i = 0; i < b.lines.length - 1; i++) {
        const r = b.lines[i].ratio;
        if (isFinite(r)) {
          total += 100 * Math.abs(r) ** 3;
          n++;
        }
      }
    }
    return n ? total / n : 0;
  }

  // -- geometry ----------------------------------------------------------

  /** How far the document can scroll. The trailing space is deliberate: the
   *  last line should not sit against the bottom edge of the window. */
  private get scrollMax(): number {
    return Math.max(0, this.docHeight - this.host.clientHeight + this.theme.bodySize * 8);
  }

  /** The scrollbar thumb, or null when everything already fits. */
  private scrollbar(): Scrollbar | null {
    const view = this.host.clientHeight;
    // A window with no height — minimised, or a tab that is not being shown
    // — would otherwise report a scrollbar covering the whole surface, and
    // every click would land on it.
    if (view <= 0) return null;
    const max = this.scrollMax;
    if (max <= 0) return null;
    const track = view - 4;
    // The thumb's length is the visible fraction of the document, floored so
    // that a very long one still leaves something to take hold of.
    const h = Math.max(MIN_THUMB, Math.round(track * view / (view + max)));
    const y = 2 + Math.round((track - h) * Math.min(1, this.scrollTop / max));
    return { width: SCROLLBAR_WIDTH, y, h, active: this.scrollbarActive };
  }

  /** Scroll so the thumb's top sits at `y` in the window. */
  private scrollThumbTo(y: number): void {
    const bar = this.scrollbar();
    if (!bar) return;
    const travel = this.host.clientHeight - 4 - bar.h;
    const at = travel <= 0 ? 0 : (y - 2) / travel;
    this.scrollTo(at * this.scrollMax);
  }

  private scrollTo(top: number): void {
    const next = Math.max(0, Math.min(this.scrollMax, top));
    if (next === this.scrollTop) return;
    this.scrollTop = next;
    this.schedule();
  }

  /** Source position and visual affinity for a point in canvas coordinates. */
  private positionAt(clientX: number, clientY: number): CaretPosition {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left - this.gutter;
    const y = clientY - rect.top - this.originY + this.scrollTop;

    let best: LaidBlock | null = null;
    for (const b of this.blocks) {
      if (y >= b.y - b.spaceBefore && y <= b.y + b.height) {
        best = b;
        break;
      }
      if (!best || Math.abs(y - b.y) < Math.abs(y - best.y)) best = b;
    }
    if (!best || !best.lines.length) {
      return { offset: best ? best.block.start : this.text.length, affinity: "downstream" };
    }

    let line: LaidLine = best.lines[0];
    for (const l of best.lines) {
      if (y >= best.y + l.baseline - this.theme.bodySize) line = l;
    }
    return this.positionInLine(best, line, x - best.indent);
  }

  /**
   * The link under a point, if there is one.
   *
   * The destination rides on the run, so this is the same walk as placing the
   * caret rather than a second pass over the markdown — and it deliberately
   * asks for a hit *on the glyphs*: the run's own extent, not the nearest
   * line, so that the space beyond the end of a line is not a link.
   */
  private linkAt(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left - this.gutter;
    const y = clientY - rect.top - this.originY + this.scrollTop;
    for (const b of this.blocks) {
      if (y < b.y || y > b.y + b.height) continue;
      if (b.raw) return null;
      for (const line of b.lines) {
        const top = b.y + line.baseline - line.height;
        if (y < top || y > b.y + line.baseline + line.depth) continue;
        for (const run of line.runs) {
          if (!run.href || run.synthetic) continue;
          const rx = x - b.indent - run.x;
          if (rx >= 0 && rx <= this.runWidth(run)) return run.href;
        }
      }
    }
    return null;
  }

  private positionInLine(b: LaidBlock, line: LaidLine, x: number): CaretPosition {
    const offset = this.offsetInLine(b, line, x);
    return { offset, affinity: offset === line.docEnd ? "upstream" : "downstream" };
  }

  private offsetInLine(b: LaidBlock, line: LaidLine, x: number): number {
    if (!line.runs.length) return line.docStart;
    for (const run of line.runs) {
      if (run.synthetic) continue;
      const w = this.runWidth(run);
      if (x < run.x + w) {
        if (x <= run.x) return run.docStart;
        return this.offsetInRun(run, x - run.x);
      }
    }
    const last = line.runs.findLast((run) => !run.synthetic);
    return last?.docEnd ?? line.docEnd;
  }

  /** Binary search inside a word for the closest character boundary. */
  private offsetInRun(run: LaidRun, dx: number): number {
    const n = run.text.length;
    if (run.math || n <= 1) {
      const w = this.runWidth(run);
      return dx > w / 2 ? run.docEnd : run.docStart;
    }
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const w = this.typesetter.prefixWidth(run.text, mid, run.style) * run.scaleX;
      if (w < dx) lo = mid + 1;
      else hi = mid;
    }
    // Prefer the nearer of the two neighbouring boundaries.
    const before = this.typesetter.prefixWidth(run.text, Math.max(0, lo - 1), run.style) * run.scaleX;
    const after = this.typesetter.prefixWidth(run.text, lo, run.style) * run.scaleX;
    const idx = Math.abs(dx - before) < Math.abs(dx - after) ? Math.max(0, lo - 1) : lo;
    // Runs are contiguous in the source only when the block is shown raw;
    // otherwise fall back to the run's own start.
    const span = run.docEnd - run.docStart;
    return span === run.text.length ? run.docStart + idx : idx === 0 ? run.docStart : run.docEnd;
  }

  private runWidth(run: LaidRun): number {
    return (run.math?.width ?? this.typesetter.measureText(run.text, run.style, run.styleKey)) * run.scaleX;
  }

  /** Formulas are atomic source ranges, not the U+FFFC text we send to WASM. */
  private xInRun(run: LaidRun, offset: number): number {
    if (run.math) return run.x + (offset >= run.docEnd ? this.runWidth(run) : 0);
    const chars = run.docEnd - run.docStart === run.text.length
      ? Math.max(0, Math.min(run.text.length, offset - run.docStart))
      : offset >= run.docEnd ? run.text.length : 0;
    return run.x + this.typesetter.prefixWidth(run.text, chars, run.style) * run.scaleX;
  }

  /** Screen rectangle for the caret, in document coordinates. */
  private caretRect(): SelectionRect | null {
    const found = this.locate(this.selEnd);
    if (!found) return null;
    const { block, line, x } = found;
    const size = line.runs[0]?.style.size ?? this.theme.bodySize;
    return {
      x: block.indent + x,
      y: block.y + line.baseline - size * 0.85,
      w: 1.5,
      h: size * 1.2,
    };
  }

  /** Find the block, line and x offset for a document position. */
  private locate(
    offset: number,
    affinity: CaretAffinity = this.caretAffinity,
  ): { block: LaidBlock; line: LaidLine; x: number } | null {
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      if (!sourceRangeOwnsPosition(b.block, this.blocks[i + 1]?.block, offset)) continue;
      for (let li = 0; li < b.lines.length; li++) {
        const line = b.lines[li];
        // A soft wrap has two caret locations for one source offset. Keep
        // the side chosen by a mouse hit, vertical move, or Home/End.
        if (b.raw && affinity !== "upstream" && offset === line.docEnd &&
          b.lines[li + 1]?.docStart === offset) continue;
        if (!line.runs.length && offset >= line.docStart && offset <= line.docEnd) {
          return { block: b, line, x: 0 };
        }
        for (const run of line.runs) {
          if (run.synthetic) continue;
          if (offset >= run.docStart && offset <= run.docEnd) {
            return { block: b, line, x: this.xInRun(run, offset) };
          }
        }
      }
      // Offset falls in a stripped region (a marker); park at the line start.
      const line = b.lines[0];
      if (line) return { block: b, line, x: 0 };
    }
    const last = this.blocks.at(-1);
    if (last && last.lines.length) {
      const line = last.lines.at(-1)!;
      const run = line.runs.at(-1);
      return { block: last, line, x: run ? run.x + this.runWidth(run) : 0 };
    }
    return null;
  }

  private selectionRects(
    lo = Math.min(this.selStart, this.selEnd),
    hi = Math.max(this.selStart, this.selEnd),
  ): SelectionRect[] {
    const rects: SelectionRect[] = [];
    for (const b of this.blocks) {
      if (b.block.end < lo || b.block.start > hi) continue;
      for (const line of b.lines) {
        const size = line.runs[0]?.style.size ?? this.theme.bodySize;
        let x0 = Infinity;
        let x1 = -Infinity;
        for (const run of line.runs) {
          if (run.synthetic) continue;
          if (run.docEnd <= lo || run.docStart >= hi) continue;
          const exact = !run.math && run.docEnd - run.docStart === run.text.length;
          const sx = exact ? this.xInRun(run, Math.max(lo, run.docStart)) : run.x;
          const ex = exact ? this.xInRun(run, Math.min(hi, run.docEnd)) : run.x + this.runWidth(run);
          x0 = Math.min(x0, sx);
          x1 = Math.max(x1, ex);
        }
        // A selected physical newline has source extent even when its line
        // paints no glyphs. Give it a visible selection cell on that line.
        if (lo <= line.docEnd && hi > line.docEnd && this.text[line.docEnd] === "\n") {
          x0 = Math.min(x0, line.width);
          x1 = Math.max(x1, line.width + size * 0.5);
        }
        if (x1 > x0) {
          rects.push({
            x: b.indent + x0,
            y: b.y + line.baseline - size * 0.85,
            w: x1 - x0,
            h: size * 1.2,
          });
        }
      }
    }
    return rects;
  }

  /** The line that stays lit in focus mode, in document coordinates. */
  private focusBand(): { top: number; bottom: number } | null {
    if (!this.editingOptions.focusMode) return null;
    const found = this.locate(this.selEnd);
    if (!found) return null;
    const { block, line } = found;
    // The line rather than the whole block: a long paragraph veils down to
    // the line being written, which is the point of the mode.
    const air = this.theme.bodySize * 0.35;
    return {
      top: block.y + line.baseline - line.height - air,
      bottom: block.y + line.baseline + line.depth + air,
    };
  }

  /**
   * Bands under the matches that are on screen.
   *
   * A long document can hold thousands of matches, and each band costs a walk
   * over the blocks to place. Only what the reader can see is placed, which
   * bounds the work by the window rather than by the document.
   */
  private matchRects(view: Viewport): SelectionRect[] {
    this.refreshMatches();
    if (!this.matches.length) return [];
    const top = view.scrollTop - view.originY - 200;
    const bottom = top + view.height + 400;
    let from = Infinity;
    let to = -Infinity;
    for (const b of this.blocks) {
      if (b.y + b.height < top || b.y > bottom) continue;
      from = Math.min(from, b.block.start);
      to = Math.max(to, b.block.end);
    }
    const rects: SelectionRect[] = [];
    for (const m of this.matches) {
      if (m.end < from || m.start > to) continue;
      for (const r of this.selectionRects(m.start, m.end))
        rects.push({ ...r, color: this.theme.matchColor });
    }
    return rects;
  }

  /** Whether a canvas-relative x is within the strip the scrollbar answers
   *  to. Kept in terms of an offset so that tracking the pointer costs no
   *  layout read on every move. */
  private overScrollbar(canvasX: number): boolean {
    return this.scrollbar() !== null && canvasX >= this.canvas.clientWidth - SCROLLBAR_WIDTH;
  }

  /**
   * Take a press on the scrollbar, if that is what it is.
   *
   * Pressing the track jumps the thumb to the pointer and then drags from
   * there, which is what both platforms now do: the alternative — paging
   * towards the click — makes reaching a distant part of a long document a
   * matter of repeated clicks.
   */
  private beginScrollDrag(e: MouseEvent): boolean {
    const bar = this.scrollbar();
    if (!bar || !this.overScrollbar(e.offsetX)) return false;
    const top = this.canvas.getBoundingClientRect().top;
    const within = e.clientY - top - bar.y;
    // Grabbing the thumb keeps the point that was grabbed under the pointer;
    // anywhere else the thumb centres on it first.
    const grip = within >= 0 && within <= bar.h ? within : bar.h / 2;

    this.scrollbarActive = true;
    this.schedule();
    const move = (ev: MouseEvent) => this.scrollThumbTo(ev.clientY - top - grip);
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      this.scrollbarActive = this.overScrollbar(ev.clientX - this.canvas.getBoundingClientRect().left);
      this.schedule();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    move(e);
    return true;
  }

  // -- search ------------------------------------------------------------

  /**
   * Point the search at a query, or put it away.
   *
   * The nearest match at or after the caret is selected straight away, so
   * typing into the find field walks the document the way a browser's own
   * find does. The caret is left where it is when nothing matches, rather
   * than jumping to the top.
   */
  setSearch(query: SearchQuery | null): SearchStatus {
    this.search = query && query.text ? query : null;
    this.matchesFor = null;
    this.current = -1;
    this.refreshMatches();
    if (this.search) this.goToMatch(this.indexFrom(Math.min(this.selStart, this.selEnd), 1, true));
    else this.invalidate();
    return this.searchStatus();
  }

  /** Select the next match after the selection, wrapping at the end. */
  findNext(backwards = false): SearchStatus {
    this.refreshMatches();
    const from = backwards ? Math.min(this.selStart, this.selEnd) : Math.max(this.selStart, this.selEnd);
    this.goToMatch(this.indexFrom(from, backwards ? -1 : 1, false));
    return this.searchStatus();
  }

  /** Replace the match the selection is on, then move to the next. */
  replaceCurrent(replacement: string): SearchStatus {
    this.refreshMatches();
    const match = this.matches[this.current];
    // Only a match the author can see selected is replaced; otherwise this
    // is the first press of the button and it just finds one.
    if (!match || match.start !== Math.min(this.selStart, this.selEnd) ||
      match.end !== Math.max(this.selStart, this.selEnd)) {
      return this.findNext();
    }
    const text = expandReplacement(replacement, match);
    this.replace(match.start, match.end, text, false);
    this.refreshMatches();
    // Carry on from the end of what was written, so a replacement containing
    // the query does not match itself for ever.
    this.goToMatch(this.indexFrom(match.start + text.length, 1, true));
    return this.searchStatus();
  }

  /** Replace every match as one edit, so one undo puts the document back. */
  replaceAll(replacement: string): SearchStatus {
    this.refreshMatches();
    if (!this.matches.length) return this.searchStatus();
    const first = this.matches[0];
    const last = this.matches[this.matches.length - 1];
    let out = "";
    let at = first.start;
    for (const m of this.matches) {
      out += this.text.slice(at, m.start) + expandReplacement(replacement, m);
      at = m.end;
    }
    out += this.text.slice(at, last.end);
    this.replace(first.start, last.end, out, false);
    this.refreshMatches();
    this.current = -1;
    return this.searchStatus();
  }

  searchStatus(): SearchStatus {
    this.refreshMatches();
    return {
      matches: this.matches.length,
      index: this.current < 0 ? 0 : this.current + 1,
      valid: !this.search || compileSearch(this.search) !== undefined,
    };
  }

  /** Recompute the matches when the text under them has changed. */
  private refreshMatches(): void {
    if (!this.search) {
      if (this.matches.length) this.matches = [];
      return;
    }
    if (this.matchesFor === this.text) return;
    this.matchesFor = this.text;
    this.matches = findMatches(this.text, this.search);
    // An edit can leave the counter pointing past the end of the new set.
    if (this.current >= this.matches.length) this.current = -1;
  }

  /** The match to go to from a position, wrapping around the document. */
  private indexFrom(position: number, direction: 1 | -1, inclusive: boolean): number {
    if (!this.matches.length) return -1;
    if (direction > 0) {
      const at = this.matches.findIndex((m) => (inclusive ? m.start >= position : m.start > position));
      return at < 0 ? 0 : at;
    }
    for (let i = this.matches.length - 1; i >= 0; i--) {
      if (inclusive ? this.matches[i].end <= position : this.matches[i].end < position) return i;
    }
    return this.matches.length - 1;
  }

  private goToMatch(index: number): void {
    this.current = index;
    const match = this.matches[index];
    if (match) this.select(match.start, match.end);
    else this.invalidate();
  }

  // -- editing -----------------------------------------------------------

  private pushUndo(coalesce: boolean): void {
    const now = performance.now();
    if (coalesce && !this.redoStack.length && now - this.lastEditAt < 400 && this.undoStack.length) {
      this.lastEditAt = now;
      return;
    }
    this.lastEditAt = now;
    this.undoStack.push({ text: this.text, start: this.selStart, end: this.selEnd });
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
  }

  private replace(from: number, to: number, insert: string, coalesce = false): void {
    insert = normalizeLineEndings(insert);
    const next = this.text.slice(0, from) + insert + this.text.slice(to);
    if (next !== this.text) this.pushUndo(coalesce);
    this.text = next;
    this.selStart = this.selEnd = from + insert.length;
    this.caretAffinity = "downstream";
    this.preferredX = null;
    this.onChange?.();
    this.invalidate();
    this.scrollCaretIntoView();
  }

  private insert(s: string, coalesce = true): void {
    const lo = Math.min(this.selStart, this.selEnd);
    const hi = Math.max(this.selStart, this.selEnd);
    this.replace(lo, hi, s, coalesce && lo === hi);
  }

  /** Run a command by name. Public so a toolbar or a test can reach it. */
  run(id: CommandId): void {
    COMMANDS[id].run(this);
  }

  undo(): void {
    this.lastEditAt = -Infinity;
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.redoStack.push({ text: this.text, start: this.selStart, end: this.selEnd });
    this.text = snap.text;
    this.selStart = snap.start;
    this.selEnd = snap.end;
    this.caretAffinity = "downstream";
    this.onChange?.();
    this.invalidate();
  }

  redo(): void {
    this.lastEditAt = -Infinity;
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push({ text: this.text, start: this.selStart, end: this.selEnd });
    this.text = snap.text;
    this.selStart = snap.start;
    this.selEnd = snap.end;
    this.caretAffinity = "downstream";
    this.onChange?.();
    this.invalidate();
  }

  // -- caret movement ----------------------------------------------------

  private moveTo(offset: number, extend: boolean, affinity: CaretAffinity = "downstream"): void {
    this.select(extend ? this.selStart : offset, offset, affinity);
  }

  /** Place both ends of the selection; `focus` is the end the caret sits at. */
  private select(anchor: number, focus: number, affinity: CaretAffinity = "downstream"): void {
    const clamp = (n: number) => Math.max(0, Math.min(this.text.length, n));
    this.lastEditAt = -Infinity;
    this.selStart = clamp(anchor);
    this.selEnd = clamp(focus);
    this.caretAffinity = affinity;
    this.caretVisible = true;
    this.invalidate();
    // Reveal the target block before measuring where its caret must scroll.
    this.scrollCaretIntoView();
  }

  /**
   * The span one click of the given granularity selects around `offset`.
   *
   * Word boundaries come from `Intl.Segmenter`, so a double-click inside
   * 中文排版 selects a word rather than the whole run of Han — no pattern over
   * code points could find that boundary.
   */
  private granuleAt(offset: number, grain: Granularity): { start: number; end: number } {
    if (grain === "word") return wordAt(this.text, offset);
    if (grain === "block") return this.blockRangeAt(offset);
    return { start: offset, end: offset };
  }

  /** The source range of the block at `offset`, without its trailing blank
   *  line — a triple-click selects the text, not the separator after it. */
  private blockRangeAt(offset: number): { start: number; end: number } {
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i].block;
      if (!sourceRangeOwnsPosition(b, this.blocks[i + 1]?.block, offset)) continue;
      let end = b.end;
      while (end > b.start && /\s/.test(this.text[end - 1])) end--;
      return { start: b.start, end };
    }
    return { start: offset, end: offset };
  }

  private moveVertical(dir: -1 | 1, extend: boolean): void {
    const here = this.locate(this.selEnd);
    if (!here) return;
    const targetX = this.preferredX ?? here.block.indent + here.x;

    // Flatten the visible lines so the previous or next one is a step away.
    const flat: Array<{ b: LaidBlock; l: LaidLine }> = [];
    for (const b of this.blocks) for (const l of b.lines) flat.push({ b, l });
    const idx = flat.findIndex((f) => f.b === here.block && f.l === here.line);
    const next = flat[idx + dir];
    if (!next) {
      this.moveTo(dir < 0 ? 0 : this.text.length, extend);
      return;
    }
    const position = this.positionInLine(next.b, next.l, targetX - next.b.indent);
    this.moveTo(position.offset, extend, position.affinity);
    this.preferredX = targetX;
  }

  private lineBounds(offset: number): { start: number; end: number } {
    const found = this.locate(offset);
    if (!found) return { start: offset, end: offset };
    return { start: found.line.docStart, end: found.line.docEnd };
  }

  private scrollCaretIntoView(): void {
    if (this.dirty) this.relayout();
    const caret = this.caretRect();
    if (!caret) return;
    if (this.editingOptions.typewriter) {
      // The line being written stays where the eyes already are, and the page
      // moves under it.
      this.scrollTo(caret.y + caret.h / 2 - this.host.clientHeight / 2);
      return;
    }
    const viewTop = this.scrollTop;
    const viewBottom = this.scrollTop + this.host.clientHeight - this.theme.bodySize * 4;
    const top = caret.y;
    const bottom = caret.y + caret.h;
    if (top < viewTop) this.scrollTo(top - this.theme.bodySize * 2);
    else if (bottom > viewBottom) this.scrollTo(bottom - this.host.clientHeight + this.theme.bodySize * 5);
  }

  // -- events ------------------------------------------------------------

  private beginComposition(): void {
    this.finishComposition();
    this.interacted = true;
    this.composing = {
      before: { text: this.text, start: this.selStart, end: this.selEnd },
      affinity: this.caretAffinity,
      start: Math.min(this.selStart, this.selEnd),
      end: Math.max(this.selStart, this.selEnd),
      value: "", updated: false,
    };
  }

  private updateComposition(value: string): void {
    const composition = this.composing;
    if (!composition) return;
    composition.value = normalizeLineEndings(value);
    composition.updated = true;
    const { before, start, end } = composition;
    this.text = before.text.slice(0, start) + composition.value + before.text.slice(end);
    this.selStart = this.selEnd = start + composition.value.length;
    this.caretAffinity = "downstream";
    this.preferredX = null;
    this.onChange?.();
    this.invalidate();
    this.scrollCaretIntoView();
  }

  private endComposition(value: string): void {
    const composition = this.composing;
    if (!composition) return;
    this.composing = null;
    const { before, start, end, affinity } = composition;
    this.text = before.text;
    this.selStart = before.start;
    this.selEnd = before.end;
    this.caretAffinity = affinity;
    this.input.value = "";
    if (value) this.replace(start, end, value, false);
    else {
      this.onChange?.();
      this.invalidate();
      this.scrollCaretIntoView();
    }
    // The next ordinary keystroke is a separate transaction too.
    this.lastEditAt = -Infinity;
  }

  /** Settle the visible IME edit before saving, replacing, or leaving it. */
  finishComposition(): void {
    if (!this.composing) return;
    // Let the host commit/cancel its candidate first, if it dispatches the
    // event synchronously on blur. Otherwise commit the visible preview.
    this.input.blur();
    if (this.composing) this.endComposition(this.composing.updated ? this.composing.value : "");
  }

  private attach(): void {
    const canvas = this.canvas;

    canvas.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (this.beginScrollDrag(e)) return;
      // A plain click still places the caret — the source under it has to
      // stay editable — so following a link takes the platform's modifier,
      // the same one that opens a link in a new tab elsewhere.
      if (e.metaKey || e.ctrlKey) {
        const href = this.linkAt(e.clientX, e.clientY);
        if (href) {
          this.onFollowLink?.(href);
          return;
        }
      }
      // A checkbox is a control, so a plain click on it ticks the box rather
      // than putting the caret next to it.
      const task = this.checkboxAt(e.clientX, e.clientY);
      if (task) {
        this.focus();
        this.toggleTask({ start: task.block.start, end: task.block.start });
        return;
      }
      this.finishComposition();
      this.interacted = true;
      this.focus();
      const position = this.positionAt(e.clientX, e.clientY);
      this.preferredX = null;

      // A repeated click widens the unit the gesture works in: a word, then
      // the whole block. The platform counts the clicks for us, applying its
      // own timing and travel thresholds.
      const grain: Granularity = e.detail >= 3 ? "block" : e.detail === 2 ? "word" : "char";
      const anchor = this.granuleAt(position.offset, grain);
      if (grain === "char") this.moveTo(position.offset, e.shiftKey, position.affinity);
      else this.select(anchor.start, anchor.end);

      // Dragging keeps the granularity it started in: the selection always
      // covers whole words, or whole blocks, and grows from whichever end of
      // the first one the pointer has passed.
      const move = (ev: MouseEvent) => {
        const to = this.positionAt(ev.clientX, ev.clientY);
        if (grain === "char") {
          this.moveTo(to.offset, true, to.affinity);
          return;
        }
        const reached = this.granuleAt(to.offset, grain);
        if (reached.start < anchor.start) this.select(anchor.end, reached.start);
        else this.select(anchor.start, Math.max(anchor.end, reached.end));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });

    canvas.addEventListener("mousemove", (e) => {
      // Held modifier over a link: say so, since a click will follow it.
      const link = (e.metaKey || e.ctrlKey) && this.linkAt(e.clientX, e.clientY) !== null;
      const cursor = link ? "pointer" : "";
      if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;

      const over = this.overScrollbar(e.offsetX);
      if (over === this.scrollbarActive) return;
      this.scrollbarActive = over;
      this.schedule();
    });
    canvas.addEventListener("mouseleave", () => {
      if (!this.scrollbarActive) return;
      this.scrollbarActive = false;
      this.schedule();
    });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.scrollTo(this.scrollTop + e.deltaY);
    }, { passive: false });

    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));

    // Provisional composition renders in place, but owns no history entry
    // until commit. Every update is derived from the pre-composition snapshot.
    this.input.addEventListener("compositionstart", () => this.beginComposition());
    this.input.addEventListener("compositionupdate", (e) => this.updateComposition(e.data ?? ""));
    this.input.addEventListener("compositionend", (e) => this.endComposition(e.data ?? ""));

    this.input.addEventListener("input", (event) => {
      const e = event as InputEvent;
      if (this.composing || e.isComposing) return;
      // Some hosts dispatch the final input after compositionend. The string
      // was already committed by that event, so it must not be inserted twice.
      if (e.inputType === "insertFromComposition" || e.inputType === "insertCompositionText") {
        this.input.value = "";
        return;
      }
      this.interacted = true;
      const value = this.input.value;
      this.input.value = "";
      if (!value) return;
      if (value.length === 1 && (this.autoPair(value) || this.smarten(value))) return;
      this.insert(value);
    });

    this.input.addEventListener("paste", (e) => {
      e.preventDefault();
      this.finishComposition();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text) this.insert(text, false);
    });

    this.input.addEventListener("copy", (e) => {
      e.preventDefault();
      const { from, to } = this.clipboardRange();
      e.clipboardData?.setData("text/plain", this.text.slice(from, to));
    });

    this.input.addEventListener("cut", (e) => {
      e.preventDefault();
      this.finishComposition();
      const { from, to } = this.clipboardRange();
      e.clipboardData?.setData("text/plain", this.text.slice(from, to));
      if (from !== to) this.replace(from, to, "");
    });

    this.input.addEventListener("blur", () => {
      if (this.composing) this.endComposition(this.composing.updated ? this.composing.value : "");
      this.caretVisible = false;
      this.hasFocus = false;
      this.invalidate();
    });
    this.input.addEventListener("focus", () => {
      this.caretVisible = true;
      this.hasFocus = true;
      this.invalidate();
    });

    this.blinkTimer = window.setInterval(() => {
      if (document.activeElement !== this.input) return;
      this.caretVisible = !this.caretVisible;
      this.schedule();
    }, 530);

    new ResizeObserver(() => {
      this.typesetter.invalidate();
      this.invalidate();
    }).observe(this.host);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.composing || e.isComposing) return;
    if (!e.metaKey && !e.ctrlKey) this.interacted = true;
    const lo = Math.min(this.selStart, this.selEnd);
    const hi = Math.max(this.selStart, this.selEnd);

    const apple = applePlatform();

    // The bound commands come first: some of them claim keys that would
    // otherwise be ordinary editing (Tab in a list, ⌥↑ on a block).
    const command = commandFor(e, BINDINGS, apple);
    if (command) {
      e.preventDefault();
      this.run(command);
      return;
    }

    const byWord = apple ? e.altKey : e.ctrlKey && !e.altKey;
    const byLine = apple && e.metaKey;
    const byDocument = apple ? e.metaKey : e.ctrlKey;

    switch (e.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        this.preferredX = null;
        const forward = e.key === "ArrowRight";
        // An unextended move out of a selection starts from the edge it is
        // heading towards, so ⌥→ passes the word after the selection rather
        // than the one it already covers.
        const from = lo !== hi && !e.shiftKey ? (forward ? hi : lo) : this.selEnd;
        if (byLine) {
          const bounds = this.lineBounds(from);
          this.moveTo(forward ? bounds.end : bounds.start, e.shiftKey,
            forward ? "upstream" : "downstream");
        } else if (byWord) {
          this.moveTo(wordBoundary(this.text, from, forward ? 1 : -1), e.shiftKey);
        } else if (from !== this.selEnd) {
          this.moveTo(from, false);
        } else {
          this.moveTo(forward ? this.stepForward(from) : this.stepBack(from), e.shiftKey);
        }
        return;
      }
      case "ArrowUp":
      case "ArrowDown": {
        e.preventDefault();
        const down = e.key === "ArrowDown";
        if (byDocument) {
          this.preferredX = null;
          this.moveTo(down ? this.text.length : 0, e.shiftKey);
        } else {
          this.moveVertical(down ? 1 : -1, e.shiftKey);
        }
        return;
      }
      case "Home":
        e.preventDefault();
        this.preferredX = null;
        this.moveTo(byDocument ? 0 : this.lineBounds(this.selEnd).start, e.shiftKey);
        return;
      case "End":
        e.preventDefault();
        this.preferredX = null;
        this.moveTo(byDocument ? this.text.length : this.lineBounds(this.selEnd).end,
          e.shiftKey, "upstream");
        return;
      case "Backspace": {
        e.preventDefault();
        if (lo !== hi) this.replace(lo, hi, "");
        // An empty pair was inserted in one keystroke, so it goes in one too.
        else if (lo > 0 && AUTO_CLOSE[this.text[lo - 1]] === this.text[lo]) {
          this.replace(lo - 1, lo + 1, "", true);
        } else if (lo > 0) this.replace(this.stepBack(lo), lo, "", true);
        return;
      }
      case "Delete":
        e.preventDefault();
        if (lo !== hi) this.replace(lo, hi, "");
        else if (hi < this.text.length) this.replace(hi, this.stepForward(hi), "", true);
        return;
      case "Enter":
        e.preventDefault();
        if (e.shiftKey) this.insert(this.hardBreak(), false);
        else if (!this.completeTable() && !this.continueList()) this.insert("\n", false);
        return;
      case "Tab":
        e.preventDefault();
        // In a table Tab walks the cells; that is what it is for there.
        if (this.moveCell(e.shiftKey ? -1 : 1)) return;
        // Otherwise it is indentation where there is something to indent — a
        // list item, or a run of lines — and a plain indent everywhere else.
        if (e.shiftKey) this.indent(-1);
        else if (!this.indentable() || !this.indent(1)) this.insert(this.tabText(), false);
        return;
    }
  }

  /**
   * Pair up a typed delimiter.
   *
   * Three things, in the order a keystroke could mean them:
   *
   *  - over a selection, the character wraps it — the one case where the
   *    intent is beyond doubt, so the set of characters accepted is widest
   *    here and includes the emphasis marks and `$`;
   *  - onto a closer that is already there, it steps over rather than
   *    doubling it, which is what makes typing a whole pair feel unchanged;
   *  - otherwise it opens a pair, unless the text it would enclose says
   *    otherwise.
   *
   * Only characters the author typed reach this. An IME commit goes through
   * the composition path instead, where the transaction is already delicate
   * and a silent extra character would be worse than a missing convenience.
   *
   * Returns whether it handled the character.
   */
  private autoPair(ch: string): boolean {
    const lo = Math.min(this.selStart, this.selEnd);
    const hi = Math.max(this.selStart, this.selEnd);
    // Blocks are laid out on the next frame; a fast typist can outrun it.
    if (this.dirty) this.relayout();
    const type = this.blockTypeAt(lo);
    if (type && VERBATIM.includes(type)) return false;

    if (lo !== hi) {
      if (!this.editingOptions.autoPairMarkdown) return false;
      const smart = this.editingOptions.smartPunctuation ? smartPair(ch) : null;
      if (smart) {
        this.replace(lo, hi, smart[0] + this.text.slice(lo, hi) + smart[1], false);
        this.select(lo + smart[0].length, hi + smart[0].length);
        return true;
      }
      const close = WRAPPERS[ch];
      if (!close) return false;
      this.replace(lo, hi, ch + this.text.slice(lo, hi) + close, false);
      // Keep the text selected, so wrapping it again in something else is
      // one more keystroke rather than a fresh selection.
      this.select(lo + ch.length, hi + ch.length);
      return true;
    }

    if (!this.editingOptions.autoPairBrackets) return false;

    if (CLOSERS.has(ch) && this.text[lo] === ch) {
      this.moveTo(lo + 1, false);
      return true;
    }

    const close = AUTO_CLOSE[ch];
    if (!close) return false;
    // Nothing is opened against a word: the author is writing "don't" or
    // reaching into "f(x)", not asking for a pair.
    const after = this.text[lo] ?? "";
    if (after && /[\p{L}\p{N}]/u.test(after)) return false;
    // A symmetric delimiter cannot tell opening from closing, so it stays out
    // of a word's way on the left too — and lets ``` be typed as a fence.
    const before = lo > 0 ? this.text[lo - 1] : "";
    if (close === ch && before && (before === ch || /[\p{L}\p{N}]/u.test(before))) return false;

    this.replace(lo, lo, ch + close, false);
    this.select(lo + 1, lo + 1);
    return true;
  }

  /**
   * Enter inside a list: carry the marker onto the next line.
   *
   * Typing the marker again by hand is the sort of work the machine should be
   * doing, but only where it is certain: the caret has to be in a block the
   * parser reads as a list, so that "- x" inside a code fence or a table stays
   * literal text. An item holding nothing but its marker is how an author
   * leaves a list, so there Enter withdraws the marker instead — one level
   * outwards if the item is nested, and out of the list at the outer level.
   *
   * Returns whether it handled the key.
   */
  private continueList(): boolean {
    // Blocks are laid out on the next frame, so a fast typist can arrive here
    // before the previous keystroke's parse.
    if (this.dirty) this.relayout();
    const at = Math.min(this.selStart, this.selEnd);
    if (this.blockTypeAt(at) !== "list") return false;

    const lineStart = this.text.lastIndexOf("\n", at - 1) + 1;
    const lineEnd = this.text.indexOf("\n", at);
    const item = listItemMarker(this.text.slice(lineStart, lineEnd < 0 ? this.text.length : lineEnd));
    // Within the marker itself Enter is an ordinary break: the author is
    // pushing the item down, not adding another.
    if (!item || at < lineStart + item.prefix.length) return false;

    if (item.empty) {
      if (this.selStart !== this.selEnd) return false;
      this.replace(lineStart, lineStart + item.prefix.length, item.outdented ?? "", false);
      return true;
    }
    this.insert("\n" + item.next, false);
    return true;
  }

  /**
   * The source a forced line break is written as.
   *
   * A bare newline is a *soft* break — markdown joins the lines, and the CJK
   * rule discards it outright — so Shift+Enter has to write a marker or the
   * break the author asked for simply disappears.
   *
   * Of CommonMark's two spellings this uses the backslash rather than two
   * trailing spaces. The editor reveals the source of the block holding the
   * caret, and an invisible marker is one the author can neither verify nor
   * deliberately remove; trailing whitespace is also stripped by many
   * formatters and editors, which destroys the break silently. Documents
   * written with two spaces still read correctly — the parser accepts both.
   *
   * Verbatim blocks have no forced break to write: their line structure is
   * already literal, and a backslash there would become content.
   */
  private hardBreak(): string {
    const type = this.blockTypeAt(this.selEnd);
    if (type && VERBATIM.includes(type)) return "\n";

    // A quotation is recognised line by line, so a continuation without the
    // marker leaves the block rather than breaking inside it — and the
    // backslash, now the last character of a one-line quote, is read as
    // content. A list item needs nothing: an unmarked line is already a lazy
    // continuation of it.
    return "\\\n" + (type === "quote" ? this.quotePrefixAtCaret() : "");
  }

  /** The `>` marker opening the caret's line, so a break stays in the quote. */
  private quotePrefixAtCaret(): string {
    const lineStart = this.text.lastIndexOf("\n", Math.max(0, this.selEnd - 1)) + 1;
    return /^\s*>\s?/.exec(this.text.slice(lineStart, this.selEnd))?.[0] ?? "> ";
  }

  /** The block a position sits in, by the same ownership rule as `locate` —
   *  a shared boundary belongs to the block that follows. */
  private blockAt(offset: number): Block | null {
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      if (sourceRangeOwnsPosition(b.block, this.blocks[i + 1]?.block, offset)) return b.block;
    }
    return null;
  }

  private blockTypeAt(offset: number): BlockType | null {
    return this.blockAt(offset)?.type ?? null;
  }

  /** Move by one grapheme, so surrogate pairs are not split. */
  private stepBack(at: number): number {
    if (at <= 0) return 0;
    const before = this.text.codePointAt(at - 2);
    return before !== undefined && before > 0xffff ? at - 2 : at - 1;
  }

  private stepForward(at: number): number {
    if (at >= this.text.length) return this.text.length;
    const cp = this.text.codePointAt(at)!;
    return cp > 0xffff ? at + 2 : at + 1;
  }

  destroy(): void {
    clearInterval(this.blinkTimer);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.input.remove();
  }
}

/** What the find bar shows: how many matches, which one, and whether the
 *  author's pattern compiles at all. */
export interface SearchStatus {
  matches: number;
  index: number;
  valid: boolean;
}

/** Options that belong to typing rather than to typesetting. */
export interface EditingOptions {
  /** Turn typed quotes, dashes and dots into their typographic forms. */
  smartPunctuation: boolean;
  /** How the editor writes the markdown its commands generate. */
  writing: WritingStyle;
  /** Close a bracket, a quote or a backtick as it is typed. */
  autoPairBrackets: boolean;
  /** Let a markdown delimiter typed over a selection wrap it. */
  autoPairMarkdown: boolean;
  /** Show the whole document as markdown source rather than typeset. */
  sourceMode: boolean;
  /** Veil everything but the line being written. */
  focusMode: boolean;
  /** Keep the line being written at the middle of the window. */
  typewriter: boolean;
}

export const DEFAULT_EDITING_OPTIONS: EditingOptions = {
  smartPunctuation: true,
  autoPairBrackets: true,
  autoPairMarkdown: true,
  writing: { ...DEFAULT_WRITING_STYLE },
  sourceMode: false,
  focusMode: false,
  typewriter: false,
};

/** One heading, as the outline panel needs it. */
export interface OutlineEntry {
  /** 1-6. */
  level: number;
  /** The heading's text with its markers stripped. */
  text: string;
  /** Where the heading starts in the source. */
  start: number;
  /** Top of the heading in document space, for tracking the scroll. */
  y: number;
}

export interface StatusInfo {
  chars: number;
  blocks: number;
  lines: number;
  layoutMs: number;
  measure: number;
  badness: number;
}
