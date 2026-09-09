/**
 * The preferences window.
 *
 * Left nav, right content. Two of the panes are new — the appearance pane,
 * which is the only place a skin can be chosen, and the shortcut pane, which
 * is a door to the sheet. The third hosts the Markdown and formula fields
 * `math-panel.ts` already defines, rather than restating them: there is one
 * definition of what a setting is, and this window borrows it.
 */

import type { Editor } from "../editor/editor.js";
import type { MathOptions } from "../engine/mathjax.js";
import { buildMathPanel } from "./math-panel.js";
import { SKINS, type Appearance, type BodyFace, type Skin, type SkinName } from "./skin.js";
import type { AppSettings } from "./settings.js";

export interface Preferences {
  open(section?: string): void;
  close(): void;
  readonly isOpen: boolean;
}

export interface PreferencesOptions {
  editor: Editor;
  math: MathOptions;
  reloadMath: () => Promise<void>;
  settings: AppSettings;
  /** Persist and apply. Called with the patch, not the whole object. */
  onChange(patch: Partial<AppSettings>): void;
  onShowShortcuts(): void;
}

interface Pane {
  id: string;
  label: string;
  element: HTMLElement;
}

function button(className: string, label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  return element;
}

/** A row of pills in a trough, for a choice of three or fewer. */
function segmented<T extends string>(
  values: ReadonlyArray<readonly [T, string]>,
  selected: T,
  onPick: (value: T) => void,
): { element: HTMLElement; set(value: T): void } {
  const element = document.createElement("div");
  element.className = "seg";
  element.setAttribute("role", "tablist");
  const buttons = new Map<T, HTMLButtonElement>();
  for (const [value, label] of values) {
    const b = button("", label);
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => {
      set(value);
      onPick(value);
    });
    buttons.set(value, b);
    element.appendChild(b);
  }
  const set = (value: T): void => {
    for (const [key, b] of buttons) b.setAttribute("aria-selected", String(key === value));
  };
  set(selected);
  return { element, set };
}

function field(name: string, hint: string, control: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "prefs-field";
  const text = document.createElement("div");
  text.className = "text";
  const title = document.createElement("div");
  title.className = "name";
  title.textContent = name;
  const note = document.createElement("div");
  note.className = "hint";
  note.textContent = hint;
  text.append(title, note);
  const holder = document.createElement("div");
  holder.className = "control";
  holder.appendChild(control);
  row.append(text, holder);
  return row;
}

/** A skin's card is drawn in that skin's own colours and face: the choice is
 *  about what the window will look like, so the card has to look like it. */
function skinCard(skin: Skin, selected: boolean, onPick: (name: SkinName) => void): HTMLButtonElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "skin-card";
  card.disabled = !skin.ready;
  card.setAttribute("aria-pressed", String(selected));

  const preview = document.createElement("div");
  preview.className = "preview";
  preview.style.background = skin.swatch.bg;
  preview.style.color = skin.swatch.ink;
  preview.style.fontFamily = skin.swatch.family;

  const sample = document.createElement("div");
  sample.className = "sample";
  sample.textContent = "断行是一个全局问题";

  const bars = document.createElement("div");
  bars.className = "bars";
  const chip = document.createElement("span");
  chip.className = "chip-bar";
  chip.style.background = skin.swatch.accent;
  chip.style.borderRadius = skin.name === "organic" || skin.name === "nocturne" ? "999px" : "0";
  const rule = document.createElement("span");
  rule.className = "rule-bar";
  rule.style.background = skin.swatch.rule;
  // Modernist's rules are the loud ones; everyone else's are hairlines.
  rule.style.height = skin.name === "modernist" ? "2px" : "1px";
  bars.append(chip, rule);

  preview.append(sample, bars);

  const meta = document.createElement("div");
  meta.className = "meta";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = skin.label;
  const desc = document.createElement("div");
  desc.className = "desc";
  desc.textContent = skin.description;
  meta.append(name, desc);
  if (!skin.ready) {
    const soon = document.createElement("div");
    soon.className = "soon";
    soon.textContent = "尚未实现";
    meta.appendChild(soon);
  }

  card.append(preview, meta);
  if (skin.ready) card.addEventListener("click", () => onPick(skin.name));
  return card;
}

