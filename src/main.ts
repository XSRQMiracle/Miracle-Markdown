/**
 * Application entry point. Wires the engine, the editor and the chrome around
 * them: a toolbar that says which document is open, a sidebar that lists its
 * headings, and a status bar that carries the numbers plus the one popover
 * where the typesetting switches live.
 */

import { Editor, type StatusInfo } from "./editor/editor.js";
import { initEngine } from "./engine/typeset.js";
import { SAMPLE } from "./sample.js";
import {
  allowImagesIn,
  finishDesktopClose,
  installDesktopCloseHandler,
  isDesktop,
  openDocument,
  canBrowseFiles,
  listFolder,
  newWindow,
  openExternal,
  openFolder,
  readDocumentAt,
  saveDocument,
} from "./platform.js";
import { DEFAULT_MATH_OPTIONS, initMath, type MathOptions } from "./engine/mathjax.js";
import { directoryOf, imageBase, onImageSettled, setImageBase } from "./engine/images.js";
import { DocumentSession } from "./markdown/session.js";
import { confirmUnsavedDocument, showDocumentError } from "./ui/document-dialog.js";
import { buildFindBar } from "./ui/find-bar.js";
import { buildShortcutSheet } from "./ui/shortcut-sheet.js";
import { buildSidebar } from "./ui/sidebar.js";
import { buildFileTree } from "./ui/file-tree.js";
import { buildTypographyPopover } from "./ui/typography.js";
import { buildPreferences } from "./ui/preferences.js";
import { applySkin, watchSystemAppearance } from "./ui/skin.js";
import { loadSettings, saveSettings, type AppSettings } from "./ui/settings.js";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const app = el("app");
const stage = el("stage");
const canvas = el<HTMLCanvasElement>("surface");
const status = el("status");
const perf = el("perf");
const mode = el("mode");
const docName = el("doc-name");
const docPath = el("doc-path");
const docDirty = el("doc-dirty");
const openButton = el<HTMLButtonElement>("open");
const saveButton = el<HTMLButtonElement>("save");
const saveAsButton = el<HTMLButtonElement>("save-as");
const sidebarToggle = el<HTMLButtonElement>("sidebar-toggle");
const prefsButton = el<HTMLButtonElement>("prefs-button");
const findButton = el<HTMLButtonElement>("find-button");
const newWindowButton = el<HTMLButtonElement>("new-window");

