/**
 * The file tree.
 *
 * Lazy: one level is listed when a folder is opened, not the whole tree at
 * once. A notes folder can live inside a home directory, and walking it
 * eagerly would cost seconds before anything could be drawn.
 *
 * The tree owns no document state. It reports which path was chosen and lets
 * the session decide whether it may be opened — the unsaved-changes guard is
 * the session's, and a sidebar must not be able to route around it.
 */

import type { FolderEntry } from "../platform.js";

export interface FileTree {
  element: HTMLElement;
  /** Show a different folder, or none. */
  setFolder(path: string | null): Promise<void>;
  /** Mark the open document, and redraw its metadata line. */
  setCurrent(path: string | null, dirty: boolean): void;
  /** Re-list every open folder — after a save has changed a file's size. */
  refresh(): Promise<void>;
  readonly folder: string | null;
}

export interface FileTreeOptions {
  /** List one level of a folder. Injected rather than imported so the panel
   *  can be driven without a filesystem — the same reason the session takes
   *  its ports. */
  list(path: string): Promise<FolderEntry[]>;
  /** The reader picked a document. */
  onOpen(path: string): void;
  /** The reader wants a folder to browse. */
  onChooseFolder(): void;
  /** The reader wants an empty document. */
  onNewDocument(): void;
}

const KB = 1024;

/** Sizes as a person reads them, not as the filesystem stores them. */
function formatSize(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < KB * KB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${(bytes / KB / KB).toFixed(1)} MB`;
}

/** Today gets a clock, this year a date, anything older the year too. */
function formatTime(ms: number): string {
  if (!ms) return "";
  const at = new Date(ms);
  const now = new Date();
  const clock = `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return `今天 ${clock}`;
  if (at.getFullYear() === now.getFullYear()) {
    return `${at.getMonth() + 1} 月 ${at.getDate()} 日 ${clock}`;
  }
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  svg.appendChild(shape);
  return svg;
}

const CHEVRON_DOWN = "M6 9l6 6 6-6";
const CHEVRON_RIGHT = "M9 6l6 6-6 6";

