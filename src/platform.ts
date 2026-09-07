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
      return { path: picked, contents: decoded.text, lineEnding: decoded.lineEnding };
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
        return { path: file.name, contents: decoded.text, lineEnding: decoded.lineEnding };
      });
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** Save the document, prompting for a location when there is not one yet. */
export async function saveDocument(
  path: string | null,
  contents: string,
  lineEnding: LineEnding = "\n",
): Promise<{ path: string | null } | null> {
  const encoded = encodeDocumentText(contents, lineEnding);
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

/** Protect both window close and application quit through one native event. */
export async function installDesktopCloseHandler(close: () => void): Promise<void> {
  const api = tauri();
  if (!api) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen("document-close-requested", close);
  await api.invoke("protect_document");
}

export async function finishDesktopClose(): Promise<void> {
  await tauri()!.invoke("finish_close");
}
