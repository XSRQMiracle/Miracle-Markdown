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
 * Resolve a markdown image destination to something the browser can fetch.
 *
 * A webview cannot read `file://` directly, so a local path has to go through
 * Tauri's asset protocol. Relative paths are left alone: resolving one needs
 * the document's own location, which the editor does not carry yet, and
 * guessing would silently load the wrong file.
 */
export function resolveSource(src: string): string {
  const trimmed = src.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^file:/i.test(trimmed)) return trimmed;

  const internals = (window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: (p: string) => string } })
    .__TAURI_INTERNALS__;
  const convert = internals?.convertFileSrc;
  if (!convert) return trimmed;

  const path = /^file:\/\//i.test(trimmed)
    ? decodePath(trimmed.replace(/^file:\/\//i, ""))
    : trimmed;
  // Only an absolute path can be resolved without knowing where the document
  // lives; a relative one is left for the webview to interpret.
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? convert(path) : trimmed;
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
