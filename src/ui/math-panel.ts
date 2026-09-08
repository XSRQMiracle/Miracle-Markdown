/**
 * The math settings panel.
 *
 * These options are not matters of taste. Each one exists because
 * implementations genuinely disagree, and a document written under one set of
 * rules can be misread under another. The hints say what each actually
 * changes — "strict mode", on its own, tells a reader nothing.
 */

import type { Editor } from "../editor/editor.js";
import type { MathOptions } from "../engine/mathjax.js";
import type { TypesetOptions } from "../engine/typeset.js";

interface Check {
  label: string;
  hint: string;
  get(): boolean;
  set(on: boolean): void;
  /** Set when changing this requires the math engine to be rebuilt. */
  reload?: boolean;
}

/** A setting with more than two answers. */
interface Choice {
  label: string;
  hint: string;
  options: Array<[string, string]>;
  get(): string;
  set(value: string): void;
}

export function buildMathPanel(
  panel: HTMLElement,
  button: HTMLElement,
  editor: Editor,
  math: MathOptions,
  reloadMath: () => Promise<void>,
): void {
  let busy = false;
  let errorMessage = "";
  const writing = () => editor.editing.writing;
  const setWriting = (patch: Partial<ReturnType<typeof writing>>) =>
    editor.setEditing({ writing: { ...writing(), ...patch } });

  // What the commands write. Typora calls this Syntax Preference and notes
  // that it applies only to what the menu creates — an existing list keeps
  // the bullet its author typed, and so it does here.
  const choices: Array<{ title: string; rows: Choice[] }> = [
    {
      title: "Markdown 语法偏好",
      rows: [
        {
          label: "无序列表",
          hint: "新建列表用的符号。已有的列表保持作者写下的那个。",
          options: [["-", "- 短横"], ["+", "+ 加号"], ["*", "* 星号"]],
          get: () => writing().bullet,
          set: (v) => setWriting({ bullet: v as "-" | "+" | "*" }),
        },
        {
          label: "有序列表",
          hint: "新建列表是逐项计数，还是每项都写同一个数字（源码里更好增删）。",
          options: [["increment", "1. 2. 3."], ["repeat", "1. 1. 1."]],
          get: () => writing().ordered,
          set: (v) => setWriting({ ordered: v as "increment" | "repeat" }),
        },
        {
          label: "缩进宽度",
          hint: "一级嵌套的宽度，也是正文里 Tab 写入的宽度。",
          options: [["2", "2 空格"], ["3", "3 空格"], ["4", "4 空格"], ["\t", "制表符"]],
          get: () => writing().indent,
          set: (v) => setWriting({ indent: v === "\t" ? "\t" : " ".repeat(Number(v)) }),
        },
        {
          label: "代码缩进宽度",
          hint: "代码块里 Tab 写入的宽度。代码自有其惯例，通常比正文宽。",
          options: [["2", "2 空格"], ["4", "4 空格"], ["\t", "制表符"]],
          get: () => writing().codeIndent,
          set: (v) => setWriting({ codeIndent: v === "\t" ? "\t" : " ".repeat(Number(v)) }),
        },
      ],
    },
  ];

  const groups: Array<{ title: string; checks: Check[] }> = [
    {
      title: "Markdown 扩展语法",
      checks: [
        {
          label: "自动链接 https://…",
          hint:
            "正文里裸写的网址自动成为链接（GFM 的 autolink 扩展）。" +
            "结尾的标点归还给句子，只有网址自己开的括号才算它的。",
          get: () => editor.options.inline.autoLink,
          set: (on) =>
            editor.setOptions({ inline: { ...editor.options.inline, autoLink: on } }),
        },
        {
          label: "下标 H~2~O",
          hint:
            "波浪号在正文里是普通字符，因此与 Typora 一样默认关闭。规则刻意收得很窄：" +
            "中间不能有空格（要空格就写 \\ ），里面也不再解析别的标记 —— " +
            "这正是它不与 ~~删除线~~ 打架的原因。",
          get: () => editor.options.inline.subscript,
          set: (on) =>
            editor.setOptions({ inline: { ...editor.options.inline, subscript: on } }),
        },
        {
          label: "上标 X^2^",
          hint: "与下标同一条规则，只是分隔符换成脱字符。",
          get: () => editor.options.inline.superscript,
          set: (on) =>
            editor.setOptions({ inline: { ...editor.options.inline, superscript: on } }),
        },
        {
          label: "高亮 ==key==",
          hint:
            "CommonMark 里没有这条语法，Typora 也默认关闭：一篇用 == 表示别的东西的文档" +
            "（分隔线、等式）应当仍旧照原样显示。开启后 ==文字== 会被标黄。",
          get: () => editor.options.inline.highlight,
          set: (on) =>
            editor.setOptions({ inline: { ...editor.options.inline, highlight: on } }),
        },
      ],
    },
    {
      title: "识别为公式",
      checks: [
        {
          label: "美元分隔符 $…$ / $$…$$",
          hint: "识别美元符号包围的行内和行间公式。",
          get: () => editor.options.inline.inlineMath,
          set: (on) =>
            editor.setOptions({ inline: { ...editor.options.inline, inlineMath: on } }),
        },
        {
          label: "严格分隔符",
          hint:
            "沿用 Pandoc 的规则：开分隔符后不能是空格，闭分隔符前不能是空格、后不能是数字。" +
            "正是最后一条让「$5 和 $10」保持为价格而不变成公式。关闭后回到宽松匹配，" +
            "用于读按旧规则写成的文档。",
          get: () => editor.options.inline.strictDollar,
          set: (on) =>
            editor.setOptions({ inline: { ...editor.options.inline, strictDollar: on } }),
        },
        {
          label: "TeX 分隔符 \\( \\) \\[ \\]",
          hint:
            "LaTeX 自己的分隔符。它们与 Markdown 的反斜杠转义相冲突，" +
            "因此必须先于转义规则识别，否则公式会被逐字符吃掉。",
          get: () => editor.options.inline.texDelimiters,
          set: (on) =>
            editor.setOptions({ inline: { ...editor.options.inline, texDelimiters: on } }),
        },
      ],
    },
    {
      title: "断行",
      checks: [
        {
          label: "公式内可断行",
          hint:
            "TeX 允许行内公式在顶层二元运算符后（\\binoppenalty = 700）与关系符后" +
            "（\\relpenalty = 500）断行，且只在顶层 —— 分数、上下标、成对定界符内部不断。" +
            "关闭相当于把这两个惩罚设为无穷大：公式保持完整，代价是行末的长公式会被整个" +
            "挪到下一行，留下 TeX 当初正是为了避免的空洞。",
          get: () => editor.options.breakInsideMath,
          set: (on) => editor.setOptions({ breakInsideMath: on }),
        },
      ],
    },
    {
      title: "可用的 LaTeX",
      checks: [
        {
          label: "physics 宏包",
          hint:
            "提供 \\dv \\pdv \\bra \\ket \\abs \\qty \\grad 等。默认关闭是有原因的：" +
            "它重定义了已有含义的命令 —— 载入后 \\div 不再是除号而成为散度算符，" +
            "同一篇文档的排版结果会因此改变。",
          get: () => math.physics,
          set: (on) => {
            math.physics = on;
          },
          reload: true,
        },
        {
          label: "mhchem 化学式",
          hint: "以 \\ce{H2O}、\\ce{SO4^2-} 书写化学式与反应式。",
          get: () => math.mhchem,
          set: (on) => {
            math.mhchem = on;
          },
          reload: true,
        },
        {
          label: "braket 记号",
          hint: "\\bra \\ket \\braket。与 physics 独立，后者也定义了这些命令。",
          get: () => math.braket,
          set: (on) => {
            math.braket = on;
          },
          reload: true,
        },
        {
          label: "mathtools 扩展",
          hint: "amsmath 的增强：\\coloneqq、\\DeclarePairedDelimiter 等。",
          get: () => math.mathtools,
          set: (on) => {
            math.mathtools = on;
          },
          reload: true,
        },
      ],
    },
  ];

  const render = (): void => {
    panel.textContent = "";
    if (errorMessage) {
      const error = document.createElement("div");
      error.setAttribute("role", "alert");
      error.textContent = errorMessage;
      panel.appendChild(error);
    }
    for (const group of groups) {
      const title = document.createElement("h4");
      title.textContent = group.title;
      panel.appendChild(title);
      for (const check of group.checks) {
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = check.get();
        box.disabled = busy;
        box.addEventListener("change", async () => {
          const previous = check.get();
          check.set(box.checked);
          errorMessage = "";
          busy = true;
          render();
          try {
            if (check.reload) await reloadMath();
          } catch (error) {
            check.set(previous);
            errorMessage = `公式设置未生效：${error instanceof Error ? error.message : String(error)}`;
          } finally {
            busy = false;
            render();
          }
        });
        const text = document.createElement("span");
        const name = document.createElement("span");
        name.textContent = check.label;
        const hint = document.createElement("span");
        hint.className = "hint";
        hint.textContent = check.hint;
        text.append(name, document.createElement("br"), hint);
        label.append(box, text);
        panel.appendChild(label);
      }
    }

    for (const group of choices) {
      const title = document.createElement("h4");
      title.textContent = group.title;
      panel.appendChild(title);
      for (const choice of group.rows) {
        const row = document.createElement("div");
        row.className = "row";
        const name = document.createElement("span");
        name.textContent = choice.label;
        name.title = choice.hint;
        const select = document.createElement("select");
        for (const [value, label] of choice.options) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          option.selected = value === choice.get() ||
            (value !== "\t" && /^\d+$/.test(value) && choice.get() === " ".repeat(Number(value)));
          select.appendChild(option);
        }
        select.addEventListener("change", () => {
          choice.set(select.value);
          render();
        });
        row.append(name, select);
        panel.appendChild(row);
      }
    }

    const numberingTitle = document.createElement("h4");
    numberingTitle.textContent = "公式编号";
    panel.appendChild(numberingTitle);

    const row = document.createElement("div");
    row.className = "row";
    const select = document.createElement("select");
    for (const [value, label] of [
      ["none", "不编号"],
      ["ams", "仅 AMS 环境"],
      ["all", "全部行间公式"],
    ] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = editor.options.numbering === value;
      select.appendChild(option);
    }
    select.addEventListener("change", () => {
      editor.setOptions({ numbering: select.value as TypesetOptions["numbering"] });
    });
    row.append(document.createTextNode("编号方式"), select);
    panel.appendChild(row);

    const note = document.createElement("div");
    note.className = "note";
    note.textContent =
      "\\tag{…} 始终优先，\\notag 始终抑制。「仅 AMS 环境」按 LaTeX 的约定：" +
      "equation、align、gather 等编号，其带星号的形式不编号 —— 星号存在的意义就是退出编号。";
    panel.appendChild(note);
  };

  const place = (): void => {
    const rect = button.getBoundingClientRect();
    panel.style.left = `${Math.max(8, rect.left - 8)}px`;
  };

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel.hidden) {
      render();
      place();
      panel.hidden = false;
    } else {
      panel.hidden = true;
    }
    button.setAttribute("aria-pressed", String(!panel.hidden));
  });

  panel.addEventListener("mousedown", (e) => e.stopPropagation());
  document.addEventListener("mousedown", () => {
    if (!panel.hidden) {
      panel.hidden = true;
      button.setAttribute("aria-pressed", "false");
    }
  });
}
