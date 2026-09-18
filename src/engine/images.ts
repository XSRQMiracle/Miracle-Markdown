/**
 * Image loading.
 *
 * Layout is synchronous — a paragraph is measured and broken in one pass on
 * every keystroke — but an image's intrinsic size is only known once the file
 * has been decoded. The same shape the math bridge uses applies here: ask for
 * the image, get whatever is known right now, and re-typeset when the answer
 * changes. Until then the placeholder carries the alt text, which is both the
 * honest thing to show and roughly the right width.
 */

export type ImageStatus = "loading" | "ready" | "error";

export interface LoadedImage {
  status: ImageStatus;
  /** Intrinsic size in CSS pixels; zero until the image has decoded. */
  width: number;
  height: number;
  source: CanvasImageSource | null;
}

const LOADING: LoadedImage = { status: "loading", width: 0, height: 0, source: null };
const BROKEN: LoadedImage = { status: "error", width: 0, height: 0, source: null };

const cache = new Map<string, LoadedImage>();
const listeners = new Set<() => void>();
const reported = new Set<string>();

/** Called when an image finishes loading, so the document can re-typeset. */
export function onImageSettled(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function settled(): void {
  for (const listener of listeners) listener();
}

/**
 * Undo the percent-encoding of a `file:` URL's path, one escape at a time.
 *
 * `decodeURI` is all-or-nothing: a single stray percent anywhere in the string
 * — `100%.png`, or a truncated `%E4%B8` — makes it throw `URIError` and lose
 * the whole path, which is how one mistyped address used to take the entire
 * document's layout with it. A browser handed `file:///tmp/100%.png` does not
 * refuse the URL; it leaves the percent standing and opens the file of that
 * name, because a percent that begins no valid escape is simply a percent.
 *
 * Decoding each maximal run of well-formed `%XX` on its own reproduces that.
 * A run rather than a single escape, because one non-ASCII character is
 * several bytes and only decodes correctly when its escapes are handed over
 * together.
 */
function decodePath(path: string): string {
  return path.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURI(run);
    } catch {
      // Hex digits that spell no character — an incomplete UTF-8 sequence.
      // The bytes as written are the best guess at what was meant.
      return run;
    }
  });
}

/**
 * A URL scheme, deliberately requiring two characters before the colon.
 *
 * RFC 3986 permits a one-letter scheme, but none has ever been registered and
 * `C:\photo.png` is not one — reading a drive letter as a scheme is exactly how
 * an absolute Windows path came to be handed to the webview untouched.
 */
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;
/** A drive-rooted Windows path, captured so the root can be put back. */
const DRIVE = /^([A-Za-z]:)[\\/]/;

/** Where a relative image destination is measured from; "" when unknown. */
let base = "";

/**
 * The folder part of a path, or "" when the path names no folder at all.
 *
 * A browser's file input hands back a bare name with no directory in it, and
 * treating that name as a folder would measure every relative image against a
 * folder that does not exist. Stripping the last component is only right when
 * there was a separator to strip.
 */
export function directoryOf(path: string | null | undefined): string {
  if (!path) return "";
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut < 0) return "";
  return cut === 0 ? "/" : path.slice(0, cut);
}

/**
 * Tell the resolver which document the relative destinations belong to.
 *
 * A markdown image is nearly always written relative to the file it sits in,
 * so without this the commonest case cannot be resolved at all. Reports
 * whether the folder actually moved, because the cache is keyed by resolved
 * URL and a document that changes folder makes every relative entry in it
 * wrong.
 */
export function setImageBase(directory: string): boolean {
  const next = directory.replace(/[\\/]+$/, "") || (directory.startsWith("/") ? "/" : "");
  if (next === base) return false;
  base = next;
  invalidateImages();
  return true;
}

/** The folder relative destinations are currently measured from. */
export function imageBase(): string {
  return base;
}

/**
 * Collapse "." and ".." and any repeated separators out of a path.
 *
 * Not cosmetic: Tauri's asset protocol refuses outright — 403, with nothing in
 * the webview to say why — any request whose path still holds a parent
 * component, so `../images/photo.png` has to be resolved here or not at all.
 */
