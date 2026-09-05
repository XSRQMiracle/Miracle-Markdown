/**
 * The seam between the editor and its host.
 *
 * Running under Tauri the file operations go through the Rust shell; running
 * in a plain browser during development they fall back to the download and
 * file-input paths, so the whole app stays testable without a native build.
 */

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
}

/** Ask the user for a markdown file and return its contents. */
export async function openDocument(): Promise<OpenResult | null> {
  const api = tauri();
  if (api) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    });
    if (typeof picked !== "string") return null;
    const contents = await api.invoke<string>("read_file", { path: picked });
    return { path: picked, contents };
  }

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,.txt,text/markdown,text/plain";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve({ path: file.name, contents: await file.text() });
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** Save the document, prompting for a location when there is not one yet. */
export async function saveDocument(
  path: string | null,
  contents: string,
): Promise<string | null> {
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
    await api.invoke("write_file", { path: target, contents });
    return target;
  }

  // In the browser, hand the file to the download path instead.
  const blob = new Blob([contents], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = path ?? "untitled.md";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return path;
}
