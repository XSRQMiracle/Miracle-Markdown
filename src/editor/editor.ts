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
import { sourceRangeOwnsPosition, type BlockType } from "../markdown/parse.js";
import { normalizeLineEndings } from "../markdown/document.js";
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

type CaretAffinity = "upstream" | "downstream";
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
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastEditAt = -Infinity;

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
  /** Fires after every text change, including undo/redo and IME updates. */
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
    );
    this.blocks = result.blocks;
    this.docHeight = result.height;
    this.lastLayoutMs = performance.now() - t0;
    this.dirty = false;
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

  private undo(): void {
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

  private redo(): void {
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
    this.lastEditAt = -Infinity;
    this.selEnd = Math.max(0, Math.min(this.text.length, offset));
    this.caretAffinity = affinity;
    if (!extend) this.selStart = this.selEnd;
    this.caretVisible = true;
    this.invalidate();
    // Reveal the target block before measuring where its caret must scroll.
    this.scrollCaretIntoView();
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
    const viewTop = this.scrollTop;
    const viewBottom = this.scrollTop + this.host.clientHeight - this.theme.bodySize * 4;
    const top = caret.y;
    const bottom = caret.y + caret.h;
    if (top < viewTop) this.scrollTop = Math.max(0, top - this.theme.bodySize * 2);
    else if (bottom > viewBottom) this.scrollTop = bottom - this.host.clientHeight + this.theme.bodySize * 5;
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
      this.finishComposition();
      this.interacted = true;
      this.focus();
      const position = this.positionAt(e.clientX, e.clientY);
      this.preferredX = null;
      this.moveTo(position.offset, e.shiftKey, position.affinity);
      const move = (ev: MouseEvent) => {
        const position = this.positionAt(ev.clientX, ev.clientY);
        this.moveTo(position.offset, true, position.affinity);
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
      if (value) this.insert(value);
    });

    this.input.addEventListener("paste", (e) => {
      e.preventDefault();
      this.finishComposition();
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
      this.finishComposition();
      const lo = Math.min(this.selStart, this.selEnd);
      const hi = Math.max(this.selStart, this.selEnd);
      e.clipboardData?.setData("text/plain", this.text.slice(lo, hi));
      if (lo !== hi) this.replace(lo, hi, "");
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
    const mod = e.metaKey || e.ctrlKey;
    const lo = Math.min(this.selStart, this.selEnd);
    const hi = Math.max(this.selStart, this.selEnd);

    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (mod && e.key === "a") {
      e.preventDefault();
      this.lastEditAt = -Infinity;
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
        this.preferredX = null;
        this.moveTo(this.lineBounds(this.selEnd).start, e.shiftKey);
        return;
      case "End":
        e.preventDefault();
        this.preferredX = null;
        this.moveTo(this.lineBounds(this.selEnd).end, e.shiftKey, "upstream");
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
        this.insert(e.shiftKey ? this.hardBreak() : "\n", false);
        return;
      case "Tab":
        e.preventDefault();
        this.insert("  ", false);
        return;
    }
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
    const type = this.blockTypeAtCaret();
    const verbatim: BlockType[] = ["code", "frontmatter", "html", "math", "table"];
    if (type && verbatim.includes(type)) return "\n";

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

  /** The kind of block the caret sits in, by the same ownership rule as
   *  `locate` — a shared boundary belongs to the block that follows. */
  private blockTypeAtCaret(): BlockType | null {
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      if (sourceRangeOwnsPosition(b.block, this.blocks[i + 1]?.block, this.selEnd)) {
        return b.block.type;
      }
    }
    return null;
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
