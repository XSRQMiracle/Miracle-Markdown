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

import type { LaidBlock } from "../engine/typeset.js";
import type { Theme } from "../engine/typeset.js";
import { cssFont } from "../engine/measure.js";

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
    this.canvas.width = Math.round(cssWidth * this.dpr);
    this.canvas.height = Math.round(cssHeight * this.dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.currentFont = "";
    this.currentFill = "";
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
    if (selection.length) {
      this.setFill("#cddcf0");
      for (const r of selection) ctx.fillRect(r.x, r.y, r.w, r.h);
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
          this.setFont(cssFont(run.style));
          this.setFill(run.style.color);
          const x = b.indent + line.indent * 0 + run.x;
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
  }

  /** Quote bars, code panels, rules and list bullets. */
  private drawDecoration(b: LaidBlock, theme: Theme, view: Viewport): void {
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

    if (type === "code") {
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

    if (type === "list" && b.marker && b.lines.length) {
      const style = b.lines[0].runs[0]?.style;
      if (!style) return;
      this.setFont(cssFont(style));
      this.setFill(theme.mutedColor);
      const w = ctx.measureText(b.marker).width;
      ctx.fillText(b.marker, b.indent - w - theme.bodySize * 0.45, b.y + b.lines[0].baseline);
    }
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
