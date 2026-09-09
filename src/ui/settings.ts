/**
 * The handful of choices that outlive a window.
 *
 * Everything here dresses the app rather than describing the document, which
 * is why it belongs to the installation and not to the file. Typesetting
 * options deliberately stay out: they change how the text breaks, so they are
 * a property of the document and travel with it.
 *
 * Stored as one JSON blob under one key, and read defensively — a value that
 * has been hand-edited, or written by an older build, must not stop the app
 * from starting.
 */

import type { Appearance, BodyFace, SkinName } from "./skin.js";
import { SKINS } from "./skin.js";
import { BODY_FACES } from "./fonts.js";

export type SidebarTab = "files" | "outline" | "article";

export interface AppSettings {
  skin: SkinName;
  appearance: Appearance;
  bodyFace: BodyFace;
  sidebarVisible: boolean;
  sidebarTab: SidebarTab;
}

export const DEFAULT_SETTINGS: AppSettings = {
  skin: "organic",
  appearance: "system",
  bodyFace: "theme",
  sidebarVisible: true,
  sidebarTab: "outline",
};

const KEY = "miracle-markdown.settings";

const SKIN_NAMES = new Set<string>(SKINS.map((s) => s.name));
const APPEARANCES = new Set(["light", "dark", "system"]);
const FACES = new Set<string>(["theme", ...BODY_FACES.map((f) => f.id)]);
const TABS = new Set(["files", "outline", "article"]);

function coerce(raw: unknown): AppSettings {
  const settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return settings;
  const value = raw as Record<string, unknown>;
  if (typeof value.skin === "string" && SKIN_NAMES.has(value.skin)) {
    settings.skin = value.skin as SkinName;
  }
  if (typeof value.appearance === "string" && APPEARANCES.has(value.appearance)) {
    settings.appearance = value.appearance as Appearance;
  }
  if (typeof value.bodyFace === "string" && FACES.has(value.bodyFace)) {
    settings.bodyFace = value.bodyFace as BodyFace;
  }
  if (typeof value.sidebarVisible === "boolean") settings.sidebarVisible = value.sidebarVisible;
  if (typeof value.sidebarTab === "string" && TABS.has(value.sidebarTab)) {
    settings.sidebarTab = value.sidebarTab as SidebarTab;
  }
  return settings;
}

export function loadSettings(): AppSettings {
  try {
    const stored = window.localStorage.getItem(KEY);
    return stored ? coerce(JSON.parse(stored)) : { ...DEFAULT_SETTINGS };
  } catch {
    // A private window, cleared site data, or a storage-blocking policy. The
    // app runs on the defaults rather than refusing to start.
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Not being able to remember the choice is not a reason to reject it.
  }
}
