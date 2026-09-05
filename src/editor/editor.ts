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

import { Renderer, type SelectionRect, type Viewport } from "../render/canvas.js";
import { parseBlocks, type Block } from "../markdown/parse.js";
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

interface Snapshot {
  text: string;
  start: number;
  end: number;
}

export class Editor {
  private renderer: Renderer;
  private typesetter: Typesetter;
  private input: HTMLTextAreaElement;

  private text = "";
  private selStart = 0;
  private selEnd = 0;
  private preferredX: number | null = null;

  private blocks: LaidBlock[] = [];
  private docHeight = 0;
  private scrollTop = 0;

  private composing: { start: number; length: number } | null = null;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastEditAt = 0;

  private caretVisible = true;
  private hasFocus = false;
  /** Set once the reader has placed the caret deliberately. Until then the
   *  document is shown fully typeset, even though the surface is focused and
   *  ready to accept input. */
  private interacted = false;
  private blinkTimer = 0;
  private frame = 0;
  private dirty = true;

  /** Last measured typesetting time, surfaced in the status bar. */
  lastLayoutMs = 0;
  onStatus: ((info: StatusInfo) => void) | null = null;
  /** Fires on the first edit after the document was loaded or saved. */
  onChange: (() => void) | null = null;

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
  get options(): TypesetOptions {
    return this.typesetter.options;
  }

  setOptions(patch: Partial<TypesetOptions>): void {
    Object.assign(this.typesetter.options, patch);
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
    this.text = text;
    this.selStart = this.selEnd = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.invalidate();
  }