export function buildPreferences(options: PreferencesOptions): Preferences {
  const { editor, math, reloadMath, settings, onChange, onShowShortcuts } = options;

  const dialog = document.createElement("dialog");
  dialog.id = "prefs";
  dialog.setAttribute("aria-label", "偏好设置");

  const body = document.createElement("div");
  body.className = "prefs-body";
  const nav = document.createElement("div");
  nav.className = "prefs-nav";
  body.appendChild(nav);

  const panes: Pane[] = [];
  const addPane = (id: string, label: string, title: string, lead: string): HTMLElement => {
    const element = document.createElement("div");
    element.className = "prefs-pane";
    element.hidden = panes.length > 0;
    const heading = document.createElement("h3");
    heading.textContent = title;
    const note = document.createElement("p");
    note.className = "lead";
    note.textContent = lead;
    element.append(heading, note);
    body.appendChild(element);
    panes.push({ id, label, element });
    return element;
  };

  // ── 外观 ────────────────────────────────────────────────────────────────
  const appearance = addPane(
    "appearance",
    "外观",
    "外观",
    "主题只改 chrome 与正文字族。字号、版心与七个排版开关是文档的属性，不随主题变化。",
  );

  const grid = document.createElement("div");
  grid.className = "skin-grid";
  const cards = new Map<SkinName, HTMLButtonElement>();
  const pickSkin = (name: SkinName): void => {
    for (const [key, card] of cards) card.setAttribute("aria-pressed", String(key === name));
    onChange({ skin: name });
  };
  for (const skin of SKINS) {
    const card = skinCard(skin, skin.name === settings.skin, pickSkin);
    cards.set(skin.name, card);
    grid.appendChild(card);
  }
  appearance.appendChild(grid);

  const modeControl = segmented<Appearance>(
    [
      ["system", "跟随系统"],
      ["light", "浅色"],
      ["dark", "深色"],
    ],
    settings.appearance,
    (value) => onChange({ appearance: value }),
  );
  appearance.appendChild(
    field("明暗", "跟随系统时，主题在它自己的浅色与深色之间切换。", modeControl.element),
  );

  const faceControl = segmented<BodyFace>(
    [
      ["theme", "跟随主题"],
      ["serif", "始终衬线"],
      ["sans", "始终无衬线"],
    ],
    settings.bodyFace,
    (value) => onChange({ bodyFace: value }),
  );
  appearance.appendChild(
    field(
      "正文字族",
      "衬线更像 TeX 的成品；无衬线与窗口同族。换字族会重新排版，断行因此会变。",
      faceControl.element,
    ),
  );

  // ── Markdown 与公式 ─────────────────────────────────────────────────────
  const markdown = addPane(
    "markdown",
    "Markdown 与公式",
    "Markdown 与公式",
    "每个选项都对应一处实现之间的真实分歧，不是偏好。改动即时生效。",
  );
  const mathHost = document.createElement("div");
  markdown.appendChild(mathHost);
  const mathPanel = buildMathPanel(mathHost, null, editor, math, reloadMath);

  // ── 快捷键 ──────────────────────────────────────────────────────────────
  const shortcuts = addPane(
    "shortcuts",
    "快捷键",
    "快捷键",
    "整张表从命令表生成，因此不会和实际的按键不一致。",
  );
  const openSheet = button("chip", "打开快捷键一览（F1）");
  openSheet.addEventListener("click", () => {
    close();
    onShowShortcuts();
  });
  shortcuts.appendChild(openSheet);

  // ── Nav ─────────────────────────────────────────────────────────────────
  const navButtons = new Map<string, HTMLButtonElement>();
  const show = (id: string): void => {
    for (const pane of panes) pane.element.hidden = pane.id !== id;
    for (const [key, b] of navButtons) b.setAttribute("aria-selected", String(key === id));
    if (id === "markdown") mathPanel.render();
  };
  for (const pane of panes) {
    const b = button("", pane.label);
    b.addEventListener("click", () => show(pane.id));
    navButtons.set(pane.id, b);
    nav.appendChild(b);
  }
  const foot = document.createElement("div");
  foot.className = "foot";
  foot.textContent = "改动即时生效，无需重启。";
  nav.appendChild(foot);
  show(panes[0].id);

  const closeButton = button("icon-button ghost prefs-close", "✕");
  closeButton.title = "关闭（Esc）";
  closeButton.addEventListener("click", () => close());

  dialog.append(body, closeButton);
  document.body.appendChild(dialog);

  const close = (): void => {
    if (dialog.open) dialog.close();
  };

  // A modal dialog closes on Escape by itself, but only while the key reaches
  // it. Handling it here as well makes the documented behaviour the window's
  // own rather than the platform's.
  dialog.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  });

  return {
    open(section?: string) {
      if (section && navButtons.has(section)) show(section);
      else if (panes.length) show(panes[0].id);
      if (!dialog.open) dialog.showModal();
    },
    close,
    get isOpen() {
      return dialog.open;
    },
  };
}
