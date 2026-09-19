// The file tree, and what a slow disk does to it.
//
// Listing a folder is asynchronous and redrawing is not, so between asking and
// answering the reader can have moved on: saved a file, switched folders,
// typed in the search box. Both defects here are that gap. A reply that
// arrives after a refresh has emptied the cache must not be written back into
// it, or the refresh reads the very listing it was asking to replace; and rows
// built for a folder the reader has already left must not reach the panel,
// however late they turn up.
//
// The listing port is a plain promise handed back by the test, so the orders
// below are exact rather than a matter of timing.
import assert from "node:assert/strict";
import { buildFileTree } from "../src/ui/file-tree.js";
import type { FolderEntry } from "../src/platform.js";

// --- just enough DOM to hang rows off -------------------------------------
class Node {
  children: Node[] = [];
  listeners = new Map<string, (() => void)[]>();
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  classList = {
    names: new Set<string>(),
    add: (...n: string[]) => n.forEach((x) => this.classList.names.add(x)),
  };
  className = "";
  type = "";
  placeholder = "";
  title = "";
  value = "";
  spellcheck = false;
  disabled = false;
  private text = "";

  constructor(readonly tag: string) {}

  appendChild(child: Node): Node {
    this.children.push(child);
    return child;
  }
  append(...items: (Node | string)[]): void {
    for (const item of items) {
      if (typeof item === "string") this.appendChild(Object.assign(new Node("#text"), { textContent: item }));
      else this.appendChild(item);
    }
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, fn: () => void): void {
    const bucket = this.listeners.get(name) ?? [];
    bucket.push(fn);
    this.listeners.set(name, bucket);
  }
  click(): void {
    for (const fn of this.listeners.get("click") ?? []) fn();
  }
  get childElementCount(): number {
    return this.children.length;
  }
  set textContent(value: string) {
    this.text = value;
    if (value === "") this.children = [];
  }
  get textContent(): string {
    if (this.children.length) return this.children.map((c) => c.textContent).join("");
    return this.text;
  }
  /** Every row in the subtree, in document order. */
  rows(): Node[] {
    const found: Node[] = [];
    const walk = (node: Node) => {
      if (node.className === "tree-row") found.push(node);
      node.children.forEach(walk);
    };
    walk(this);
    return found;
  }
  labels(): string[] {
    return this.rows().map((row) => row.textContent);
  }
}

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    createElement: (tag: string) => new Node(tag),
    createElementNS: (_ns: string, tag: string) => new Node(tag),
    createTextNode: (text: string) => Object.assign(new Node("#text"), { textContent: text }),
  },
});

const file = (name: string, size = 10): FolderEntry =>
  ({ name, path: `/dir/${name}`, isDir: false, size, modified: 0 });

/** A listing port whose every answer is resolved by hand. */
function port() {
  const calls: string[] = [];
  const pending: ((entries: FolderEntry[]) => void)[] = [];
  return {
    calls,
    list(path: string): Promise<FolderEntry[]> {
      calls.push(path);
      return new Promise<FolderEntry[]>((resolve) => pending.push(resolve));
    },
    /** Answer the nth outstanding read, and let everything it unblocks run. */
    settle(index: number, entries: FolderEntry[]): Promise<void> {
      pending[index](entries);
      return tick();
    },
    /** Answer one, without draining what it unblocks — so the steps show. */
    resolve(index: number, entries: FolderEntry[]): void {
      pending[index](entries);
    },
  };
}
const tick = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

function tree(p: ReturnType<typeof port>, opened: string[] = []) {
  return buildFileTree({
    list: (path) => p.list(path),
    onOpen: (path) => opened.push(path),
    onChooseFolder: () => {},
    onNewDocument: () => {},
  });
}

// --- 13: a reply that outlives the cache it was read into ------------------
{
  const p = port();
  const t = tree(p);
  const body = (t.element as unknown as Node);

  void t.setFolder("/dir");
  await tick();
  assert.deepEqual(p.calls, ["/dir"], "showing a folder reads it once");

  // The reply has not come back yet, and a save asks for a fresh listing.
  const refreshed = t.refresh();
  await tick();

  // Now the first read answers, carrying what was on disk before the save.
  await p.settle(0, [file("old.md")]);
  await p.settle(1, [file("new.md")]);
  await refreshed;

  assert.equal(p.calls.length, 2,
    "the refresh reads the folder again rather than being answered from a cache " +
    "the reply it was racing had just refilled");
  assert.deepEqual(body.labels(), ["new.md"],
    "and what is on screen when it finishes is what is on disk now");
}

