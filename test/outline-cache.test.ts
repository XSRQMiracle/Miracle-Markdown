// The outline's cache of heading text.
//
// A heading laid raw — the one under the caret, and every heading once source
// mode is on — is rendered a second time by `outline()`, because its laid text
// still carries the `#` that writes it. That second render is cached by the
// source line, which is only half of what it depends on: whether `# ==key==`
// reads as a highlight or as four equals signs is the inline options' business,
// and those change while the line does not.
import assert from "node:assert/strict";
import { Editor } from "../src/editor/editor.js";
import { DEFAULT_OPTIONS, DEFAULT_THEME, Typesetter } from "../src/engine/typeset.js";
import { parseBlocks, renderBlock } from "../src/markdown/parse.js";

// A real Typesetter is used rather than a stub, because the generation the
// cache keys on is its own; it measures through a canvas from the moment it is
// constructed, and nothing here asks it to lay anything out.
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    createElement: () => ({
      getContext: () => ({ font: "", measureText: () => ({ width: 0 }) }),
    }),
  },
});
(globalThis as any).window = Object.assign(new EventTarget(), { setInterval: () => 0 });
(globalThis as any).ResizeObserver = class { observe() {} };

const DOC = "# ==key==\n\n# H~2~O\n\n# plain heading\n";

function outlining() {
  const typesetter = new Typesetter({ ...DEFAULT_THEME }, {
    ...DEFAULT_OPTIONS,
    inline: { ...DEFAULT_OPTIONS.inline },
  });
  const editor = Object.create(Editor.prototype) as any;
  Object.assign(editor, {
    text: DOC,
    typesetter,
    headingTexts: new Map<string, string>(),
    dirty: false,
    // Every heading is laid raw, which is what source mode does and what the
    // caret does to one of them: it is the branch that renders again.
    blocks: parseBlocks(DOC)
      .filter((b) => b.type === "heading")
      .map((block, n) => ({ block, raw: true, rendered: renderBlock(block, true), y: n * 40 })),
    invalidate() {},
    schedule() {},
  });
  return editor;
}

const texts = (editor: any): string[] => editor.outline().map((entry: any) => entry.text);

{
  const editor = outlining();
  assert.deepEqual(texts(editor), ["==key==", "H~2~O", "plain heading"],
    "with highlight and subscript off, both markers are ordinary punctuation");

  editor.setOptions({ inline: { ...editor.options.inline, highlight: true, subscript: true } });
  assert.deepEqual(texts(editor), ["key", "H2O", "plain heading"],
    "turning them on shows each heading as it now parses, with no edit to the document");

  editor.setOptions({ inline: { ...editor.options.inline, highlight: false, subscript: false } });
  assert.deepEqual(texts(editor), ["==key==", "H~2~O", "plain heading"],
    "and turning them off again puts the markers back");
}

{
  const editor = outlining();
  texts(editor);
  editor.setOptions({ inline: { ...editor.options.inline, highlight: true } });
  assert.deepEqual(texts(editor), ["key", "H~2~O", "plain heading"],
    "highlight is not subscript: a tilde pair stays literal until it is asked for");
}

{
  const editor = outlining();
  texts(editor);
  editor.setOptions({ inline: { ...editor.options.inline, subscript: true } });
  assert.deepEqual(texts(editor), ["==key==", "H2O", "plain heading"],
    "and an equals pair stays literal while only subscripts are on");
}

{
  // The cache still has to earn its place — `outline()` is asked again on every
  // painted frame. Poisoning an entry is the only way to see it being read
  // without a parser to count calls, and the same sentinel then shows that the
  // option change empties the map rather than merely re-keying part of it.
  const editor = outlining();
  texts(editor);
  editor.headingTexts.set("# plain heading", "answered from the cache");
  assert.equal(texts(editor).at(-1), "answered from the cache",
    "a second outline() answers from the cache instead of rendering the line again");

  editor.setOptions({ inline: { ...editor.options.inline, highlight: true } });
  assert.equal(texts(editor).at(-1), "plain heading",
    "and an option change drops every entry, including headings it could not have changed");
}