export function buildFileTree(options: FileTreeOptions): FileTree {
  const element = document.createElement("div");
  element.className = "tree";

  const search = document.createElement("div");
  search.className = "tree-search";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = "在文件夹中搜索";
  searchInput.spellcheck = false;
  searchInput.setAttribute("aria-label", "在文件夹中搜索");
  search.append(icon("M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M20 20l-3.5-3.5"), searchInput);

  const body = document.createElement("div");
  body.className = "tree-body";

  const footer = document.createElement("div");
  footer.className = "tree-footer";
  const newButton = document.createElement("button");
  newButton.type = "button";
  newButton.className = "tree-primary";
  newButton.append(icon("M12 5v14M5 12h14"), document.createTextNode("新建文稿"));
  newButton.addEventListener("click", () => options.onNewDocument());
  footer.appendChild(newButton);

  element.append(search, body, footer);

  let folder: string | null = null;
  let current: string | null = null;
  let currentDirty = false;
  let filter = "";
  /** Which folders are open, and what each one holds. Held across redraws so
   *  typing in the search box does not re-hit the filesystem. */
  const open = new Set<string>();
  const listing = new Map<string, FolderEntry[]>();
  /**
   * Which round of reading the cache belongs to.
   *
   * Emptying the cache is not enough on its own, because a read that was
   * already in flight when it was emptied still holds the old answer and will
   * write it back on its way out. The counter is what lets such a reply tell
   * that the question it answers is no longer being asked.
   */
  let generation = 0;

  const message = (text: string, action?: { label: string; run(): void }): void => {
    body.textContent = "";
    const note = document.createElement("p");
    note.className = "side-empty";
    note.textContent = text;
    body.appendChild(note);
    if (!action) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = action.label;
    button.addEventListener("click", action.run);
    const wrap = document.createElement("div");
    wrap.className = "side-empty";
    wrap.appendChild(button);
    body.appendChild(wrap);
  };

  const load = async (path: string): Promise<FolderEntry[]> => {
    const cached = listing.get(path);
    if (cached) return cached;
    const era = generation;
    let entries: FolderEntry[] = [];
    try {
      entries = await options.list(path);
    } catch (error) {
      console.error("could not list", path, error);
    }
    // A refresh that began while this read was outstanding has already emptied
    // the cache, and this answer predates the change it was asked about.
    // Filing it now would hand the redraw queued behind the refresh exactly
    // the listing the refresh existed to replace — so the save that prompted
    // it would show the file's old size, and a file created since would not
    // appear at all. The caller still gets the answer; only the cache refuses
    // it, which is what makes the next read go back to the disk.
    if (era === generation) listing.set(path, entries);
    return entries;
  };

  /** A folder stays visible when it, or anything under it that is loaded,
   *  matches — so filtering never hides the path to a hit. */
  const matches = (entry: FolderEntry): boolean => {
    if (!filter) return true;
    if (entry.name.toLowerCase().includes(filter)) return true;
    if (!entry.isDir) return false;
    return (listing.get(entry.path) ?? []).some(matches);
  };

  const rowFor = (entry: FolderEntry, depth: number): HTMLElement => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "tree-row";
    row.dataset.depth = String(Math.min(depth, 5));
    if (entry.isDir) row.classList.add("is-folder");
    if (!entry.isDir && entry.path === current) {
      row.classList.add("is-current");
      row.setAttribute("aria-current", "true");
    }

    if (entry.isDir) {
      const chevron = icon(open.has(entry.path) ? CHEVRON_DOWN : CHEVRON_RIGHT);
      chevron.classList.add("chevron");
      row.appendChild(chevron);
    } else if (entry.path === current && currentDirty) {
      const dot = document.createElement("span");
      dot.className = "dot";
      row.appendChild(dot);
    }

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = entry.name;
    label.title = entry.path;
    row.appendChild(label);

    row.addEventListener("click", () => {
      if (entry.isDir) {
        if (open.has(entry.path)) open.delete(entry.path);
        else open.add(entry.path);
        void draw();
      } else {
        options.onOpen(entry.path);
      }
    });
    return row;
  };

  const drawLevel = async (path: string, depth: number, into: HTMLElement): Promise<void> => {
    for (const entry of await load(path)) {
      if (!matches(entry)) continue;
      into.appendChild(rowFor(entry, depth));
      if (!entry.isDir) {
        // The open document carries a line of its own facts, one level in.
        if (entry.path === current) {
          const meta = document.createElement("div");
          meta.className = "tree-meta";
          meta.dataset.depth = String(Math.min(depth + 1, 5));
          meta.textContent = [
            formatSize(entry.size),
            formatTime(entry.modified),
            currentDirty ? "未保存" : "",
          ].filter(Boolean).join(" · ");
          into.appendChild(meta);
        }
        continue;
      }
      if (open.has(entry.path)) await drawLevel(entry.path, depth + 1, into);
    }
  };

  /** Serialised, so two overlapping redraws cannot interleave their rows. */
  let drawing: Promise<void> = Promise.resolve();
  const draw = (): Promise<void> => {
    drawing = drawing.then(async () => {
      if (!folder) {
        message("还没有打开文件夹。", { label: "打开文件夹…", run: options.onChooseFolder });
        return;
      }
      const next = document.createElement("div");
      const header = document.createElement("button");
      header.type = "button";
      header.className = "tree-header";
      header.textContent = folder.split(/[\\/]/).pop() || folder;
      header.title = `${folder}\n点击更换文件夹`;
      header.addEventListener("click", () => options.onChooseFolder());
      next.appendChild(header);

      const rows = document.createElement("div");
      await drawLevel(folder, 0, rows);
      if (!rows.childElementCount) {
        const note = document.createElement("p");
        note.className = "side-empty";
        note.textContent = filter ? "没有匹配的文件。" : "这个文件夹里没有 Markdown 文件。";
        rows.appendChild(note);
      }
      next.appendChild(rows);
      body.textContent = "";
      body.appendChild(next);
    });
    return drawing;
  };

  searchInput.addEventListener("input", () => {
    filter = searchInput.value.trim().toLowerCase();
    void draw();
  });

  // Draw once now, so the panel has its empty state before anyone asks it
  // for a folder — `setFolder(null)` on a tree already showing null is a
  // no-op, and would otherwise leave the body blank.
  void draw();

  return {
    element,
    get folder() {
      return folder;
    },
    async setFolder(path) {
      if (path === folder) return;
      folder = path;
      generation++;
      open.clear();
      listing.clear();
      await draw();
    },
    setCurrent(path, dirty) {
      if (path === current && dirty === currentDirty) return;
      current = path;
      currentDirty = dirty;
      void draw();
    },
    async refresh() {
      generation++;
      listing.clear();
      await draw();
    },
  };
}