// --- 13: the ordinary refresh still does its job ---------------------------
{
  const p = port();
  const t = tree(p);
  const body = (t.element as unknown as Node);

  void t.setFolder("/dir");
  await tick();
  await p.settle(0, [file("a.md", 10)]);
  assert.deepEqual(body.labels(), ["a.md"], "the folder is drawn");

  // Only the open document carries a line of its own facts, so that is the
  // one whose size a save is able to change on screen.
  t.setCurrent("/dir/a.md", false);
  await tick();
  assert.ok(body.textContent.includes("10 B"), "the open document shows what it weighs");

  const refreshed = t.refresh();
  await tick();
  await p.settle(1, [file("a.md", 4096), file("b.md")]);
  await refreshed;
  assert.deepEqual(body.labels(), ["a.md", "b.md"],
    "a refresh shows a file that has appeared since");
  assert.ok(body.textContent.includes("4.0 KB"),
    "and the new size of one that has grown");
  assert.equal(p.calls.length, 2, "having gone back to the disk exactly once to find out");
}

// --- 14: rows for a folder the reader has left -----------------------------
{
  const p = port();
  const opened: string[] = [];
  const t = tree(p, opened);
  const body = (t.element as unknown as Node);

  void t.setFolder("/dir");
  await tick();
  // Before the first folder answers, the reader picks a different one. Redraws
  // are serialised, so the second folder is not even read until the first
  // reply unblocks the queue — which is what gives the late reply its chance
  // to reach the panel.
  void t.setFolder("/other");
  await tick();
  assert.deepEqual(p.calls, ["/dir"], "the queued redraw is still waiting on the first read");

  // The first folder answers late, and the second is now outstanding. The
  // panel is watched at every step in between, not merely once it has settled:
  // the queued redraw of the folder the reader actually asked for will clear
  // whatever is there, so a snapshot taken at the end would be satisfied by
  // rows that had been on screen, and clickable, a moment earlier.
  const frames: string[][] = [];
  p.resolve(0, [file("from-a.md")]);
  for (let i = 0; i < 60; i++) {
    await Promise.resolve();
    frames.push(body.labels());
  }
  assert.deepEqual(p.calls, ["/dir", "/other"], "which sets the second folder being read");
  const stale = frames.find((labels) => labels.includes("from-a.md"));
  assert.equal(stale, undefined,
    "at no point does a listing of the folder the reader has left reach the panel");
  assert.equal(opened.length, 0, "so there was never a stale row there to open");

  await p.settle(1, [{ name: "from-b.md", path: "/other/from-b.md", isDir: false, size: 1, modified: 0 }]);
  assert.deepEqual(body.labels(), ["from-b.md"], "the folder that was asked for arrives and is drawn");
  body.rows()[0].click();
  assert.deepEqual(opened, ["/other/from-b.md"], "and its rows open the file they name");
}

// --- 14: while a folder is being read, it says so --------------------------
{
  const p = port();
  const t = tree(p);
  const body = (t.element as unknown as Node);

  void t.setFolder("/dir");
  await tick();
  assert.ok(body.textContent.includes("正在读取"),
    "a folder that has been asked for but not answered says it is being read");

  await p.settle(0, [file("a.md")]);
  assert.deepEqual(body.labels(), ["a.md"], "and is replaced by the folder itself");

  // A refresh of the folder already on screen must not blink: the rows stay
  // until the new ones are ready to take their place.
  const refreshed = t.refresh();
  await tick();
  assert.deepEqual(body.labels(), ["a.md"],
    "a refresh of the folder already shown leaves it standing while it re-reads");
  await p.settle(1, [file("a.md")]);
  await refreshed;
  assert.deepEqual(body.labels(), ["a.md"], "and puts it back when the answer comes");
}

console.log("all passing");
