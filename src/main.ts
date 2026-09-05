/**
 * Application entry point. Wires the engine, the editor and the small amount
 * of chrome around them.
 */

import { Editor, type StatusInfo } from "./editor/editor.js";
import { initEngine, type TypesetOptions } from "./engine/typeset.js";
import { SAMPLE } from "./sample.js";
import { isDesktop, openDocument, saveDocument } from "./platform.js";
import { DEFAULT_MATH_OPTIONS, initMath, type MathOptions } from "./engine/mathjax.js";
import { buildMathPanel } from "./ui/math-panel.js";

const stage = document.getElementById("stage") as HTMLElement;
const canvas = document.getElementById("surface") as HTMLCanvasElement;
const status = document.getElementById("status") as HTMLElement;
const perf = document.getElementById("perf") as HTMLElement;
const toggles = document.getElementById("toggles") as HTMLElement;
const sizeInput = document.getElementById("size") as HTMLInputElement;
const openButton = document.getElementById("open") as HTMLButtonElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const columnInput = document.getElementById("column") as HTMLInputElement;

type ToggleKey = keyof Pick<
  TypesetOptions,
  "justify" | "cjkLatinSpacing" | "punctSqueeze" | "protrusion" | "hyphenate" | "showBadness"
>;

const TOGGLES: Array<{ key: ToggleKey; label: string; hint: string }> = [
  { key: "justify", label: "两端对齐", hint: "关闭后退回左对齐，断行仍然是全局最优的" },
  { key: "cjkLatinSpacing", label: "中西间距", hint: "汉字与拉丁字母之间的四分之一空格" },
  { key: "punctSqueeze", label: "标点挤压", hint: "全角标点让出空白的半个字身" },
  { key: "protrusion", label: "标点悬挂", hint: "行尾标点探出版心，让右边缘看起来笔直" },
  { key: "hyphenate", label: "西文连字", hint: "按 TeX 断词模式在词内断行" },
  { key: "showBadness", label: "劣度视图", hint: "把每行的拉伸量显色：暖色偏松，冷色偏紧" },
];

async function main() {
  await initEngine();

  const editor = new Editor(stage, canvas);
  editor.setText(SAMPLE);
  await editor.ready();

  for (const t of TOGGLES) {
    const button = document.createElement("button");
    button.className = "toggle";
    button.textContent = t.label;
    button.title = t.hint;
    const sync = () => button.setAttribute("aria-pressed", String(editor.options[t.key]));
    sync();
    button.addEventListener("click", () => {
      editor.setOptions({ [t.key]: !editor.options[t.key] } as Partial<TypesetOptions>);
      sync();
      editor.focus();
    });
    toggles.appendChild(button);
  }

  let path: string | null = null;
  let dirty = false;
  const setTitle = () => {
    const name = path ? path.split(/[\\/]/).pop() : "未命名";
    document.title = `${dirty ? "• " : ""}${name} — Miracle Markdown`;
  };

  openButton.addEventListener("click", async () => {
    const opened = await openDocument();
    if (!opened) return;
    editor.setText(opened.contents);
    path = opened.path;
    dirty = false;
    setTitle();
    editor.focus();
  });

  const save = async () => {
    const saved = await saveDocument(path, editor.getText());
    if (saved !== null) {
      path = saved;
      dirty = false;
      setTitle();
    }
  };
  saveButton.addEventListener("click", save);
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      void save();
    }
  });

  editor.onChange = () => {
    if (!dirty) {
      dirty = true;
      setTitle();
    }
  };
  setTitle();

  sizeInput.addEventListener("input", () => {
    editor.setTheme({ bodySize: Number(sizeInput.value) });
  });

  // Line length is its own decision now that it no longer rides on the type
  // size. Measured in characters it is the more meaningful of the two, so it
  // deserves its own control rather than being a side effect of another.
  columnInput.addEventListener("input", () => {
    editor.setTheme({ columnWidth: Number(columnInput.value) });
  });

  editor.onStatus = (info: StatusInfo) => {
    status.textContent =
      `${info.chars} 字符 · ${info.blocks} 块 · ${info.lines} 行 · ` +
      `版心 ${Math.round(info.measure)}px`;
    perf.innerHTML =
      `排版 <b>${info.layoutMs.toFixed(2)} ms</b> · 平均劣度 <b>${info.badness.toFixed(0)}</b>` +
      (isDesktop() ? "" : " · 浏览器预览");
  };

  // A handle for driving the editor from the console and from tests. Dev
  // builds only; `import.meta.env.DEV` is false in a production bundle.
  if (import.meta.env.DEV) {
    (window as unknown as { editor: Editor }).editor = editor;
  }

  // MathJax loads in the background. Until it arrives, formulas render as
  // their own source, which is the right thing to show anyway while one is
  // being typed; once it is ready the document re-typesets with real boxes.
  const mathOptions: MathOptions = { ...DEFAULT_MATH_OPTIONS };
  const reloadMath = async () => {
    await initMath(mathOptions);
    editor.invalidateMath();
  };
  void reloadMath();

  buildMathPanel(
    document.getElementById("math-panel") as HTMLElement,
    document.getElementById("math-button") as HTMLElement,
    editor,
    mathOptions,
    reloadMath,
  );

  editor.focus();
  window.addEventListener("resize", () => editor.invalidate());
  // Clicking anywhere in the page keeps focus on the editing surface.
  stage.addEventListener("mousedown", () => editor.focus());
}

main().catch((err) => {
  status.textContent = `启动失败：${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
