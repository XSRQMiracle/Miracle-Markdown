// The outline's mark, and what it is a mark on.
//
// Scrolling stops at the end of the document, so the last few headings can
// never reach the top of the window however hard they are asked to. The panel
// therefore remembers which heading was clicked rather than re-deriving it
// from a scroll position that cannot express the answer — and that memory has
// to survive everything except the reader changing their mind.
//
// It used to be an index into the row list, cleared by every rebuild. Both
// halves of that were wrong: a rebuild happens when the sidebar changes tab,
// which is not the reader disagreeing; and an index follows the position a
// heading happens to occupy rather than the heading itself, so renaming one or
// inserting another above it would quietly move the mark.
import assert from "node:assert/strict";
import { buildSidebar } from "../src/ui/sidebar.js";
import type { OutlineEntry } from "../src/editor/editor.js";

// --- just enough DOM ------------------------------------------------------
class Node {
  children: Node[] = [];
  listeners = new Map<string, (() => void)[]>();
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  className = "";
  type = "";
  title = "";
  disabled = false;
  private text = "";
  constructor(readonly tag: string) {}
  appendChild(child: Node): Node { this.children.push(child); return child; }
  append(...items: Node[]): void { items.forEach((i) => this.appendChild(i)); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(name: string, fn: () => void): void {
    const bucket = this.listeners.get(name) ?? [];
    bucket.push(fn);
    this.listeners.set(name, bucket);
  }
  click(): void { for (const fn of this.listeners.get("click") ?? []) fn(); }
  querySelectorAll(): Node[] { return this.children; }
  set textContent(value: string) { this.text = value; if (value === "") this.children = []; }
  get textContent(): string {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this.text;
  }
  /** Every outline row in the subtree, in order. */
  rows(): Node[] {
    const found: Node[] = [];
    const walk = (n: Node) => { if (n.className === "outline-row") found.push(n); n.children.forEach(walk); };
    walk(this);
    return found;
  }
  /** The label of the row currently marked, or null. */
  marked(): string | null {
    const row = this.rows().find((r) => r.getAttribute("aria-current") === "true");
    return row ? row.textContent.replace(/^H\d/, "") : null;
  }
}
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { createElement: (tag: string) => new Node(tag) },
});

const heading = (level: number, text: string, start: number, y: number): OutlineEntry =>
  ({ level, text, start, y });

/** A stand-in editor whose outline and scroll the test drives directly. */
function fakeEditor(entries: OutlineEntry[]) {
  return {
    entries,
    scrollOffset: 0,
    // Long enough that the end of the document is never on screen, so the
    // "last visible heading" rule never takes over from the mark.
    scrollExtent: { max: 10_000, viewport: 500 },
    theme: { bodySize: 18 },
    outline() { return this.entries; },
    // Standing in for a document that has run out of room to scroll: the
    // chosen heading cannot reach the top, which is the whole reason the
    // panel has to remember the choice rather than re-derive it.
    revealBlockAtTop(_offset: number) { this.scrollOffset = 9_000; return this.scrollOffset; },
    focus() {},
  };
}

function sidebar(entries: OutlineEntry[]) {
  const tabs = new Node("div");
  const outlineTab = new Node("button");
  outlineTab.dataset.tab = "outline";
  const filesTab = new Node("button");
  filesTab.dataset.tab = "files";
  tabs.append(outlineTab, filesTab);
  const body = new Node("div");
  const editor = fakeEditor(entries);
  const panel = buildSidebar({
    tabs: tabs as unknown as HTMLElement,
    body: body as unknown as HTMLElement,
    editor: editor as never,
    tab: "outline",
    tree: { element: new Node("div") as unknown as HTMLElement } as never,
    onTabChange: () => {},
  });
  return { panel, body, editor };
}

const THREE = [
  heading(1, "Alpha", 0, 0),
  heading(2, "Beta", 100, 400),
  heading(2, "Gamma", 200, 460),
];

// --- a tab switch is not the reader changing their mind --------------------
{
  const { panel, body } = sidebar([...THREE]);
  body.rows()[1].click();
  assert.equal(body.marked(), "Beta", "clicking a heading marks it");

  panel.setTab("files");
  panel.setTab("outline");
  assert.equal(body.marked(), "Beta",
    "and it is still marked after the panel has been to the file tree and back");
}

// --- scrolling is the reader changing their mind ---------------------------
{
  const { panel, body, editor } = sidebar([...THREE]);
  body.rows()[1].click();
  assert.equal(body.marked(), "Beta", "the chosen heading is marked");

  editor.scrollOffset = 120;
  panel.track();
  assert.equal(body.marked(), "Alpha",
    "once the reader scrolls, the outline goes back to following the page");
}

// --- renaming the chosen heading keeps the choice --------------------------
{
  const { panel, body, editor } = sidebar([...THREE]);
  body.rows()[1].click();
  // The heading is renamed in place: its text changes, where it starts does not.
  editor.entries = [
    heading(1, "Alpha", 0, 0),
    heading(2, "Beta renamed", 100, 400),
    heading(2, "Gamma", 200, 460),
  ];
  panel.refresh();
  assert.equal(body.marked(), "Beta renamed",
    "renaming the chosen heading leaves the choice on the same heading");
}

// --- a heading inserted above it does not move the mark --------------------
{
  const { panel, body, editor } = sidebar([...THREE]);
  body.rows()[2].click();
  assert.equal(body.marked(), "Gamma", "the third heading is chosen");

  // A new heading above pushes Gamma down the list but not out of the source
  // position it was chosen at.
  editor.entries = [
    heading(1, "Alpha", 0, 0),
    heading(2, "Inserted", 50, 200),
    heading(2, "Beta", 100, 400),
    heading(2, "Gamma", 200, 460),
  ];
  panel.refresh();
  assert.equal(body.marked(), "Gamma",
    "the mark stays on the heading that was chosen, not on the row it used to occupy");
}

// --- a heading edited away drops the mark ----------------------------------
{
  const { panel, body, editor } = sidebar([...THREE]);
  body.rows()[1].click();
  editor.entries = [heading(1, "Alpha", 0, 0), heading(2, "Gamma", 200, 460)];
  panel.refresh();
  // The page is still scrolled down past both survivors, so the ordinary rule
  // answers with the last heading above the fold. The point is that it answers
  // at all: a mark held by an offset nothing starts any more is not a mark.
  assert.equal(body.marked(), "Gamma",
    "a chosen heading that has been deleted hands tracking back to the page");
}

// --- a different document starts over --------------------------------------
{
  const { panel, body, editor } = sidebar([...THREE]);
  body.rows()[1].click();
  assert.equal(body.marked(), "Beta", "a heading is chosen in the first document");

  // Another document, whose headings happen to start at the same offsets.
  panel.forget();
  editor.entries = [
    heading(1, "One", 0, 0),
    heading(2, "Two", 100, 400),
    heading(2, "Three", 200, 460),
  ];
  editor.scrollOffset = 0;
  panel.refresh();
  assert.equal(body.marked(), "One",
    "an offset from the document that was closed does not mark a heading in the one that opened");
}

console.log("all passing");
