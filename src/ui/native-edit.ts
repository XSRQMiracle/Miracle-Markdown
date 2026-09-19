/**
 * What the native Edit menu means here.
 *
 * The menu's Undo and Redo are the application's, not the webview's: they
 * carry ⌘Z and ⇧⌘Z, and on macOS a menu item's key equivalent is taken before
 * the keystroke ever reaches the page. So the routing below is not a
 * convenience — it is the only thing standing between those two chords and
 * doing nothing at all.
 *
 * There are two histories in the window and they are both right. The document
 * keeps its own, because the text lives in the engine rather than in the DOM;
 * and every ordinary field in the chrome — the search box, the replacement
 * box, a dialog — keeps the platform's, which is the behaviour anyone typing
 * in a text field expects and which it would be rude to take away.
 *
 * Select All is here for a related reason and not the same one. Cut, Copy and
 * Paste can stay with the platform because each of them raises a DOM event
 * that the editor intercepts, substituting the document's own range for the
 * hidden textarea's. `selectAll:` raises no event at all — it simply selects
 * what is in the focused field, and that field is a keystroke collector which
 * is empty between keystrokes. So the menu item selected nothing, and the
 * next character typed was appended instead of replacing the document.
 */

export type EditCommand = "undo" | "redo" | "selectAll";
/** Whose history a command should drive. */
export type HistoryTarget = "document" | "field";

/** The shape of a focused element this needs to ask about. */
export interface FocusedElement {
  tagName?: string;
  isContentEditable?: boolean;
}

/**
 * Decide which history an Edit-menu command belongs to.
 *
 * The editing surface is the default rather than a special case: the document
 * is what the window is for, and a command arriving with focus nowhere in
 * particular — on the body, after a dialog has closed, or on a button — means
 * the document. Only a real text field earns the platform's own history.
 */
export function historyTargetFor(
  active: FocusedElement | null | undefined,
  isEditorSurface: boolean,
): HistoryTarget {
  if (isEditorSurface) return "document";
  if (!active) return "document";
  const tag = (active.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA") return "field";
  return active.isContentEditable === true ? "field" : "document";
}
