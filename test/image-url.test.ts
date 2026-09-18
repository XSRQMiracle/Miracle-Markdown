// A picture's address, and what an unreadable one costs.
//
// Layout is one synchronous pass over the whole document, so the image
// resolver sits on the critical path of every keystroke with no frame between
// it and the paragraph after it. Anything it throws is not a broken picture —
// it is a document that never lays out. These assertions pin both halves of
// the contract: percent-encoding is decoded the way a browser decodes it, and
// an address that defeats the host still costs nothing but its own box.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initSync } from "../crates/typeset-wasm/pkg/typeset_wasm.js";
import { DEFAULT_OPTIONS, DEFAULT_THEME, initEngine, Typesetter } from "../src/engine/typeset.js";
import { invalidateImages, requestImage, resolveSource } from "../src/engine/images.js";

// The asset protocol is a round trip: the markdown address is decoded to a
// real filesystem path, which the host re-encodes for the webview. Standing in
// for `convertFileSrc` with a visible marker keeps the path it was handed
// legible in a failure message.
let convertFileSrc: (path: string) => string = (path) => `asset:${path}`;
const warnings: string[] = [];

class StubImage {
  decoding = "";
  naturalWidth = 0;
  naturalHeight = 0;
  private handlers = new Map<string, (() => void)[]>();
  addEventListener(name: string, fn: () => void): void {
    const bucket = this.handlers.get(name) ?? [];
    bucket.push(fn);
    this.handlers.set(name, bucket);
  }
  // Nothing is fetched here, so the test decides what the fetch decided: a
  // src holding the marker below fails the way a missing file fails, on its
  // own turn of the event loop, which is the handshake `onImageSettled` was
  // written for.
  set src(value: string) {
    const event = value.includes("missing") ? "error" : "load";
    if (event === "load") {
      this.naturalWidth = 40;
      this.naturalHeight = 20;
    }
    queueMicrotask(() => { for (const fn of this.handlers.get(event) ?? []) fn(); });
  }
}

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { __TAURI_INTERNALS__: { convertFileSrc: (p: string) => convertFileSrc(p) } },
});
Object.defineProperty(globalThis, "Image", { configurable: true, value: StubImage });
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    createElement: () => ({
      getContext: () => ({
        font: "",
        measureText(text: string) {
          return { width: Array.from(text).length * 10, fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 4 };
        },
      }),
    }),
  },
});
console.warn = (message: string) => { warnings.push(String(message)); };

{
  // Percent-decoding a `file:` path. `decodeURI` over the whole string is
  // all-or-nothing, and one stray percent used to throw the address away —
  // and the document with it. A browser given the same URL keeps the percent
  // and opens the file of that name, so that is the answer wanted here.
  assert.equal(resolveSource("file:///tmp/my%20photo.png"), "asset:/tmp/my photo.png",
    "a legitimate escape is decoded to the character it stands for");
  assert.equal(resolveSource("file:///tmp/%E4%B8%AD%E6%96%87.png"), "asset:/tmp/中文.png",
    "consecutive escapes are decoded together, so a multi-byte character survives");
  assert.equal(resolveSource("file:///tmp/100%.png"), "asset:/tmp/100%.png",
    "a percent that begins no escape is a percent, not a reason to reject the path");
  assert.equal(resolveSource("file:///tmp/%ZZ.png"), "asset:/tmp/%ZZ.png",
    "and neither is a percent followed by something that is not hexadecimal");
  assert.equal(resolveSource("file:///tmp/100%/my%20photo.png"), "asset:/tmp/100%/my photo.png",
    "one unusable percent does not stop the usable escapes beside it decoding");
  assert.equal(resolveSource("file:///tmp/%E4%B8.png"), "asset:/tmp/%E4%B8.png",
    "hexadecimal that spells no character is left as the bytes it was written as");

  assert.equal(resolveSource("pics/50% off.png"), "pics/50% off.png",
    "a relative path is the webview's to interpret, percent and all");
  assert.equal(resolveSource("https://example.com/a%ZZ.png"), "https://example.com/a%ZZ.png",
    "a remote address is never decoded, so it cannot be malformed here");
}

