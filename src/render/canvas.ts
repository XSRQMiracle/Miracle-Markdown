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
          const x = b.indent + line.indent * 0 + run.x;

          // A formula draws as outlines rather than text: MathJax laid it out,
          // we own where it goes. One fill call, whatever its complexity.
          if (run.math) {
            this.drawMath(run, x, y, theme);
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
  }

  /**
   * Draw a formula.
   *
   * The outlines arrive in the SVG's own units with the baseline at the
   * origin, so placing them is a translate to the baseline and a uniform
   * scale. When the formula did not parse we fall back to its source, which
   * is the honest thing to show while it is still being typed.
   */
  private drawMath(run: LaidRun, x: number, baseline: number, theme: Theme): void {
    const math = run.math!;
    const ctx = this.ctx;

    // A split formula draws its own piece; each carries outlines already
    // shifted so its left edge is the origin.
    const path = math.segment ? math.segment.path : math.geometry.path;
    const commands = math.segment ? math.segment.commands : math.geometry.commands;

    if ((!path && !commands?.length) || math.geometry.error) {
      // Show the LaTeX itself, tinted, rather than a gap or a broken glyph.
      // A piece of a split formula has no sensible source of its own, so only
      // the first one speaks for the whole.
      if (math.segment && math.segment.path === null) return;
      const text = math.source || "…";
      this.setFont(cssFont({ ...run.style, italic: false, family: theme.monoFamily }));
      this.setFill(math.geometry.error === "loading" ? theme.mutedColor : "#b3402f");
      ctx.fillText(text, x, baseline);
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
