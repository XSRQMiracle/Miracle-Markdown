/**
 * The sidebar.
 *
 * Two panels behind a tab strip: the document's headings, and the folder it
 * lives in. The outline is read off the laid-out blocks rather than
 * re-parsed, so the heading positions it scrolls to are the ones the page was
 * painted at; the tree is lazy and owns no document state of its own.
 */

import type { Editor, OutlineEntry } from "../editor/editor.js";
import type { SidebarTab } from "./settings.js";
import type { FileTree } from "./file-tree.js";

export interface Sidebar {
  /** Show a panel, as if its tab had been clicked. */
  setTab(next: SidebarTab): void;
  /** Rebuild the rows. Cheap enough to call whenever the document relaid. */
  refresh(): void;
  /** Mark the heading the reader is inside. Called every frame, so it touches
   *  the DOM only when the answer changes. */
  track(): void;
  /** Forget the hand-picked heading, because a different document is open. */
  forget(): void;
  readonly tab: SidebarTab;
}

export interface SidebarOptions {
  tabs: HTMLElement;
  body: HTMLElement;
  editor: Editor;
  tab: SidebarTab;
  tree: FileTree;
  onTabChange(tab: SidebarTab): void;
}

export function buildSidebar(options: SidebarOptions): Sidebar {
  const { tabs, body, editor, tree } = options;
  let tab: SidebarTab = options.tab;
  let entries: OutlineEntry[] = [];
  let rows: HTMLButtonElement[] = [];
  let current = -1;
  /** A heading picked by hand, and the scroll position it was picked at.
   *  Held until the reader scrolls away from it — otherwise the tracking rule
   *  below would immediately answer with something else whenever the chosen
   *  heading cannot reach the top of the window.
   *
   *  Held by where the heading starts in the source rather than by its place
   *  in the list. The reader chose a heading, not a third row, so renaming it
   *  or inserting one above it must not quietly move the mark to a different
   *  heading — and an offset that no longer starts one is how `track` below
   *  notices that the heading has been edited away. */
  let pinned = -1;
  let pinnedAt = -1;
  /** What the last rebuild was drawn from, so an unchanged document does not
   *  cost a DOM rewrite on every relayout. Joined on U+0000 and U+0001, which
   *  no heading can contain — written as escapes, because the bytes
   *  themselves make git call the file binary and stop diffing it. */
  let signature = "";

  const buttons = Array.from(tabs.querySelectorAll<HTMLButtonElement>("button[data-tab]"));
  const syncTabs = (): void => {
    for (const button of buttons) {
      button.setAttribute("aria-selected", String(button.dataset.tab === tab));
    }
  };
  for (const button of buttons) {
    button.addEventListener("click", () => {
      const next = button.dataset.tab as SidebarTab | undefined;
      if (!next || next === tab || button.disabled) return;
      tab = next;
      syncTabs();
      options.onTabChange(tab);
      show();
    });
  }
  syncTabs();

  const empty = (message: string): void => {
    body.textContent = "";
    rows = [];
    current = -1;
    const note = document.createElement("p");
    note.className = "side-empty";
    note.textContent = message;
    body.appendChild(note);
  };

  const render = (): void => {
    if (tab === "files") {
      // The tree keeps its own scroll position and open folders, so it is
      // moved in and out rather than rebuilt.
      body.textContent = "";
      rows = [];
      current = -1;
      body.appendChild(tree.element);
      return;
    }
    if (tab !== "outline") {
      empty("这一栏还没有做。");
      return;
    }
    if (!entries.length) {
      empty("文档里还没有标题。写一个 # 开头的行，它就会出现在这里。");
      return;
    }

    body.textContent = "";
    rows = [];
    current = -1;
    for (const [index, entry] of entries.entries()) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "outline-row";
      row.dataset.level = String(entry.level);

      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = `H${entry.level}`;

      const label = document.createElement("span");
      label.className = "label";
      // A heading with only markup in it would otherwise render as a blank row.
      label.textContent = entry.text || "（无标题）";
      label.title = entry.text;

      row.append(badge, label);
      row.addEventListener("click", () => {
        // Scrolling stops at the end of the document, so the last few
        // headings can never reach the top however hard they are asked to.
        // Remember which one was chosen rather than re-deriving it from a
        // scroll position that cannot express the answer.
        pinnedAt = editor.revealBlockAtTop(entries[index].start);
        pinned = entries[index].start;
        select(index);
        editor.focus();
      });
      body.appendChild(row);
      rows.push(row);
    }

    const divider = document.createElement("div");
    divider.className = "side-divider";
    const summary = document.createElement("div");
    summary.className = "side-summary";
    summary.textContent = `${entries.length} 个标题`;
    body.append(divider, summary);
  };

  const select = (index: number): void => {
    if (index === current) return;
    if (current >= 0) rows[current]?.removeAttribute("aria-current");
    current = index;
    rows[current]?.setAttribute("aria-current", "true");
  };

  /**
   * Draw the panel this tab wants, and mark the heading the reader is inside.
   *
   * `render` builds the rows from nothing, so whatever `track` had marked goes
   * with the old ones — and nothing repaints the page merely because a tab was
   * clicked, so the next frame is not coming to put it back. Switching to 大纲
   * would leave the outline with no heading marked until the reader scrolled.
   */
  const show = (): void => {
    entries = tab === "outline" ? editor.outline() : [];
    signature = entries.map((e) => `${e.level}\u0000${e.text}`).join("\u0001");
    render();
    track();
  };

  const refresh = (): void => {
    entries = tab === "outline" ? editor.outline() : [];
    const next = entries.map((e) => `${e.level}\u0000${e.text}`).join("\u0001");
    if (next === signature && body.childElementCount) return;
    signature = next;
    render();
    track();
  };

  const track = (): void => {
    if (tab !== "outline" || !rows.length) return;
    // The heading the reader is inside is the last one that has gone past the
    // top of the window, with a little slack so a heading just above the fold
    // still counts as the one being read.
    //
    // At the very bottom that rule breaks down: the last sections can be short
    // enough that their headings never reach the top, and the outline would
    // keep pointing at whatever did. Once the end of the document is on
    // screen, the heading being read is simply the last one visible.
    if (pinned >= 0) {
      // Still where the click left it, and still a heading: the reader has
      // not disagreed yet, and nothing has edited the chosen one away.
      const chosen = entries.findIndex((entry) => entry.start === pinned);
      if (chosen >= 0 && Math.abs(editor.scrollOffset - pinnedAt) < 1) {
        select(chosen);
        return;
      }
      pinned = -1;
    }
    const { max, viewport } = editor.scrollExtent;
    const atEnd = max > 0 && editor.scrollOffset >= max - 1;
    const top = atEnd
      ? editor.scrollOffset + viewport
      : editor.scrollOffset + editor.theme.bodySize * 3;
    let found = 0;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].y <= top) found = i;
      else break;
    }
    select(found);
  };

  refresh();

  return {
    setTab(next) {
      if (next === tab) return;
      tab = next;
      syncTabs();
      options.onTabChange(tab);
      show();
    },
    refresh,
    track,
    forget() {
      // The mark is an offset into a document, and a different document gives
      // the same offsets to different headings.
      pinned = -1;
      pinnedAt = -1;
    },
    get tab() {
      return tab;
    },
  };
}
