// The scrollbar.
//
// It is painted rather than built from an element, so its geometry is ours to
// get right: the thumb has to be long enough to grab, land at the top and
// bottom exactly, and take the document with it when dragged.
import assert from "node:assert/strict";
import { DEFAULT_EDITING_OPTIONS, Editor } from "../src/editor/editor.js";

(globalThis as any).window = Object.assign(new EventTarget(), { setInterval: () => 0 });
(globalThis as any).ResizeObserver = class { observe() {} };

const VIEWPORT = 600;
const WIDTH = 800;

function scrolling(docHeight: number) {
  const input = Object.assign(new EventTarget(), { value: "", focus() {}, blur() {} });
  const canvas = Object.assign(new EventTarget(), {
    clientWidth: WIDTH,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: WIDTH, height: VIEWPORT }),
  });
  const editor = Object.create(Editor.prototype) as any;
  Object.assign(editor, {
    text: "text", selStart: 0, selEnd: 0, caretAffinity: "downstream", preferredX: null,
    composing: null, undoStack: [], redoStack: [], lastEditAt: -Infinity, input, canvas,
    host: { clientHeight: VIEWPORT }, docHeight, scrollTop: 0, blocks: [],
    typesetter: { theme: { bodySize: 18 } },
    editingOptions: { ...DEFAULT_EDITING_OPTIONS },
    invalidate() {}, scrollCaretIntoView() {}, schedule() {},
    positionAt: () => ({ offset: 4, affinity: "downstream" }),
  });
  editor.attach();
  const mouse = (type: string, x: number, y: number, target: EventTarget = canvas) =>
    target.dispatchEvent(Object.assign(new Event(type), {
      clientX: x, clientY: y, offsetX: x, offsetY: y, detail: 1, preventDefault() {},
    }));
  return {
    editor,
    bar: () => editor.scrollbar(),
    press: (x: number, y: number) => mouse("mousedown", x, y),
    drag: (y: number) => mouse("mousemove", 0, y, (globalThis as any).window),
    release: (x: number, y: number) => mouse("mouseup", x, y, (globalThis as any).window),
    wheel: (dy: number) => canvas.dispatchEvent(Object.assign(new Event("wheel"), {
      deltaY: dy, preventDefault() {},
    })),
  };
}

{
  const s = scrolling(200);
  assert.equal(s.bar(), null, "a document that fits has no scrollbar");
  s.press(WIDTH - 3, 300);
  assert.deepEqual([s.editor.selEnd, s.editor.scrollTop], [4, 0],
    "so the strip it would occupy is ordinary text");
}
{
  const s = scrolling(3000);
  const max = s.editor.scrollMax;
  assert.equal(max, 3000 - VIEWPORT + 18 * 8, "the document scrolls past its last line");

  const bar = s.bar();
  assert.equal(bar.y, 2, "the thumb starts at the top");
  assert.ok(bar.h >= 32 && bar.h < VIEWPORT / 2, "and is a fraction of the track, but grabbable");

  // Grabbing the thumb keeps the grabbed point under the pointer.
  s.press(WIDTH - 3, bar.y + 4);
  assert.equal(s.editor.scrollTop, 0, "pressing the thumb does not move it");
  assert.equal(s.bar().active, true, "and marks it as taken");
  s.drag(bar.y + 4 + (VIEWPORT - 4 - bar.h) / 2);
  assert.ok(Math.abs(s.editor.scrollTop - max / 2) < 2, "dragging half the track scrolls half the document");
  s.drag(10000);
  assert.equal(s.editor.scrollTop, max, "and past the end simply stops");
  assert.equal(s.bar().y + s.bar().h, VIEWPORT - 2, "with the thumb against the bottom");
  s.drag(-10000);
  assert.equal(s.editor.scrollTop, 0);
  s.release(0, 0);
  assert.equal(s.bar().active, false, "letting go releases it");
  s.drag(400);
  assert.equal(s.editor.scrollTop, 0, "and the drag stops following the pointer");
}
{
  // Pressing the track jumps the thumb to the pointer rather than paging.
  const s = scrolling(3000);
  const h = s.bar().h;
  s.press(WIDTH - 3, 400);
  assert.ok(Math.abs(s.editor.scrollTop - (400 - h / 2 - 2) / (VIEWPORT - 4 - h) * s.editor.scrollMax) < 2,
    "the thumb centres on the point that was pressed");
  assert.equal(s.editor.selEnd, 0, "and no caret is placed");
}
{
  // A window with no height reports no scrollbar, rather than one covering
  // the whole surface that would swallow every click.
  const s = scrolling(3000);
  s.editor.host.clientHeight = 0;
  assert.equal(s.bar(), null);
  s.press(WIDTH - 3, 0);
  assert.equal(s.editor.selEnd, 4, "the press is ordinary text");
}
{
  const s = scrolling(3000);
  s.wheel(200);
  assert.equal(s.editor.scrollTop, 200);
  s.wheel(-500);
  assert.equal(s.editor.scrollTop, 0, "scrolling back stops at the top");
  s.wheel(100000);
  assert.equal(s.editor.scrollTop, s.editor.scrollMax, "and forward at the end");
  // A press in the text keeps its old meaning.
  s.press(300, 300);
  assert.equal(s.editor.selEnd, 4);
}

// --- typewriter mode ------------------------------------------------------
{
  // The line being written stays at the middle of the window and the page
  // moves under it, rather than the page moving only when the caret would
  // otherwise leave the view.
  const s = scrolling(3000);
  s.editor.editingOptions = { ...DEFAULT_EDITING_OPTIONS, typewriter: true };
  s.editor.caretRect = () => ({ x: 0, y: 900, w: 1.5, h: 24 });
  s.editor.dirty = false;
  // The fixture stubs this out to keep the other tests still; here it is the
  // thing under test.
  delete s.editor.scrollCaretIntoView;
  s.editor.scrollCaretIntoView();
  assert.equal(Math.round(s.editor.scrollTop), 900 + 12 - VIEWPORT / 2,
    "the caret is centred rather than merely revealed");
  s.editor.caretRect = () => ({ x: 0, y: 10, w: 1.5, h: 24 });
  s.editor.scrollCaretIntoView();
  assert.equal(s.editor.scrollTop, 0, "and near the top there is nowhere further to go");
}

console.log("all passing");