  getText(): string {
    return this.text;
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
      this.focusedBlock(),
    );
    this.blocks = result.blocks;
    this.docHeight = result.height;
    this.lastLayoutMs = performance.now() - t0;
    this.dirty = false;
  }

  /**
   * Index of the block holding the caret, in the same numbering the
   * typesetter uses (which counts blank blocks, so it cannot be derived from
   * the laid-out list). The parse is cached against the document text, so
   * this costs nothing on a resize and one pass per edit.
   */
  private focusedBlock(): number {
    // Revealing a block's markdown is a response to the caret being in it, so
    // an unfocused editor shows the document fully typeset.
    if (!this.hasFocus || !this.interacted) return -1;
    if (!this.parseCache || this.parseCache.text !== this.text) {
      this.parseCache = { text: this.text, blocks: parseBlocks(this.text) };
    }
    const caret = this.selEnd;
    const blocks = this.parseCache.blocks;
    for (let i = 0; i < blocks.length; i++) {
      if (caret >= blocks[i].start && caret <= blocks[i].end) return i;
    }
    return -1;
  }

  private parseCache: { text: string; blocks: Block[] } | null = null;

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
      selection,
      caret,
      this.caretVisible && this.hasFocus && this.interacted,
      this.options.showBadness,
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

  /** Document offset for a point in canvas coordinates. */
  private offsetAt(clientX: number, clientY: number): number {
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
    if (!best || !best.lines.length) return best ? best.block.start : this.text.length;

    let line: LaidLine = best.lines[0];
    for (const l of best.lines) {
      if (y >= best.y + l.baseline - this.theme.bodySize) line = l;
    }
    return this.offsetInLine(best, line, x - best.indent);
  }

  private offsetInLine(b: LaidBlock, line: LaidLine, x: number): number {
    if (!line.runs.length) return b.block.start;
    for (const run of line.runs) {
      if (run.synthetic) continue;
      const w = this.runWidth(run);
      if (x < run.x + w) {
        if (x <= run.x) return run.docStart;
        return this.offsetInRun(run, x - run.x);
      }
    }
    const last = line.runs[line.runs.length - 1];
    return last.docEnd;
  }

  /** Binary search inside a word for the closest character boundary. */
  private offsetInRun(run: LaidRun, dx: number): number {
    const n = run.text.length;
    if (n <= 1) {
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
    return this.typesetter.measureText(run.text, run.style, run.styleKey) * run.scaleX;
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
  private locate(offset: number): { block: LaidBlock; line: LaidLine; x: number } | null {
    for (const b of this.blocks) {
      if (offset < b.block.start || offset > b.block.end) continue;
      for (const line of b.lines) {
        for (const run of line.runs) {
          if (run.synthetic) continue;
          if (offset >= run.docStart && offset <= run.docEnd) {
            const span = run.docEnd - run.docStart;
            const chars =
              span === run.text.length ? offset - run.docStart : offset >= run.docEnd ? run.text.length : 0;
            const x = run.x + this.typesetter.prefixWidth(run.text, chars, run.style) * run.scaleX;
            return { block: b, line, x };
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

  private selectionRects(): SelectionRect[] {
    const lo = Math.min(this.selStart, this.selEnd);
    const hi = Math.max(this.selStart, this.selEnd);
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
          const span = run.docEnd - run.docStart;
          const exact = span === run.text.length;
          const s = exact ? Math.max(0, lo - run.docStart) : 0;
          const e = exact ? Math.min(run.text.length, hi - run.docStart) : run.text.length;
          const sx = run.x + this.typesetter.prefixWidth(run.text, s, run.style) * run.scaleX;
          const ex = run.x + this.typesetter.prefixWidth(run.text, e, run.style) * run.scaleX;
          x0 = Math.min(x0, sx);
          x1 = Math.max(x1, ex);
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

  // -- editing -----------------------------------------------------------

  private pushUndo(coalesce: boolean): void {
    const now = performance.now();
    if (coalesce && now - this.lastEditAt < 400 && this.undoStack.length) {
      this.lastEditAt = now;
      return;
    }
    this.lastEditAt = now;
    this.undoStack.push({ text: this.text, start: this.selStart, end: this.selEnd });
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
  }

  private replace(from: number, to: number, insert: string, coalesce = false): void {
    this.pushUndo(coalesce);
    this.onChange?.();
    this.text = this.text.slice(0, from) + insert + this.text.slice(to);
    this.selStart = this.selEnd = from + insert.length;
    this.preferredX = null;
    this.invalidate();
  }

  private insert(s: string, coalesce = true): void {
    const lo = Math.min(this.selStart, this.selEnd);
    const hi = Math.max(this.selStart, this.selEnd);
    this.replace(lo, hi, s, coalesce && lo === hi);
  }

  private undo(): void {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.redoStack.push({ text: this.text, start: this.selStart, end: this.selEnd });
    this.text = snap.text;
    this.selStart = snap.start;
    this.selEnd = snap.end;
    this.invalidate();
  }

  private redo(): void {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push({ text: this.text, start: this.selStart, end: this.selEnd });
    this.text = snap.text;
    this.selStart = snap.start;
    this.selEnd = snap.end;
    this.invalidate();
  }

  // -- caret movement ----------------------------------------------------

  private moveTo(offset: number, extend: boolean): void {
    this.selEnd = Math.max(0, Math.min(this.text.length, offset));
    if (!extend) this.selStart = this.selEnd;
    this.caretVisible = true;
    this.scrollCaretIntoView();
    this.invalidate();
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
    const offset = this.offsetInLine(next.b, next.l, targetX - next.b.indent);
    this.moveTo(offset, extend);
    this.preferredX = targetX;
  }

  private lineBounds(offset: number): { start: number; end: number } {
    const found = this.locate(offset);
    if (!found) return { start: offset, end: offset };
    const runs = found.line.runs.filter((r) => !r.synthetic);
    if (!runs.length) return { start: offset, end: offset };
    return { start: runs[0].docStart, end: runs[runs.length - 1].docEnd };
  }

  private scrollCaretIntoView(): void {
    if (this.dirty) this.relayout();
    const caret = this.caretRect();
    if (!caret) return;
    const viewTop = this.scrollTop;
    const viewBottom = this.scrollTop + this.host.clientHeight - this.theme.bodySize * 4;
    const top = caret.y;
    const bottom = caret.y + caret.h;
    if (top < viewTop) this.scrollTop = Math.max(0, top - this.theme.bodySize * 2);
    else if (bottom > viewBottom) this.scrollTop = bottom - this.host.clientHeight + this.theme.bodySize * 5;
  }

  // -- events ------------------------------------------------------------

  private attach(): void {
    const canvas = this.canvas;

    canvas.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.interacted = true;
      this.focus();
      const offset = this.offsetAt(e.clientX, e.clientY);
      if (e.shiftKey) this.moveTo(offset, true);
      else {
        this.selStart = this.selEnd = offset;
        this.preferredX = null;
        this.invalidate();
      }
      const move = (ev: MouseEvent) => {
        this.selEnd = this.offsetAt(ev.clientX, ev.clientY);
        this.invalidate();
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const max = Math.max(0, this.docHeight - this.host.clientHeight + this.theme.bodySize * 8);
      this.scrollTop = Math.max(0, Math.min(max, this.scrollTop + e.deltaY));
      this.schedule();
    }, { passive: false });

    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));

    // Composition: keep the in-progress text in the document so it is typeset
    // in place, which is what a CJK writer expects to see.
    this.input.addEventListener("compositionstart", () => {
      this.interacted = true;
      const lo = Math.min(this.selStart, this.selEnd);
      const hi = Math.max(this.selStart, this.selEnd);
      if (lo !== hi) this.replace(lo, hi, "");
      this.composing = { start: this.selEnd, length: 0 };
    });

    this.input.addEventListener("compositionupdate", (e) => {
      if (!this.composing) return;
      const data = (e as CompositionEvent).data ?? "";
      const { start, length } = this.composing;
      this.text = this.text.slice(0, start) + data + this.text.slice(start + length);
      this.composing = { start, length: data.length };
      this.selStart = this.selEnd = start + data.length;
      this.invalidate();
    });

    this.input.addEventListener("compositionend", (e) => {
      if (!this.composing) return;
      const data = (e as CompositionEvent).data ?? "";
      const { start, length } = this.composing;
      this.composing = null;
      // Rewind the provisional text, then apply the committed string as a
      // single undoable edit.
      this.text = this.text.slice(0, start) + this.text.slice(start + length);
      this.selStart = this.selEnd = start;
      this.input.value = "";
      if (data) this.insert(data, false);
      else this.invalidate();
    });

    this.input.addEventListener("input", () => {
      if (this.composing) return;
      this.interacted = true;
      const value = this.input.value;
      this.input.value = "";
      if (value) this.insert(value);
    });

    this.input.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text) this.insert(text, false);
    });

    this.input.addEventListener("copy", (e) => {
      e.preventDefault();
      const lo = Math.min(this.selStart, this.selEnd);
      const hi = Math.max(this.selStart, this.selEnd);
      e.clipboardData?.setData("text/plain", this.text.slice(lo, hi));
    });

    this.input.addEventListener("cut", (e) => {
      e.preventDefault();
      const lo = Math.min(this.selStart, this.selEnd);
      const hi = Math.max(this.selStart, this.selEnd);
      e.clipboardData?.setData("text/plain", this.text.slice(lo, hi));
      if (lo !== hi) this.replace(lo, hi, "");
    });

    this.input.addEventListener("blur", () => {
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
    if (this.composing) return;
    if (!e.metaKey && !e.ctrlKey) this.interacted = true;
    const mod = e.metaKey || e.ctrlKey;
    const lo = Math.min(this.selStart, this.selEnd);
    const hi = Math.max(this.selStart, this.selEnd);

    if (mod && e.key === "z") {
      e.preventDefault();
      e.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (mod && e.key === "a") {
      e.preventDefault();
      this.selStart = 0;
      this.selEnd = this.text.length;
      this.invalidate();
      return;
    }

    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        this.preferredX = null;
        this.moveTo(lo === hi ? this.stepBack(this.selEnd) : e.shiftKey ? this.stepBack(this.selEnd) : lo, e.shiftKey);
        return;
      case "ArrowRight":
        e.preventDefault();
        this.preferredX = null;
        this.moveTo(lo === hi ? this.stepForward(this.selEnd) : e.shiftKey ? this.stepForward(this.selEnd) : hi, e.shiftKey);
        return;
      case "ArrowUp":
        e.preventDefault();
        this.moveVertical(-1, e.shiftKey);
        return;
      case "ArrowDown":
        e.preventDefault();
        this.moveVertical(1, e.shiftKey);
        return;
      case "Home":
        e.preventDefault();
        this.moveTo(this.lineBounds(this.selEnd).start, e.shiftKey);
        return;
      case "End":
        e.preventDefault();
        this.moveTo(this.lineBounds(this.selEnd).end, e.shiftKey);
        return;
      case "Backspace":
        e.preventDefault();
        if (lo !== hi) this.replace(lo, hi, "");
        else if (lo > 0) this.replace(this.stepBack(lo), lo, "", true);
        return;
      case "Delete":
        e.preventDefault();
        if (lo !== hi) this.replace(lo, hi, "");
        else if (hi < this.text.length) this.replace(hi, this.stepForward(hi), "", true);
        return;
      case "Enter":
        e.preventDefault();
        this.insert("\n", false);
        return;
      case "Tab":
        e.preventDefault();
        this.insert("  ", false);
        return;
    }
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

export interface StatusInfo {
  chars: number;
  blocks: number;
  lines: number;
  layoutMs: number;
  measure: number;
  badness: number;
}
