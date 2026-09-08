/**
 * Canvas rendering.
 *
 * Positions come from the engine; rasterisation is left to the platform. That
 * split matters: the positions are where all the typographic quality lives,
 * and the rasteriser is where all the crispness lives. Drawing glyphs
 * ourselves would win nothing and would cost ClearType on Windows.
 *
 * Latin words are drawn whole so kerning and ligatures survive inside them;
 * CJK glyphs are drawn one at a time, which is what lets punctuation squeeze
 * and hang. Measured at 45 lines of mixed text, that costs about a third of a
 * millisecond per frame.
 */

import type { LaidBlock, LaidRun, Theme } from "../engine/typeset.js";
import { cssFont } from "../engine/measure.js";
import type { MathDrawCommand } from "../engine/math.js";

export interface Viewport {
  scrollTop: number;
  width: number;
  height: number;
  /** Left edge of the text column. */
  originX: number;
  /** Top padding above the first block. */
  originY: number;
}

export interface SelectionRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Paint colour, for the bands that mark something other than a selection. */
  color?: string;
}

/**
 * Where a task list's checkbox is drawn.
 *
 * Shared with the editor so that clicking the box and painting it cannot
 * disagree about where it is.
 */
export function checkboxRect(
  b: LaidBlock,
  size: number,
  baseline: number,
  theme: Theme,
): SelectionRect {
  const box = size * 0.72;
  return {
    // Sit the box on the text's optical centre rather than its baseline.
    x: b.indent - box - theme.bodySize * 0.45,
    y: baseline - box * 0.92,
    w: box,
    h: box,
  };
}

/** The selection's own colour, and the one search matches are marked in. */
export const SELECTION_COLOR = "#cddcf0";
export const MATCH_COLOR = "#f6e3a1";

/**
 * The scrollbar, in viewport coordinates.
 *
 * It is painted rather than built from an element for the same reason the
 * text is: the geometry is ours, and a DOM scrollbar would have to be kept in
 * step with a document height only the typesetter knows.
 */