async function main() {
  // Editing starts only once both the session and its close guard are ready.
  stage.inert = true;

  // The window is dressed before the engine loads, so the first frame the
  // reader sees is already the right colour rather than a default that
  // repaints a moment later.
  const settings: AppSettings = loadSettings();
  const dressWindow = () => applySkin(settings.skin, settings.appearance, settings.bodyFace);
  const dressed = dressWindow();

  await initEngine();

  const editor = new Editor(stage, canvas);
  editor.setTheme(dressed.document);
  editor.setText(SAMPLE);
  await editor.ready();

  // ⌘/Ctrl-click on a link. The editor finds it; where it opens is the
  // host's business, and an unopenable one is simply left alone.
  editor.onFollowLink = (href) => void openExternal(href);

  // Decoding can change an image's reserved width and height. Register once
  // at startup so cached placeholder layouts are invalidated immediately.
  onImageSettled(() => editor.invalidateMath());

  /**
   * Point image resolution at a folder, once the shell will serve from it.
   *
   * The order matters. The base moves only after the grant has landed, so no
   * picture is asked for while the asset protocol would still refuse it: a
   * refusal is cached against the resolved URL and never retried, so a request
   * made a moment too early leaves the image broken for the rest of the
   * session.
   */
  const rebaseImages = (folder: string) => {
    if (folder === imageBase()) return;
    void allowImagesIn(folder).then(() => {
      if (setImageBase(folder)) editor.invalidateMath();
    });
  };

  // ── The document's identity ───────────────────────────────────────────────
  let sessionReady = false;
  const syncSession = () => {
    document.title = `${session.dirty ? "• " : ""}${session.name} — Miracle Markdown`;
    docName.textContent = session.name.endsWith(".md") ? session.name : `${session.name}.md`;
    // The folder, not the file: the name is already the line above it.
    const folder = session.path?.replace(/[\\/][^\\/]*$/, "") ?? "";
    docPath.textContent = folder;
    docPath.title = session.path ?? "";
    // Not the string above: a host that reports a bare filename has no folder
    // to offer, and measuring images against a filename would be worse than
    // measuring them against nothing.
    rebaseImages(directoryOf(session.path));
    docDirty.hidden = !session.dirty;
    tree.setCurrent(session.path, session.dirty);
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
  /**
   * Save, and then tell the tree what changed on disk.
   *
   * The tree lists a folder once and keeps it, so without this a save leaves
   * it showing the size and date the file had when the folder was opened —
   * and a 另存为 into that folder writes a file the tree has never heard of.
   */
  const saveAction = (as: boolean) => fileAction(async () => {
    const saved = await session.save(as);
    if (saved) await tree.refresh();
    return saved;
  });
  newWindowButton.addEventListener("click", () => void newWindow());
  openButton.addEventListener("click", () => void fileAction(() => session.open()));
  saveButton.addEventListener("click", () => void saveAction(false));
  saveAsButton.addEventListener("click", () => void saveAction(true));

  // ── Sidebar ───────────────────────────────────────────────────────────────
  const tree = buildFileTree({
    list: listFolder,
    // Every route into the tree goes through the session, so the tree cannot
    // replace an unsaved document without the guard having its say.
    onOpen: (path) => void fileAction(() => session.open(() => readDocumentAt(path))),
    onChooseFolder: () => void chooseFolder(),
    onNewDocument: () => void fileAction(() =>
      session.open(async () => ({ path: null, contents: "", lineEnding: "\n" }))),
  });
  const chooseFolder = async () => {
    const picked = await openFolder();
    if (!picked) return;
    update({ folder: picked });
  };
  const sidebar = buildSidebar({
    tabs: el("side-tabs"),
    body: el("side-body"),
    editor,
    tree,
    tab: settings.sidebarTab,
    onTabChange: (tab) => update({ sidebarTab: tab }),
  });
  // The tree tab is only meaningful where there is a filesystem to browse.
  const filesTab = el<HTMLButtonElement>("side-tabs")
    .querySelector<HTMLButtonElement>('button[data-tab="files"]');
  if (filesTab) {
    filesTab.disabled = !canBrowseFiles();
    filesTab.title = canBrowseFiles() ? "文件树" : "浏览器预览下没有文件系统";
  }
  void tree.setFolder(settings.folder);
  if (settings.folder) void allowImagesIn(settings.folder);
  // A remembered tab this host cannot show would leave the sidebar on a panel
  // nothing can fill.
  if (settings.sidebarTab === "files" && !canBrowseFiles()) sidebar.setTab("outline");
  const syncSidebar = () => {
    app.dataset.sidebar = settings.sidebarVisible ? "shown" : "hidden";
    sidebarToggle.setAttribute("aria-pressed", String(settings.sidebarVisible));
    // The canvas takes its width from the stage, and the stage just changed.
    editor.invalidate();
  };
  sidebarToggle.addEventListener("click", () => {
    update({ sidebarVisible: !settings.sidebarVisible });
    editor.focus();
  });

  // ── Typography ────────────────────────────────────────────────────────────
  const typography = buildTypographyPopover({
    popover: el("typo-popover"),
    trigger: el("typo-button"),
    caret: el("typo-caret"),
    chips: el("toggles"),
    size: el<HTMLInputElement>("size"),
    sizeValue: el("size-value"),
    column: el<HTMLInputElement>("column"),
    columnValue: el("column-value"),
    editor,
  });

  // ── Find and the shortcut sheet ───────────────────────────────────────────
  const findBar = buildFindBar(el("find-bar"), editor);
  const apple = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const sheet = buildShortcutSheet(el("shortcuts"), apple);
  const toggleSheet = () => {
    sheet.toggle();
    if (!sheet.isOpen) editor.focus();
  };
  el("shortcut-button").addEventListener("click", toggleSheet);
  findButton.addEventListener("click", () => {
    findBar.open(editor.selectedText() || undefined);
  });

  // ── Preferences ───────────────────────────────────────────────────────────
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
    prefsButton.title = "公式引擎加载失败，可在偏好设置中重试";
  });

  const preferences = buildPreferences({
    editor,
    math: mathOptions,
    reloadMath,
    settings,
    onChange: (patch) => update(patch),
    onShowShortcuts: () => {
      if (!sheet.isOpen) sheet.toggle();
    },
  });
  prefsButton.addEventListener("click", () => preferences.open());

  /**
   * The single place a setting changes.
   *
   * Everything downstream of a setting is re-derived here rather than at each
   * call site, so a new control cannot forget to repaint the page or persist
   * the choice.
   */
  function update(patch: Partial<AppSettings>): void {
    Object.assign(settings, patch);
    saveSettings(patch);
    if ("skin" in patch || "appearance" in patch || "bodyFace" in patch) {
      // A colour is part of a run's measurement key, so a palette change is a
      // re-typeset, not a repaint. `setTheme` already knows that.
      editor.setTheme(dressWindow().document);
    }
    if ("sidebarVisible" in patch) syncSidebar();
    // Not the tab: the sidebar is what changes it, and it has already drawn
    // the panel and marked the current heading by the time this is called.
    // Asking again would rebuild the rows and lose the mark.
    if ("folder" in patch) {
      void tree.setFolder(settings.folder);
      if (settings.folder) void allowImagesIn(settings.folder);
    }
  }

  // With `跟随系统`, the OS flipping appearance has to reach both halves.
  watchSystemAppearance(() => {
    if (settings.appearance === "system") editor.setTheme(dressWindow().document);
  });

  window.addEventListener("keydown", (e) => {
    if (document.querySelector("dialog[open]")) return;
    // F3 and Shift+F3 step through the matches on Windows and Linux, where
    // they are the convention; Ctrl+H opens the bar with the replacement
    // field ready, as ⌥⌘F does on a Mac.
    if (e.key === "F3") {
      if (findBar.step(e.shiftKey)) e.preventDefault();
      return;
    }
    if (e.key === "F1") {
      e.preventDefault();
      toggleSheet();
      return;
    }
    // Escape closes whatever is open, innermost first, and ends at the search.
    if (e.key === "Escape" && sheet.isOpen) {
      e.preventDefault();
      sheet.close();
      editor.focus();
      return;
    }
    if (e.key === "Escape" && typography.isOpen) {
      e.preventDefault();
      typography.close();
      editor.focus();
      return;
    }
    if (e.key === "Escape" && findBar.isOpen) {
      e.preventDefault();
      findBar.close();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    // The editor sees a keystroke first and calls `preventDefault` on the ones
    // it claims. This handler is the window's last resort, not a second bite:
    // without the check a chord bound in both places runs both commands, which
    // is what ⌘⇧L used to do — select the block *and* hide the sidebar.
    if (e.defaultPrevented) return;
    const key = e.key.toLowerCase();
    if (key === "n") {
      // A second editor, which macOS shows as a second tab. The document stays
      // with the window it was opened in.
      e.preventDefault();
      void newWindow();
    } else if (key === ",") {
      e.preventDefault();
      preferences.open();
    } else if (key === "b" && e.shiftKey) {
      // Not ⌘⇧L: that is the editor's 选择段落或块, and the chrome does not get
      // to take a chord the document already answers to.
      e.preventDefault();
      update({ sidebarVisible: !settings.sidebarVisible });
    } else if (key === "o") {
      e.preventDefault();
      void fileAction(() => session.open());
    } else if (key === "s") {
      e.preventDefault();
      void saveAction(e.shiftKey);
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
  syncSidebar();

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

  // The keyboard can change the type size too, and then the slider has to
  // catch up.
  editor.onThemeChange = () => typography.sync();

  // Source mode is a state the reader is in, so it is worth saying so
  // somewhere: the status bar, where Typora says it too.
  const syncMode = () => {
    mode.textContent = "";
    const badges = [
      editor.editing.sourceMode ? "源代码模式 ⌘/" : "",
      editor.editing.focusMode ? "专注模式 F8" : "",
      editor.editing.typewriter ? "打字机 F9" : "",
    ].filter(Boolean);
    for (const text of badges) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = text;
      mode.appendChild(badge);
    }
  };
  editor.onEditingChange = syncMode;
  syncMode();

  editor.onStatus = (info: StatusInfo) => {
    status.textContent =
      `${info.chars} 字符 · ${info.blocks} 块 · ${info.lines} 行 · ` +
      `版心 ${Math.round(info.measure)}px`;
    perf.innerHTML =
      `排版 <b>${info.layoutMs.toFixed(2)} ms</b> · 平均劣度 <b>${info.badness.toFixed(0)}</b>` +
      (isDesktop() ? "" : " · 浏览器预览");
    // `onStatus` runs on every painted frame, so this is also the scroll
    // signal the outline needs. Both calls are cheap when nothing changed.
    sidebar.refresh();
    sidebar.track();
  };

  // A handle for driving the editor from the console and from tests. Dev
  // builds only; `import.meta.env.DEV` is false in a production bundle.
  if (import.meta.env.DEV) {
    Object.assign(window as unknown as Record<string, unknown>, { editor, tree, sidebar });
  }

  editor.focus();
  window.addEventListener("resize", () => editor.invalidate());
  // Clicking anywhere in the page keeps focus on the editing surface.
  stage.addEventListener("mousedown", () => editor.focus());
}

main().catch((err) => {
  status.textContent = `启动失败：${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
