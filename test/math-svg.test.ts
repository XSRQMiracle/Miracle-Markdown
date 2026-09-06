// MathJax emits more than glyph paths: enclosures and table rules are
// strokes, colour is inherited, and characters missing from its outline font
// arrive as SVG text. These tests exercise the paint display list without a
// browser by supplying the small DOM and Path2D surface the walker needs.
import {
  geometryFromSvg,
  segmentInlineMath,
  type MathDrawCommand,
  type Matrix,
} from "../src/engine/math.js";
import { Renderer } from "../src/render/canvas.js";

let failures = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.log(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

class RecordingPath2D {
  readonly operations: unknown[] = [];

  constructor(source?: string | RecordingPath2D) {
    if (source !== undefined) this.operations.push(["source", source]);
  }

  addPath(path: RecordingPath2D, transform?: DOMMatrix2DInit): void {
    this.operations.push(["addPath", path, transform]);
  }
  rect(...args: number[]): void { this.operations.push(["rect", ...args]); }
  moveTo(...args: number[]): void { this.operations.push(["moveTo", ...args]); }
  lineTo(...args: number[]): void { this.operations.push(["lineTo", ...args]); }
  quadraticCurveTo(...args: number[]): void { this.operations.push(["quadraticCurveTo", ...args]); }
  closePath(): void { this.operations.push(["closePath"]); }
  ellipse(...args: number[]): void { this.operations.push(["ellipse", ...args]); }
}

(globalThis as unknown as { Path2D: typeof RecordingPath2D }).Path2D = RecordingPath2D;

class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[];
  parentElement: FakeElement | null = null;
  readonly textContent: string;
  private readonly attrs: Record<string, string>;

  constructor(
    tagName: string,
    attrs: Record<string, string> = {},
    children: FakeElement[] = [],
    text = "",
  ) {
    this.tagName = tagName;
    this.attrs = attrs;
    this.children = children;
    this.textContent = text || children.map((child) => child.textContent).join("");
    for (const child of children) child.parentElement = this;
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  querySelector(selector: string): FakeElement | null {
    const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    const found = (node: FakeElement): boolean => {
      if (!match) return false;
      const value = node.getAttribute(match[1]);
      return value !== null && (match[2] === undefined || value === match[2]);
    };
    for (const child of this.children) {
      if (found(child)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

const element = (
  tag: string,
  attrs: Record<string, string> = {},
  children: FakeElement[] = [],
  text = "",
): FakeElement => new FakeElement(tag, attrs, children, text);

const glyph = (code: string, d = "M0 0L20 0L20 20Z"): FakeElement =>
  element("path", { "data-c": code, d });

const rootGroup = element(
  "g",
  { stroke: "currentColor", fill: "currentColor", "stroke-width": "0", transform: "scale(1,-1)" },
  [
    glyph("1D465"),
    element("g", { fill: "red", stroke: "red" }, [glyph("1D466")]),
    glyph("1D467"),
    element("g", { color: "#087f5b", fill: "currentColor", stroke: "currentColor" }, [
      element("g", { color: "currentColor" }, [glyph("1D468")]),
    ]),
    element("clipPath", {}, [glyph("DEAD")]),
    element("rect", {
      x: "33.5",
      y: "-244.5",
      width: "1039",
      height: "920",
      fill: "none",
      "stroke-width": "67",
    }),
    element("line", {
      x1: "33.5",
      y1: "-244.5",
      x2: "1072.5",
      y2: "675.5",
      "stroke-width": "67",
    }),
    element("line", {
      "data-line": "v",
      class: "mjx-solid",
      stroke: "none",
      x1: "1064",
      y1: "-950",
      x2: "1064",
      y2: "1450",
    }),
    element("polygon", { points: "0,0 40,0 40,10 0,10", fill: "#ff0", stroke: "none" }),
    element(
      "text",
      { transform: "scale(1,-1)", "font-size": "884px", "font-family": "serif" },
      [],
      "😀",
    ),
  ],
);
const svg = element(
  "svg",
  { viewBox: "0 -950 3000 2400", width: "6ex", height: "3ex", style: "vertical-align: -0.5ex" },
  [rootGroup],
) as unknown as SVGSVGElement;

const geometry = geometryFromSvg(svg);
const commands = geometry.commands ?? [];
const paths = commands.filter((command) => command.kind === "path");
const texts = commands.filter((command) => command.kind === "text");

eq(geometry.path !== null, true, "the legacy aggregate path remains available");
eq(paths.slice(0, 3).map((command) => command.fill), ["currentColor", "red", "currentColor"], "colour inherits and restores in paint order");
eq(paths.slice(0, 3).map((command) => command.stroke), ["currentColor", "red", "currentColor"], "stroke colour inherits independently");
eq([paths[3].fill, paths[3].stroke], ["#087f5b", "#087f5b"], "color: currentColor keeps the concrete inherited colour");
eq(paths.some((command) => (command.path as unknown as RecordingPath2D).operations.some((operation) => JSON.stringify(operation).includes("DEAD"))), false, "clipPath definitions are not painted");

const box = paths.find((command) => command.source === "rect")!;
eq([box.fill, box.stroke, box.strokeWidth], [null, "currentColor", 67], "boxed is an outlined rectangle, not a solid fill");

const lines = paths.filter((command) => command.source === "line");
eq([lines[0].fill, lines[0].stroke, lines[0].strokeWidth], [null, "currentColor", 67], "cancel line keeps its inherited stroke");
eq([lines[1].fill, lines[1].stroke, lines[1].strokeWidth], [null, "currentColor", 70], "MathJax table rule recovers its stylesheet paint and width");

const polygon = paths.find((command) => command.source === "polygon")!;
eq([polygon.fill, polygon.stroke], ["#ff0", null], "colour-box polygon keeps independent fill and stroke");

eq(texts.length, 1, "unknown Unicode glyph becomes one text command");
eq([texts[0].text, texts[0].fontFamily, texts[0].fontSize], ["😀", "serif", 884], "Unicode and its SVG font survive intact");
eq(texts[0].transform, [1, 0, 0, 1, 0, 0] satisfies Matrix, "the root and text y-axis flips cancel");

// The same walker is used when an inline formula is split at a top-level
// operator. Its second segment deliberately contains only SVG text.
{
  const math = element("g", { "data-mml-node": "math" }, [
    element("g", { "data-mml-node": "mi", transform: "translate(0,0)" }, [glyph("1D465")]),
    element(
      "g",
      { "data-mml-node": "mo", "data-mjx-texclass": "BIN", transform: "translate(500,0)" },
      [glyph("2B")],
    ),
    element("g", { "data-mml-node": "mi", transform: "translate(1000,0)" }, [
      element(
        "text",
        { transform: "scale(1,-1)", "font-size": "884px", "font-family": "serif" },
        [],
        "😀",
      ),
    ]),
  ]);
  const segmentedSvg = element("svg", { viewBox: "0 -750 1500 950" }, [
    element(
      "g",
      { stroke: "currentColor", fill: "currentColor", "stroke-width": "0", transform: "scale(1,-1)" },
      [math],
    ),
  ]) as unknown as SVGSVGElement;
  const segments = segmentInlineMath(segmentedSvg, 1500);
  eq(segments.length, 2, "a binary operator still splits inline math");
  eq(segments[0].commands?.filter((command) => command.kind === "path").length, 2, "the first segment keeps both outlines");
  eq(segments[1].path, null, "a text-only segment has no fake aggregate outline");
  eq(segments[1].commands?.[0].kind, "text", "a text-only segment remains drawable");
}

interface PaintEvent {
  op: string;
  color?: string;
  width?: number;
  text?: string;
}

class RecordingContext {
  fillStyle: string | CanvasGradient | CanvasPattern = "black";
  strokeStyle: string | CanvasGradient | CanvasPattern = "black";
  globalAlpha = 1;
  lineWidth = 1;
  lineCap: CanvasLineCap = "butt";
  lineJoin: CanvasLineJoin = "miter";
  miterLimit = 4;
  lineDashOffset = 0;
  font = "";
  textAlign: CanvasTextAlign = "left";
  textBaseline: CanvasTextBaseline = "alphabetic";
  readonly events: PaintEvent[] = [];

  save(): void {}
  restore(): void {}
  transform(): void {}
  setLineDash(): void {}
  fill(): void { this.events.push({ op: "fill", color: String(this.fillStyle) }); }
  stroke(): void { this.events.push({ op: "stroke", color: String(this.strokeStyle), width: this.lineWidth }); }
  fillText(text: string): void { this.events.push({ op: "fillText", color: String(this.fillStyle), text }); }
  strokeText(text: string): void { this.events.push({ op: "strokeText", color: String(this.strokeStyle), width: this.lineWidth, text }); }
}

{
  const context = new RecordingContext();
  const replay = (Renderer.prototype as unknown as {
    drawMathCommands(this: { ctx: RecordingContext }, list: readonly MathDrawCommand[], color: string): void;
  }).drawMathCommands;
  replay.call({ ctx: context }, commands, "#123456");
  const strokes = context.events.filter((event) => event.op === "stroke");
  eq(strokes.some((event) => event.width === 67 && event.color === "#123456"), true, "canvas strokes the cancel/box in the run colour");
  eq(strokes.some((event) => event.width === 70), true, "canvas paints the table separator");
  eq(context.events.some((event) => event.op === "fill" && event.color === "red"), true, "canvas paints explicit formula colours");
  eq(context.events.some((event) => event.op === "fillText" && event.text === "😀"), true, "canvas draws Unicode text rather than dropping it");
}

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
