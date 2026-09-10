/**
 * The typography popover.
 *
 * Seven switches and two sliders that used to spend the whole toolbar. They
 * are read rarely and changed rarely, so they belong behind a trigger — but
 * they are not preferences either, which is why they are here on the status
 * bar next to the numbers they change, and not in the preferences window.
 */

import type { Editor } from "../editor/editor.js";
import type { TypesetOptions } from "../engine/typeset.js";

type ToggleKey = keyof Pick<
  TypesetOptions,
  "justify" | "cjkLatinSpacing" | "punctSqueeze" | "protrusion" | "hyphenate" | "showBadness"
>;

/** A switch, addressed either by a plain option or by its own pair of
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

const TOGGLES: Toggle[] = [
  flag("justify", "两端对齐", "关闭后退回左对齐，断行仍然是全局最优的"),
  flag("cjkLatinSpacing", "中西间距", "汉字与拉丁字母之间的四分之一空格"),
  flag("punctSqueeze", "标点挤压", "全角标点让出空白的半个字身"),
  flag("protrusion", "标点悬挂", "行尾标点探出版心，让右边缘看起来笔直"),
  flag("hyphenate", "西文连字", "按 TeX 断词模式在词内断行"),
  flag("showBadness", "劣度视图", "把每行的拉伸量显色：暖色偏松，冷色偏紧"),
  {
    label: "智能标点",
    hint:
      "键盘上只有一个竖直引号和一个连字符，而排版需要区分它们。开启后输入时直接替换为" +
      "成对的引号、短破折号（--）、长破折号（---）和省略号（…）。代码块与公式中不做替换。",
    get: (e) => e.editing.smartPunctuation,
    set: (e, on) => e.setEditing({ smartPunctuation: on }),
  },
];

export interface TypographyPopover {
  toggle(): void;
  close(): void;
  readonly isOpen: boolean;
  /** Pull every control back into step with the editor — after a keyboard
   *  shortcut has changed one of them behind the popover's back. */
  sync(): void;
}

export interface TypographyOptions {
  popover: HTMLElement;
  trigger: HTMLElement;
  caret: HTMLElement;
  chips: HTMLElement;
  size: HTMLInputElement;
  sizeValue: HTMLElement;
  column: HTMLInputElement;
  columnValue: HTMLElement;
  editor: Editor;
}

export function buildTypographyPopover(options: TypographyOptions): TypographyPopover {
  const { popover, trigger, caret, chips, size, sizeValue, column, columnValue, editor } = options;
  const syncers: Array<() => void> = [];

  for (const toggle of TOGGLES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = toggle.label;
    chip.title = toggle.hint;
    const sync = () => chip.setAttribute("aria-pressed", String(toggle.get(editor)));
    sync();
    syncers.push(sync);
    chip.addEventListener("click", () => {
      toggle.set(editor, !toggle.get(editor));
      sync();
      editor.focus();
    });
    chips.appendChild(chip);
  }

  /** The track paints how far along the value is, so it needs the fraction. */
  const paint = (input: HTMLInputElement, readout: HTMLElement): void => {
    const min = Number(input.min);
    const max = Number(input.max);
    const at = max > min ? (Number(input.value) - min) / (max - min) : 0;
    input.style.setProperty("--fill", `${(at * 100).toFixed(2)}%`);
    readout.textContent = input.value;
  };

  const syncSliders = (): void => {
    size.value = String(editor.theme.bodySize);
    column.value = String(editor.theme.columnWidth);
    paint(size, sizeValue);
    paint(column, columnValue);
  };
  syncSliders();
  syncers.push(syncSliders);

  size.addEventListener("input", () => {
    editor.setTheme({ bodySize: Number(size.value) });
    paint(size, sizeValue);
  });
  column.addEventListener("input", () => {
    editor.setTheme({ columnWidth: Number(column.value) });
    paint(column, columnValue);
  });

  const sync = (): void => {
    for (const s of syncers) s();
  };

  const setOpen = (open: boolean): void => {
    popover.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    caret.textContent = open ? "▴" : "▾";
    if (open) sync();
  };

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(popover.hidden);
  });
  // Clicking inside must not count as clicking away.
  popover.addEventListener("mousedown", (e) => e.stopPropagation());
  document.addEventListener("mousedown", (e) => {
    if (popover.hidden) return;
    // Nor does clicking the trigger. `mousedown` runs before `click`, and the
    // trigger sits in the status bar rather than inside the popover — so
    // dismissing here would close the popover and let the trigger's own
    // `click` see it already hidden and open it straight back up. Pressing 排版
    // to put it away did nothing at all.
    if (e.target instanceof Node && trigger.contains(e.target)) return;
    setOpen(false);
  });

  return {
    toggle: () => setOpen(popover.hidden),
    close: () => setOpen(false),
    get isOpen() {
      return !popover.hidden;
    },
    sync,
  };
}