{
  // The boundary is total. `resolveSource` reaches host code this module does
  // not own, and the placeholder already says everything a reader needs to
  // know about an address that leads nowhere.
  invalidateImages();
  warnings.length = 0;
  convertFileSrc = () => { throw new TypeError("no asset protocol on this host"); };

  const loaded = requestImage("file:///tmp/photo.png");
  assert.equal(loaded.status, "error",
    "a resolver that throws yields the broken placeholder, not a failed layout");
  assert.equal(loaded.source, null, "and nothing to draw with it");
  requestImage("file:///tmp/photo.png");
  requestImage("file:///tmp/photo.png");
  assert.equal(warnings.length, 1,
    "the failure is reported, once per address: a silent guard would hide a real defect, " +
    "and a message per layout would bury every other one");

  convertFileSrc = (path) => `asset:${path}`;
}

{
  // The two malformed addresses from the report, through the real engine,
  // beside a picture that works and prose that has to survive all of them.
  invalidateImages();
  initSync({ module: readFileSync("crates/typeset-wasm/pkg/typeset_wasm_bg.wasm") });
  await initEngine();
  const typesetter = new Typesetter({ ...DEFAULT_THEME }, {
    ...DEFAULT_OPTIONS, inline: { ...DEFAULT_OPTIONS.inline }, justify: false, protrusion: false,
  });
  await typesetter.ready;

  const source = [
    "Opening prose.",
    "![good](file:///tmp/present.png)",
    "![stray](file:///tmp/missing-100%.png)",
    "![invalid](file:///tmp/missing-%ZZ.png)",
    "Closing prose.",
  ].join("\n\n");

  const first = typesetter.layoutDocument(source, 1000, -1);
  assert.equal(first.blocks.filter((b) => b.block.type === "paragraph").length, 5,
    "a picture whose address cannot be decoded costs its own box and nothing else");

  // Every image has now reported back, so the second pass is the one the
  // editor draws after `onImageSettled` — which is why the caches go first,
  // exactly as `invalidateMath` drops them.
  await new Promise((resolve) => queueMicrotask(() => resolve(null)));
  typesetter.invalidate();
  const blocks = typesetter.layoutDocument(source, 1000, -1).blocks
    .filter((b) => b.block.type === "paragraph");
  const images = blocks.flatMap((b) => b.lines.flatMap((l) => l.runs))
    .flatMap((run) => (run.image ? [run.image] : []));

  assert.deepEqual([blocks[0], blocks[4]].map((b) => b.rendered.text.trim()),
    ["Opening prose.", "Closing prose."],
    "the prose on either side of a broken picture is set as though nothing happened");
  assert.ok(blocks[4].y > blocks[0].y, "and the document still stacks, top to bottom");

  assert.deepEqual(images.map((image) => image.status), ["ready", "error", "error"],
    "the picture that loads is drawn, and only the ones that fail take the placeholder");
  assert.equal(images[0].width, 40, "a good image beside two bad ones still reports its size");
  for (const image of images.slice(1)) {
    assert.equal(image.fallback?.text, image.alt,
      "a failed picture is stood in for by its alt text, which is what the author wrote");
  }
  assert.deepEqual(blocks.slice(1, 4).map((b) => b.lines[0].width > 0), [true, true, true],
    "every placeholder reserves the width of what will be drawn, so the line is broken honestly");
}

{
  // Without alt text there is nothing honest to put in the box but the
  // address that failed, marked as the failure it is.
  invalidateImages();
  const typesetter = new Typesetter({ ...DEFAULT_THEME }, {
    ...DEFAULT_OPTIONS, inline: { ...DEFAULT_OPTIONS.inline }, justify: false, protrusion: false,
  });
  await typesetter.ready;
  const source = "![](file:///tmp/missing-100%.png)";
  typesetter.layoutDocument(source, 1000, -1);
  await new Promise((resolve) => queueMicrotask(() => resolve(null)));
  typesetter.invalidate();
  const image = typesetter.layoutDocument(source, 1000, -1).blocks
    .flatMap((b) => b.lines.flatMap((l) => l.runs))
    .flatMap((run) => (run.image ? [run.image] : []))[0];
  assert.equal(image.status, "error");
  assert.equal(image.fallback?.text, "⚠ file:///tmp/missing-100%.png",
    "an unnamed picture that fails shows the address, so the author can see what to correct");
}

console.log("ok   an undecodable image address costs its own box, not the document");