function normalise(path: string): string {
  const drive = DRIVE.exec(path);
  const rooted = drive !== null || path.startsWith("/") || path.startsWith("\\");
  const separator = drive ? "\\" : "/";
  const body = drive ? path.slice(drive[0].length) : path.replace(/^[\\/]/, "");
  const parts: string[] = [];
  for (const part of body.split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    // Climbing past the root stays at the root, which is what every filesystem
    // does with "/..", rather than escaping into nonsense.
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join(separator);
  if (drive) return `${drive[1]}${separator}${joined}`;
  return rooted ? `/${joined}` : joined;
}

/**
 * Resolve a markdown image destination to something the browser can fetch.
 *
 * A webview cannot read `file://` directly, so a local path has to go through
 * Tauri's asset protocol, and that protocol will only serve an absolute path
 * with no parent components left in it. Everything here is the arithmetic of
 * getting from what an author writes to that: a relative path measured against
 * the document's own folder, a drive letter told apart from a scheme, and
 * percent escapes undone the way a browser undoes them.
 *
 * Split out from `resolveSource` so that the document's folder and the host's
 * converter are arguments rather than module state, which is what makes the
 * rules above testable without a webview.
 */
export function resolveImageSource(
  src: string,
  documentBase: string,
  convert: ((path: string) => string) | null,
): string {
  const trimmed = src.trim();
  if (!trimmed) return "";

  // The drive-letter test comes first because `C:\photo.png` satisfies any
  // reasonable scheme test as well, and whichever runs first decides.
  const drive = DRIVE.test(trimmed);
  const isFile = /^file:/i.test(trimmed);
  if (!drive && !isFile && SCHEME.test(trimmed)) return trimmed;

  let path = trimmed;
  if (isFile) {
    const authority = /^file:\/\/([^/]*)/i.exec(path)?.[1];
    // A file URL with a host names a share on another machine, which the asset
    // protocol cannot serve; saying so is better than quietly resolving the
    // host as though it were a folder.
    if (authority && authority.toLowerCase() !== "localhost") return "";
    path = path.replace(/^file:(\/\/[^/]*)?/i, "").replace(/^\/([A-Za-z]:)/, "$1");
  }
  // CommonMark calls a destination a URL, so a space arrives as %20 whether or
  // not the address names a local file. `decodeURI` leaves the reserved
  // characters alone, so an encoded separator stays encoded and cannot invent
  // a path component below.
  path = decodePath(path);

  const absolute = DRIVE.test(path) || path.startsWith("/") || path.startsWith("\\");
  if (!absolute) {
    // Without a folder to measure from, guessing would silently load the wrong
    // file; handing the destination back lets a plain browser serve it.
    if (!documentBase) return trimmed;
    path = `${documentBase}/${path}`;
  }

  const resolved = normalise(path);
  return convert ? convert(resolved) : resolved;
}

/**
 * Resolve a destination using the document's folder and the running host.
 *
 * Remote images are deliberately left to fail. The destination comes out of a
 * document the reader may not have written, and an `img` pointed at https is
 * an unauthenticated request fired the moment the file is opened: it reports
 * the reader's address and the time they opened it, and a URL made unique per
 * recipient reports which of them it was. A tracking pixel is not something a
 * markdown editor should fetch on the author's behalf, so the content policy
 * grants no remote image source and such a picture shows its placeholder.
 * Following the link still opens it in a browser, which is a decision the
 * reader makes rather than one the document makes for them.
 */
export function resolveSource(src: string): string {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: (p: string) => string } })
    .__TAURI_INTERNALS__;
  return resolveImageSource(src, base, internals?.convertFileSrc ?? null);
}

/**
 * What is known about an image right now. The first call starts the load and
 * reports "loading"; `onImageSettled` fires when there is more to say.
 */
export function requestImage(src: string): LoadedImage {
  let url: string;
  try {
    url = resolveSource(src);
  } catch (error) {
    // Layout is one synchronous pass over the whole document, with no frame
    // between this call and the paragraph after it, so anything thrown here
    // does not spoil one picture — it abandons the document and leaves the
    // page showing whatever was last drawn. An address the host cannot make
    // sense of is exactly what the broken placeholder is for, and treating it
    // as one is the only outcome that keeps the rest of the prose on screen.
    //
    // Saying so is the other half: a guard that quietly returned a placeholder
    // would let a real defect in `resolveSource` pass for a missing file for
    // ever. Once per address, because this runs on every keystroke.
    if (!reported.has(src)) {
      reported.add(src);
      console.warn("could not resolve the image address", src, error);
    }
    return BROKEN;
  }
  if (!url) return BROKEN;

  const hit = cache.get(url);
  if (hit) return hit;

  cache.set(url, LOADING);
  const element = new Image();
  element.decoding = "async";
  element.addEventListener("load", () => {
    cache.set(url, {
      status: "ready",
      width: element.naturalWidth,
      height: element.naturalHeight,
      source: element,
    });
    settled();
  });
  element.addEventListener("error", () => {
    cache.set(url, BROKEN);
    settled();
  });
  element.src = url;
  return LOADING;
}

/** Forget every image, so a document reload re-fetches rather than reusing. */
export function invalidateImages(): void {
  cache.clear();
  // A reload is the reader trying again, so the complaint is worth repeating:
  // the alternative silences the one message that explains a blank picture for
  // the rest of the session.
  reported.clear();
}

/**
 * Fit an image into the available measure.
 *
 * An intrinsic size is in device-independent pixels, which is the same unit
 * the layout works in, so a picture only needs scaling when it is wider than
 * the column. Aspect ratio is preserved: a squashed illustration reads as a
 * bug, an unexpectedly small one does not.
 */
export function fitImage(
  intrinsicWidth: number,
  intrinsicHeight: number,
  measure: number,
): { width: number; height: number } {
  if (intrinsicWidth <= 0 || intrinsicHeight <= 0) return { width: 0, height: 0 };
  if (intrinsicWidth <= measure) return { width: intrinsicWidth, height: intrinsicHeight };
  const scale = measure / intrinsicWidth;
  return { width: measure, height: intrinsicHeight * scale };
}