export interface Scrollbar {
  /** Right edge of the canvas to the left edge of the track. */
  width: number;
  y: number;
  h: number;
  /** Pointer on it, or dragging it. */
  active: boolean;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private currentFont = "";
  private currentFill = "";

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas is unavailable");
    this.ctx = ctx;
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.dpr = window.devicePixelRatio || 1;
    const width = Math.round(cssWidth * this.dpr);
    const height = Math.round(cssHeight * this.dpr);
    // Setting either dimension reallocates and clears the backing store and
    // resets all context state, even when the assigned value is unchanged.
    if (this.canvas.width !== width || this.canvas.height !== height) {
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      this.currentFont = "";
      this.currentFill = "";
    }
    if (this.canvas.style.width !== `${cssWidth}px`) this.canvas.style.width = `${cssWidth}px`;
    if (this.canvas.style.height !== `${cssHeight}px`) this.canvas.style.height = `${cssHeight}px`;
  }

  private setFont(font: string): void {
    if (font !== this.currentFont) {
      this.ctx.font = font;
      this.currentFont = font;
    }
  }

  private setFill(color: string): void {
    if (color !== this.currentFill) {
      this.ctx.fillStyle = color;
      this.currentFill = color;
    }
  }

  draw(
    blocks: LaidBlock[],
    view: Viewport,
    theme: Theme,
    selection: SelectionRect[],
    caret: SelectionRect | null,
    caretVisible: boolean,
    showBadness: boolean,
    scrollbar: Scrollbar | null = null,
  ): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.textBaseline = "alphabetic";

    ctx.fillStyle = "#fdfdfb";
    this.currentFill = "#fdfdfb";
    ctx.fillRect(0, 0, view.width, view.height);

    ctx.translate(view.originX, view.originY - view.scrollTop);

    // Selection sits under the text so glyphs stay legible on top of it.
    for (const r of selection) {
      this.setFill(r.color ?? SELECTION_COLOR);
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }

    const top = view.scrollTop - view.originY;
    const bottom = top + view.height;

    for (const b of blocks) {
      // Only what is on screen is drawn; layout of off-screen blocks is
      // cached but never rasterised.
      if (b.y + b.height < top - 200) continue;
      if (b.y > bottom + 200) break;

      this.drawDecoration(b, theme, view);

      for (const line of b.lines) {
        const y = b.y + line.baseline;
        if (y < top - 100 || y > bottom + 100) continue;

        if (showBadness) this.drawBadness(b, line, y, theme);

        for (const run of line.runs) {
          const x = b.indent + line.indent * 0 + run.x;

          // A formula draws as outlines rather than text: MathJax laid it out,
          // we own where it goes. One fill call, whatever its complexity.
          if (run.note) {
            this.setFont(cssFont(run.note.style));
            this.setFill(run.style.color);
            ctx.fillText(run.note.text, x, y - run.note.raise);
            continue;
          }

          if (run.image) {
            this.drawImage(run, x, y);
            continue;
          }

          if (run.math) {
            this.drawMath(run, x, y);
            continue;
          }

          this.setFont(cssFont(run.style));
          this.setFill(run.style.color);
          if (run.scaleX !== 1) {
            ctx.save();
            ctx.translate(x, y);
            ctx.scale(run.scaleX, 1);
            ctx.fillText(run.text, 0, 0);
            ctx.restore();
          } else {
            ctx.fillText(run.text, x, y);
          }
          if (run.style.color === theme.accentColor) {
            // Underline links along their own baseline rather than with a
            // CSS-style box, so the rule sits where the type wants it.
            const w = ctx.measureText(run.text).width * run.scaleX;
            ctx.fillRect(x, y + run.style.size * 0.13, w, Math.max(1, run.style.size / 20));
          }
        }
      }
    }

    if (caret && caretVisible) {
      this.setFill(theme.color);
      ctx.fillRect(caret.x, caret.y, Math.max(1.5, 1.5), caret.h);
    }

    ctx.restore();

    // Outside the page translation: the scrollbar belongs to the window.
    if (scrollbar) {
      ctx.save();
      ctx.scale(this.dpr, this.dpr);
      const w = scrollbar.active ? 7 : 5;
      const x = view.width - scrollbar.width + (scrollbar.width - w) / 2;
      ctx.fillStyle = scrollbar.active ? "rgba(40, 38, 34, 0.42)" : "rgba(40, 38, 34, 0.2)";
      const r = w / 2;
      ctx.beginPath();
      ctx.roundRect(x, scrollbar.y, w, scrollbar.h, r);
      ctx.fill();
      ctx.restore();
    }

    // The frame's restore also restores font/fill, whereas the memoized
    // values describe the last run we painted. Start the next frame fresh.
    this.currentFont = "";
    this.currentFill = "";
  }

  /**
   * Draw a formula.
   *
   * The outlines arrive in the SVG's own units with the baseline at the
   * origin, so placing them is a translate to the baseline and a uniform
   * scale. When the formula did not parse we fall back to its source, which
   * is the honest thing to show while it is still being typed.
   */
  private drawMath(run: LaidRun, x: number, baseline: number): void {
    const math = run.math!;
    const ctx = this.ctx;

    // A split formula draws its own piece; each carries outlines already
    // shifted so its left edge is the origin.
    const path = math.segment ? math.segment.path : math.geometry.path;
    const commands = math.segment ? math.segment.commands : math.geometry.commands;

    if (math.fallback) {
      // The typesetter already selected and measured this presentation.
      // Choosing a different string or font here would invalidate its box.
      this.setFont(cssFont(math.fallback.style));
      this.setFill(math.fallback.style.color);
      ctx.save();
      ctx.translate(x, baseline);
      ctx.scale(run.scaleX, 1);
      ctx.fillText(math.fallback.text, 0, 0);
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.translate(x, baseline);
    ctx.scale(math.scale * run.scaleX, math.scale);
    if (commands?.length) {
      this.drawMathCommands(commands, run.style.color);
    } else if (path) {
      // Compatibility for geometries cached by the original, single-path
      // representation.
      ctx.fillStyle = run.style.color;
      ctx.fill(path);
    }
    ctx.restore();
    this.currentFill = "";
  }

  /** Replay one MathJax SVG display list in document paint order. */
  private drawMathCommands(commands: readonly MathDrawCommand[], currentColor: string): void {
    const ctx = this.ctx;
    const color = (value: string): string =>
      value.toLowerCase() === "currentcolor" ? currentColor : value;

    for (const command of commands) {
      ctx.save();
      const [a, b, c, d, e, f] = command.transform;
      ctx.transform(a, b, c, d, e, f);

      if (command.kind === "text") {
        ctx.font = `${command.fontStyle} ${command.fontWeight} ${command.fontSize}px ${command.fontFamily}`;
        ctx.textAlign =
          command.textAnchor === "middle"
            ? "center"
            : command.textAnchor === "end"
              ? "right"
              : "left";
        ctx.textBaseline = "alphabetic";
        if (command.fill && command.opacity * command.fillOpacity > 0) {
          ctx.fillStyle = color(command.fill);
          ctx.globalAlpha = command.opacity * command.fillOpacity;
          ctx.fillText(command.text, command.x, command.y);
        }
        if (
          command.stroke &&
          command.strokeWidth > 0 &&
          command.opacity * command.strokeOpacity > 0
        ) {
          ctx.strokeStyle = color(command.stroke);
          ctx.lineWidth = command.strokeWidth;
          ctx.globalAlpha = command.opacity * command.strokeOpacity;
          ctx.strokeText(command.text, command.x, command.y);
        }
        ctx.restore();
        continue;
      }

      ctx.lineWidth = command.strokeWidth;
      ctx.lineCap = command.lineCap;
      ctx.lineJoin = command.lineJoin;
      ctx.miterLimit = command.miterLimit;
      ctx.setLineDash(command.lineDash);
      ctx.lineDashOffset = command.lineDashOffset;
      if (command.fill && command.opacity * command.fillOpacity > 0) {
        ctx.fillStyle = color(command.fill);
        ctx.globalAlpha = command.opacity * command.fillOpacity;
        ctx.fill(command.path, command.fillRule);
      }
      if (
        command.stroke &&
        command.strokeWidth > 0 &&
        command.opacity * command.strokeOpacity > 0
      ) {
        ctx.strokeStyle = color(command.stroke);
        ctx.globalAlpha = command.opacity * command.strokeOpacity;
        ctx.stroke(command.path);
      }
      ctx.restore();
    }
  }

  /** Quote bars, code panels, rules and list bullets. */
  private drawDecoration(b: LaidBlock, theme: Theme, view: Viewport): void {
    if (b.raw) return;
    const ctx = this.ctx;
    const type = b.block.type;

    if (type === "rule") {
      this.setFill(theme.ruleColor);
      ctx.fillRect(0, b.y + b.height * 0.4, view.width - view.originX * 2, 1);
      return;
    }

    if (type === "quote") {
      this.setFill(theme.ruleColor);
      const h = b.height - b.spaceBefore;
      ctx.fillRect(0, b.y, 3, h);
      return;
    }

    if (type === "code" || type === "frontmatter" || type === "html") {
      this.setFill(theme.codeBackground);
      const pad = theme.bodySize * 0.5;
      ctx.fillRect(
        -pad,
        b.y - pad * 0.6,
        view.width - view.originX * 2 + pad * 2,
        b.height - b.spaceBefore + pad * 1.2,
      );
      return;
    }

    if (type === "footnote" && b.note && b.lines.length) {
      // The number sits in the margin the definition's text was indented for,
      // so a note reads as an aside rather than as another paragraph.
      const line = b.lines[0];
      this.setFont(cssFont(b.note.style));
      this.setFill(theme.mutedColor);
      ctx.fillText(b.note.text, b.indent, b.y + line.baseline - b.note.raise);
      return;
    }

    if (type === "table" && b.table && b.lines.length) {
      // Booktabs' rules rather than a grid: a heavy rule above and below, a
      // light one under the header, and nothing vertical. A ruled box makes
      // the reader trace lines instead of reading rows.
      const table = b.table;
      const width = table.x[table.columns - 1] + table.widths[table.columns - 1];
      const top = b.y + b.lines[0].baseline - b.lines[0].height - theme.bodySize * 0.35;
      const last = b.lines[b.lines.length - 1];
      const bottom = b.y + last.baseline + last.depth + theme.bodySize * 0.3;

      this.setFill(theme.color);
      ctx.fillRect(b.indent, top, width, 1);
      ctx.fillRect(b.indent, bottom, width, 1);

      const headerEnd = table.rowStarts[1];
      if (headerEnd !== undefined && headerEnd > 0) {
        const line = b.lines[headerEnd - 1];
        this.setFill(theme.ruleColor);
        ctx.fillRect(
          b.indent,
          b.y + line.baseline + line.depth + theme.bodySize * 0.28,
          width,
          1,
        );
      }
      return;
    }

    if (type === "list" && b.lines.length) {
      const style = b.lines[0].runs[0]?.style;
      if (!style) return;
      const baseline = b.y + b.lines[0].baseline;
      if (b.block.task !== "none") {
        this.drawCheckbox(b, style.size, baseline, b.block.task === "done", theme);
        return;
      }
      if (!b.marker) return;
      this.setFont(cssFont(style));
      this.setFill(theme.mutedColor);
      const w = ctx.measureText(b.marker).width;
      ctx.fillText(b.marker, b.indent - w - theme.bodySize * 0.45, baseline);
    }
  }

  /**
   * Draw a picture.
   *
   * The box sits on the baseline, as a browser places an inline image, so the
   * line above is never encroached upon. Until the file has decoded there is
   * nothing to draw but its alt text, which is what the typesetter measured.
   */
  private drawImage(run: LaidRun, x: number, baseline: number): void {
    const image = run.image!;
    const ctx = this.ctx;

    if (!image.source || image.status !== "ready") {
      const fallback = image.fallback;
      if (!fallback) return;
      this.setFont(cssFont(fallback.style));
      this.setFill(image.status === "error" ? "#b3402f" : fallback.style.color);
      ctx.fillText(fallback.text, x, baseline);
      return;
    }

    ctx.drawImage(image.source, x, baseline - image.height, image.width, image.height);
  }

  /**
   * A task list's checkbox.
   *
   * Drawn rather than typeset: the obvious alternative is a ballot-box
   * character, but whether a font has one — and how it is sized against the
   * surrounding text — varies enough that the box would sometimes be missing
   * and usually be the wrong weight. A rectangle is the same everywhere.
   */
  private drawCheckbox(
    b: LaidBlock,
    size: number,
    baseline: number,
    done: boolean,
    theme: Theme,
  ): void {
    const ctx = this.ctx;
    const { x: left, y: top, w: box } = checkboxRect(b, size, baseline, theme);
    const stroke = Math.max(1, size / 14);

    ctx.save();
    ctx.strokeStyle = done ? theme.accentColor : theme.mutedColor;
    ctx.lineWidth = stroke;
    ctx.beginPath();
    // Half-pixel offsets keep a thin rule from straddling two device pixels.
    const snap = stroke / 2;
    ctx.rect(left + snap, top + snap, box - stroke, box - stroke);
    ctx.stroke();

    if (done) {
      ctx.strokeStyle = theme.accentColor;
      ctx.lineWidth = Math.max(1.4, size / 9);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(left + box * 0.22, top + box * 0.52);
      ctx.lineTo(left + box * 0.43, top + box * 0.73);
      ctx.lineTo(left + box * 0.79, top + box * 0.27);
      ctx.stroke();
    }
    ctx.restore();
    this.currentFill = "";
  }

  /**
   * Debug overlay: tint each line by how far its glue had to stretch. Loose
   * lines run warm, tight lines cool. Useful for seeing at a glance what the
   * optimiser traded away.
   */
  private drawBadness(b: LaidBlock, line: { ratio: number; width: number }, y: number, theme: Theme): void {
    const r = line.ratio;
    if (!isFinite(r) || r === 0) return;
    const t = Math.min(Math.abs(r), 2) / 2;
    const color = r > 0 ? `rgba(220,120,40,${0.10 + t * 0.22})` : `rgba(50,120,220,${0.10 + t * 0.22})`;
    this.setFill(color);
    this.ctx.fillRect(b.indent, y - theme.bodySize * 0.85, line.width, theme.bodySize * 1.1);
  }
}
