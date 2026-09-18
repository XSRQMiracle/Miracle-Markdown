/**
 * The seam between the editor and its host.
 *
 * Running under Tauri the file operations go through the Rust shell; running
 * in a plain browser during development they fall back to the download and
 * file-input paths, so the whole app stays testable without a native build.
 */

import {
  decodeDocumentText,
  encodeDocumentText,
  type LineEnding,
} from "./markdown/document.js";

interface TauriInternals {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

function tauri(): TauriInternals | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__ ?? null;
}

export const isDesktop = (): boolean => tauri() !== null;

export interface OpenResult {
  path: string | null;
  contents: string;
  lineEnding: LineEnding;
  /** Whether the file on disk began with a byte order mark. */
  bom: boolean;
}

/** Ask the user for a markdown file and return its contents. */
export async function openDocument(): Promise<(() => Promise<OpenResult>) | null> {
  const api = tauri();
  if (api) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    });
    if (typeof picked !== "string") return null;
    return async () => {
      const source = await api.invoke<string>("read_file", { path: picked });
      const decoded = decodeDocumentText(source);
      return { path: picked, contents: decoded.text, lineEnding: decoded.lineEnding, bom: decoded.bom };
    };
  }

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,.txt,text/markdown,text/plain";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve(async () => {
        const decoded = decodeDocumentText(await file.text());
        return { path: file.name, contents: decoded.text, lineEnding: decoded.lineEnding, bom: decoded.bom };
      });
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** One entry in a folder, as the sidebar's tree shows it. */
export interface FolderEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** Bytes; zero for a directory. */
  size: number;
  /** Milliseconds since the epoch, or zero when the platform will not say. */
  modified: number;
}

/** Whether this host can show a file tree at all. */
export const canBrowseFiles = (): boolean => tauri() !== null;

/** Ask for a folder to show in the sidebar. */
export async function openFolder(): Promise<string | null> {
  if (!tauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
}

/**
 * List one level of a folder.
 *
 * One level rather than the whole tree, because the tree is drawn lazily: a
 * notes folder inside a home directory would cost seconds to walk eagerly,
 * and the panel only needs what it is about to show.
 */
export async function listFolder(path: string): Promise<FolderEntry[]> {
  const api = tauri();
  if (!api) return [];
  return api.invoke<FolderEntry[]>("list_folder", { path });
}

/** Read a document the tree already knows the path of. */
export async function readDocumentAt(path: string): Promise<OpenResult> {
  const api = tauri();
  if (!api) throw new Error("此环境无法读取文件");
  const decoded = decodeDocumentText(await api.invoke<string>("read_file", { path }));
  return { path, contents: decoded.text, lineEnding: decoded.lineEnding, bom: decoded.bom };
}

/**
 * Let the shell serve the pictures in a folder to the renderer.
 *
 * The asset protocol starts with an empty scope, so this is what makes a local
 * image loadable at all. It is called for the folder the open document lives
 * in and for the folder the sidebar is showing, which are the two places the
 * reader has actually pointed the application at. A host with no asset
 * protocol — a plain browser — has nothing to grant.
 */
export async function allowImagesIn(folder: string): Promise<void> {
  const api = tauri();
  if (!api || !folder) return;
  try {
    await api.invoke("allow_images_in", { path: folder });
  } catch (error) {
    // A folder that has since moved is not worth a dialog: the pictures in it
    // will show their placeholders, which says the same thing in place.
    console.warn("could not open the image folder", error);
  }
}

/** Save the document, prompting for a location when there is not one yet. */
export async function saveDocument(
  path: string | null,
  contents: string,
  lineEnding: LineEnding = "\n",
  bom = false,
): Promise<{ path: string | null } | null> {
  const encoded = encodeDocumentText(contents, lineEnding, bom);
  const api = tauri();
  if (api) {
    let target = path;
    if (!target) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const picked = await save({
        defaultPath: "untitled.md",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (typeof picked !== "string") return null;
      target = picked;
    }
    await api.invoke("write_file", { path: target, contents: encoded });
    return { path: target };
  }

  // In the browser, hand the file to the download path instead.
  const blob = new Blob([encoded], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = path ?? "untitled.md";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { path };
}

/**
 * Open a second editor.
 *
 * On macOS the windows share a tabbing identifier, so the new one arrives as a
 * tab in the same window rather than as a window of its own — which is what
 * "new tab" means on that platform, and it costs nothing on the others.
 *
 * A document lives in its window: two tabs are two sessions, and neither can
 * take the other's unsaved work with it.
 */
export async function newWindow(): Promise<boolean> {
  const api = tauri();
  if (!api) return window.open(window.location.href, "_blank") !== null;

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  // Labels must be unique for the life of the app and match [a-zA-Z0-9-/:_].
  const label = `doc-${windowSerial()}`;
  const created = new WebviewWindow(label, {
    url: window.location.pathname,
    title: "Miracle Markdown",
    width: 1100,
    height: 780,
    minWidth: 480,
    minHeight: 400,
    titleBarStyle: "visible",
    tabbingIdentifier: "app.miracle.markdown",
  });
  return new Promise((resolve) => {
    void created.once("tauri://created", () => resolve(true));
    void created.once("tauri://error", (event) => {
      console.error("could not open a new window", event.payload);
      resolve(false);
    });
  });
}

/** Monotonic within this window, and salted so two windows opening at the same
 *  moment cannot pick the same label. */
let serial = 0;
function windowSerial(): string {
  serial += 1;
  return `${Date.now().toString(36)}-${serial}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Open a link somewhere outside the editor.
 *
 * The destination comes from the document, which is not necessarily something
 * the reader wrote, so only the schemes that mean "somewhere else to read"
 * are honoured: a `javascript:` or `file:` destination in a downloaded note
 * would otherwise be one modified click away from running. Anything else is
 * declined, and the caller is told so.
 */
export async function openExternal(url: string): Promise<boolean> {
  const target = url.trim();
  if (!/^(https?|mailto):/i.test(target)) return false;
  const api = tauri();
  if (api) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(target);
  } else {
    window.open(target, "_blank", "noopener,noreferrer");
  }
  return true;
}

/**
 * Protect both window close and application quit through one native event.
 *
 * Listening on this window rather than globally: closing one window asks only
 * that window, and only a quit asks them all. A plain `listen` would take the
 * broadcast either way and put this window's dialog on screen because some
 * other window was being closed.
 */
export async function installDesktopCloseHandler(close: () => void): Promise<void> {
  const api = tauri();
  if (!api) return;
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  await getCurrentWebviewWindow().listen("document-close-requested", close);
  await api.invoke("protect_document");
}

export async function finishDesktopClose(): Promise<void> {
  await tauri()!.invoke("finish_close");
}
