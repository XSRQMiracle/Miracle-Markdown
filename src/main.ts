/**
 * Application entry point. Wires the engine, the editor and the small amount
 * of chrome around them.
 */

import { Editor, type StatusInfo } from "./editor/editor.js";
import { initEngine, type TypesetOptions } from "./engine/typeset.js";
import { SAMPLE } from "./sample.js";
import {
  finishDesktopClose,
  installDesktopCloseHandler,
  isDesktop,
  openDocument,
  openExternal,
  saveDocument,
} from "./platform.js";
import { DEFAULT_MATH_OPTIONS, initMath, type MathOptions } from "./engine/mathjax.js";
import { buildMathPanel } from "./ui/math-panel.js";
import { onImageSettled } from "./engine/images.js";
import { DocumentSession } from "./markdown/session.js";
import { confirmUnsavedDocument, showDocumentError } from "./ui/document-dialog.js";
import { buildFindBar } from "./ui/find-bar.js";

const stage = document.getElementById("stage") as HTMLElement;
const canvas = document.getElementById("surface") as HTMLCanvasElement;
const status = document.getElementById("status") as HTMLElement;
const perf = document.getElementById("perf") as HTMLElement;
const toggles = document.getElementById("toggles") as HTMLElement;
const sizeInput = document.getElementById("size") as HTMLInputElement;
const openButton = document.getElementById("open") as HTMLButtonElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const saveAsButton = document.getElementById("save-as") as HTMLButtonElement;
const columnInput = document.getElementById("column") as HTMLInputElement;

type ToggleKey = keyof Pick<
  TypesetOptions,
  "justify" | "cjkLatinSpacing" | "punctSqueeze" | "protrusion" | "hyphenate" | "showBadness"
>;

/** A toolbar switch, addressed either by a plain option or by its own pair of
 *  accessors when the option is nested. */
interface Toggle {
  label: string;
  hint: string;
  get(editor: Editor): boolean;
  set(editor: Editor, on: boolean): void;
}

const flag = (key: ToggleKey, label: string, hint: string): Toggle => ({
  label,
  hint,
  get: (editor) => editor.options[key],
  set: (editor, on) => editor.setOptions({ [key]: on } as Partial<TypesetOptions>),
});

const TOGGLE_DEFS: Array<{ key: ToggleKey; label: string; hint: string }> = [
  { key: "justify", label: "两端对齐", hint: "关闭后退回左对齐，断行仍然是全局最优的" },
  { key: "cjkLatinSpacing", label: "中西间距", hint: "汉字与拉丁字母之间的四分之一空格" },
  { key: "punctSqueeze", label: "标点挤压", hint: "全角标点让出空白的半个字身" },
  { key: "protrusion", label: "标点悬挂", hint: "行尾标点探出版心，让右边缘看起来笔直" },
  { key: "hyphenate", label: "西文连字", hint: "按 TeX 断词模式在词内断行" },
  { key: "showBadness", label: "劣度视图", hint: "把每行的拉伸量显色：暖色偏松，冷色偏紧" },
];

