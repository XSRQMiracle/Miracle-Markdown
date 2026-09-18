// Where a picture's address points.
//
// Between what an author writes and what the webview can fetch sit four
// separate rules, and each of them was getting one case wrong. A markdown
// destination is a URL, so it may be percent-encoded; it is usually relative,
// and relative to the file it sits in rather than to anything the renderer
// knows; an absolute Windows path opens with something that is a legal URL
// scheme as far as any regular expression is concerned; and Tauri's asset
// protocol refuses, with a bare 403, any path that still has a `..` in it.
//
// `resolveImageSource` takes the document's folder and the host's converter as
// arguments precisely so that all four can be stated here without a webview.
import assert from "node:assert/strict";
import { directoryOf, resolveImageSource } from "../src/engine/images.js";

/** Stand in for Tauri's `convertFileSrc`, keeping the path it was handed. */
const convert = (path: string) => `asset:${path}`;
/** Resolve as the desktop shell would, from a document in `base`. */
const from = (base: string, src: string) => resolveImageSource(src, base, convert);
/** Resolve as a plain browser would, with no asset protocol to convert with. */
const web = (base: string, src: string) => resolveImageSource(src, base, null);

// --- relative destinations, which is what almost every document writes ------
{
  assert.equal(from("/notes", "photo.png"), "asset:/notes/photo.png",
    "a bare name is measured against the folder the document lives in");
  assert.equal(from("/notes/posts", "../images/photo.png"), "asset:/notes/images/photo.png",
    "and one that climbs is resolved here, because the asset protocol refuses a `..` outright");
  assert.equal(from("/notes", "./photo.png"), "asset:/notes/photo.png",
    "a leading `./` says nothing and is dropped");
  assert.equal(from("/notes", "a//b///photo.png"), "asset:/notes/a/b/photo.png",
    "repeated separators collapse");
  assert.equal(from("/notes/posts", "../../photo.png"), "asset:/photo.png",
    "climbing more than once is still arithmetic");
  assert.equal(from("/", "../../photo.png"), "asset:/photo.png",
    "and climbing past the root stays at the root, as every filesystem does");
}

// --- no folder to measure from ---------------------------------------------
{
  assert.equal(from("", "photo.png"), "photo.png",
    "with no document folder a relative address is handed back rather than guessed at");
  assert.equal(from("", "/tmp/photo.png"), "asset:/tmp/photo.png",
    "an absolute one never needed the folder in the first place");
}

// --- absolute POSIX and file: URLs -----------------------------------------
{
  assert.equal(from("/notes", "/tmp/photo.png"), "asset:/tmp/photo.png",
    "an absolute path goes through untouched");
  assert.equal(from("/notes", "file:///tmp/photo.png"), "asset:/tmp/photo.png",
    "a file URL is the same path wearing a scheme");
  assert.equal(from("/notes", "file://localhost/tmp/photo.png"), "asset:/tmp/photo.png",
    "localhost is this machine and means nothing more");
  assert.equal(from("/notes", "file://server/share/photo.png"), "",
    "but a file URL naming another machine is a share the asset protocol cannot serve");
  assert.equal(from("/notes", "file:///tmp/../etc/photo.png"), "asset:/etc/photo.png",
    "a `..` inside a file URL is resolved like any other");
}

// --- a drive letter is not a scheme ----------------------------------------
//
// This is the case that made every absolute Windows path fail: `c` satisfies
// the scheme grammar, so a scheme test that runs first claims the path and
// hands it to the webview unconverted. The order of the two tests is the fix,
// and these assertions are what hold it in place.
{
  assert.equal(from("C:\\notes", "C:\\pics\\photo.png"), "asset:C:\\pics\\photo.png",
    "a drive-rooted path is a path, not a `c:` URL");
  assert.equal(from("C:\\notes", "C:/pics/photo.png"), "asset:C:\\pics\\photo.png",
    "forward slashes are accepted and normalised, as Windows itself accepts them");
  assert.equal(from("C:\\notes\\posts", "..\\images\\photo.png"), "asset:C:\\notes\\images\\photo.png",
    "and a relative Windows path climbs the same way");
  assert.equal(from("C:\\notes", "photo.png"), "asset:C:\\notes\\photo.png",
    "a bare name under a drive keeps the drive's separator");
  assert.equal(from("/notes", "file:///C:/pics/photo.png"), "asset:C:\\pics\\photo.png",
    "a Windows file URL sheds the slash the URL form puts before the drive");
  assert.equal(from("C:\\notes", "D:\\other\\photo.png"), "asset:D:\\other\\photo.png",
    "another drive is still absolute");
}

// --- percent encoding, spaces and Chinese filenames ------------------------
{
  assert.equal(from("/notes", "my%20photo.png"), "asset:/notes/my photo.png",
    "a destination is a URL, so an encoded space decodes even when the path is relative");
  assert.equal(from("/notes", "my photo.png"), "asset:/notes/my photo.png",
    "a literal space is left as it was written");
  assert.equal(from("/notes", "%E4%B8%AD%E6%96%87.png"), "asset:/notes/中文.png",
    "and a Chinese filename decodes from its escapes");
  assert.equal(from("/笔记", "照片.png"), "asset:/笔记/照片.png",
    "or arrives already written in them");
  assert.equal(from("/notes", "100%.png"), "asset:/notes/100%.png",
    "a percent beginning no escape is a percent, not a reason to lose the picture");
  assert.equal(from("/notes", "a%2Fb.png"), "asset:/notes/a%2Fb.png",
    "an encoded separator stays encoded, so it cannot invent a folder that is not there");
}

// --- addresses that are somebody else's business ---------------------------
{
  for (const remote of [
    "https://example.com/photo.png",
    "http://example.com/photo.png",
    "data:image/png;base64,iVBORw0KGgo=",
  ]) {
    assert.equal(from("/notes", remote), remote, `${remote} is passed through unchanged`);
  }
  assert.equal(from("/notes", ""), "", "an empty destination resolves to nothing");
  assert.equal(from("/notes", "   "), "", "and so does one that is only spaces");
}

// --- without a host to convert with ----------------------------------------
{
  assert.equal(web("/notes", "photo.png"), "/notes/photo.png",
    "a browser gets the resolved path itself, with no asset scheme wrapped round it");
  assert.equal(web("/notes", "https://example.com/a.png"), "https://example.com/a.png",
    "and a remote address is still nobody's business but the browser's");
}

// --- the folder a document lives in ----------------------------------------
{
  assert.equal(directoryOf("/notes/posts/a.md"), "/notes/posts", "the folder is the path without its last part");
  assert.equal(directoryOf("C:\\notes\\a.md"), "C:\\notes", "either separator names it");
  assert.equal(directoryOf("/a.md"), "/", "a document at the root lives at the root");
  assert.equal(directoryOf("a.md"), "",
    "a bare filename names no folder — a browser's file input hands back one of these, " +
    "and treating it as a folder would measure every picture against somewhere that does not exist");
  assert.equal(directoryOf(null), "", "and an unsaved document has nowhere to measure from");
}

console.log("all passing");
