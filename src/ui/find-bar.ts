/**
 * The find bar.
 *
 * It owns the query and the keys that drive it; the matching, the highlighting
 * and the caret all belong to the editor. Focus moves to the find field while
 * it is open, which means the block under the caret stops showing its source
 * — a fair trade, since what the reader wants to see during a search is the
 * document, not the markup.
 */

import type { Editor, SearchStatus } from "../editor/editor.js";

export interface FindBar {
  /** Show the bar, seeded with `query` when there is one. */
  open(query?: string, replacing?: boolean): void;
  close(): void;
  readonly isOpen: boolean;
  /** Step through the matches; false when the bar is not open. */
  step(backwards: boolean): boolean;
  /** Recount after the document changed under an open search. */
  refresh(): void;
}

export function buildFindBar(root: HTMLElement, editor: Editor): FindBar {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const find = el<HTMLInputElement>("find-input");
  const replacement = el<HTMLInputElement>("replace-input");
  const count = el<HTMLElement>("find-count");
  const caseFlag = el<HTMLButtonElement>("find-case");
  const regexFlag = el<HTMLButtonElement>("find-regex");

  let caseSensitive = false;
  let regex = false;

  const query = () => ({ text: find.value, caseSensitive, regex });
  const report = (status: SearchStatus) => {
    count.textContent = !find.value ? ""
      : !status.valid ? "无效正则"
      : status.matches === 0 ? "无结果"
      : `${status.index}/${status.matches}`;
    root.classList.toggle("invalid", !status.valid);
  };
  const run = () => report(editor.setSearch(query()));
  const flag = (button: HTMLButtonElement, get: () => boolean, set: (on: boolean) => void) => {
    const sync = () => button.setAttribute("aria-pressed", String(get()));
    sync();
    button.addEventListener("click", () => {
      set(!get());
      sync();
      run();
      find.focus();
    });
  };
  flag(caseFlag, () => caseSensitive, (on) => { caseSensitive = on; });
  flag(regexFlag, () => regex, (on) => { regex = on; });

  const bar: FindBar = {
    get isOpen() {
      return !root.hidden;
    },
    open(seed, replacing = false) {
      root.hidden = false;
      if (seed) find.value = seed;
      const field = replacing ? replacement : find;
      field.focus();
      field.select();
      run();
    },
    close() {
      if (root.hidden) return;
      root.hidden = true;
      editor.setSearch(null);
      editor.focus();
    },
    step(backwards) {
      if (root.hidden) return false;
      report(editor.findNext(backwards));
      return true;
    },
    refresh() {
      if (!root.hidden) report(editor.searchStatus());
    },
  };

  find.addEventListener("input", run);
  el("find-next").addEventListener("click", () => bar.step(false));
  el("find-prev").addEventListener("click", () => bar.step(true));
  el("find-close").addEventListener("click", () => bar.close());
  el("replace-one").addEventListener("click", () => {
    report(editor.replaceCurrent(replacement.value));
    find.focus();
  });
  el("replace-all").addEventListener("click", () => {
    report(editor.replaceAll(replacement.value));
    find.focus();
  });

  for (const field of [find, replacement]) {
    field.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        bar.close();
      } else if (e.key === "Enter") {
        e.preventDefault();
        // Enter in the replacement field replaces; in the find field it is
        // the same as pressing the arrow.
        if (field === replacement && !e.shiftKey) report(editor.replaceCurrent(replacement.value));
        else bar.step(e.shiftKey);
      }
    });
  }

  // The page hands focus back to the editing surface on any click within it,
  // which would take it away from these fields the moment they were clicked.
  root.addEventListener("mousedown", (e) => e.stopPropagation());
  return bar;
}