async function main() {
  // Editing starts only once both the session and its close guard are ready.
  stage.inert = true;
  await initEngine();

  const editor = new Editor(stage, canvas);
  editor.setText(SAMPLE);
  await editor.ready();

  const TOGGLES: Toggle[] = [
    ...TOGGLE_DEFS.map((t) => flag(t.key, t.label, t.hint)),
    {
      label: "中文软换行",
      hint:
        "源码里段落中间的换行，在中文上下文中不产生空格。CommonMark 规定换行等于一个空格，" +
        "这对以空格分词的文字是对的，对中文是错的——那个换行只是作者折行的方式。" +
        "关闭后回到 CommonMark 的字面行为。",
      get: (e) => e.options.inline.cjkSoftBreaks,
      set: (e, on) => e.setOptions({ inline: { ...e.options.inline, cjkSoftBreaks: on } }),
    },
  ];

  for (const t of TOGGLES) {
    const button = document.createElement("button");
    button.className = "toggle";
    button.textContent = t.label;
    button.title = t.hint;
    const sync = () => button.setAttribute("aria-pressed", String(t.get(editor)));
    sync();
    button.addEventListener("click", () => {
      t.set(editor, !t.get(editor));
      sync();
      editor.focus();
    });
    toggles.appendChild(button);
  }

  // ⌘/Ctrl-click on a link. The editor finds it; where it opens is the
  // host's business, and an unopenable one is simply left alone.
  editor.onFollowLink = (href) => void openExternal(href);

  // Decoding can change an image's reserved width and height. Register once
  // at startup so cached placeholder layouts are invalidated immediately.
  onImageSettled(() => editor.invalidateMath());

  let sessionReady = false;
  const syncSession = () => {
    document.title = `${session.dirty ? "• " : ""}${session.name} — Miracle Markdown`;
    openButton.disabled = session.transitioning || session.isClosing;
    saveButton.disabled = saveAsButton.disabled = session.isClosing;
    stage.inert = session.isClosing || !sessionReady;
  };
  const session = new DocumentSession({ path: null, contents: editor.getText(), lineEnding: "\n" }, {
    open: openDocument,
    save: saveDocument,
    confirmLeave: confirmUnsavedDocument,
    loaded: (document) => editor.setText(document.contents),
    changed: syncSession,
  });
  const fileAction = async (action: () => Promise<unknown>) => {
    if (session.isClosing) return;
    try { editor.finishComposition(); await action(); }
    catch (error) { await showDocumentError(error); }
    if (!session.isClosing) editor.focus();
  };
  openButton.addEventListener("click", () => void fileAction(() => session.open()));
  saveButton.addEventListener("click", () => void fileAction(() => session.save()));
  saveAsButton.addEventListener("click", () => void fileAction(() => session.save(true)));
  const findBar = buildFindBar(document.getElementById("find-bar") as HTMLElement, editor);
  window.addEventListener("keydown", (e) => {
    if (document.querySelector("dialog[open]")) return;
    // F3 and Shift+F3 step through the matches on Windows and Linux, where
    // they are the convention; Ctrl+H opens the bar with the replacement
    // field ready, as ⌥⌘F does on a Mac.
    if (e.key === "F3") {
      if (findBar.step(e.shiftKey)) e.preventDefault();
      return;
    }
    // Escape closes the search from anywhere, including the document itself,
    // which is where the caret is once a match has been stepped to.
    if (e.key === "Escape" && findBar.isOpen) {
      e.preventDefault();
      findBar.close();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === "s") {
      e.preventDefault();
      void fileAction(() => session.save(e.shiftKey));
    } else if (key === "f") {
      // ⌥⌘F opens the same bar with the replacement field ready, which is
      // where the platform puts "find and replace".
      e.preventDefault();
      findBar.open(editor.selectedText() || undefined, e.altKey);
    } else if (key === "h" && !e.metaKey) {
      e.preventDefault();
      findBar.open(editor.selectedText() || undefined, true);
    } else if (key === "g") {
      // ⌘G continues a search that is already running; with the bar closed
      // there is nothing to continue.
      if (findBar.step(e.shiftKey)) e.preventDefault();
    }
  });
  editor.onChange = () => {
    session.updateText(editor.getText());
    // Typing under an open search changes what it finds.
    findBar.refresh();
  };
  syncSession();
  if (isDesktop()) {
    let closePending = false;
    await installDesktopCloseHandler(() => {
      if (closePending) return;
      closePending = true;
      void fileAction(() => session.close(finishDesktopClose)).finally(() => { closePending = false; });
    });
  } else {
    window.addEventListener("beforeunload", (event) => {
      if (!session.needsUnloadProtection) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }
  sessionReady = true;
  syncSession();

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
    try {
      if (await initMath(mathOptions)) editor.invalidateMath();
    } catch (error) {
      editor.invalidateMath();
      throw error;
    }
  };
  void reloadMath().catch((error) => {
    console.error("MathJax initialization failed", error);
    document.getElementById("math-button")!.title = "公式引擎加载失败，可在公式设置中重试";
  });

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
