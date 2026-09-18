import { normalizeLineEndings, type LineEnding } from "./document.js";

export interface SessionDocument {
  path: string | null;
  contents: string;
  lineEnding: LineEnding;
  /** Whether the file began with a byte order mark, so saving can restore it. */
  bom?: boolean;
}

export type LeaveDecision = "save" | "discard" | "cancel";
export interface SessionPorts {
  open(): Promise<(() => Promise<SessionDocument>) | null>;
  save(path: string | null, contents: string, lineEnding: LineEnding, bom: boolean): Promise<{ path: string | null } | null>;
  confirmLeave(name: string): Promise<LeaveDecision>;
  loaded(document: SessionDocument): void;
  changed(): void;
}

interface DocumentState {
  text: string;
  savedText: string;
  revision: number;
  savedRevision: number;
  path: string | null;
  lineEnding: LineEnding;
  bom: boolean;
}

/** Own the identity of a document and the exact snapshot last written for it. */
export class DocumentSession {
  private current: DocumentState;
  private saveEpoch = 0;
  private saveTail: Promise<void> = Promise.resolve();
  private transitionTail: Promise<void> = Promise.resolve();
  private pendingSaves = 0;
  private pendingTransitions = 0;
  private closing = false;

  constructor(initial: SessionDocument, private ports: SessionPorts) {
    this.current = this.newDocument(initial);
  }

  private newDocument(document: SessionDocument): DocumentState {
    const text = normalizeLineEndings(document.contents);
    return {
      text, savedText: text, revision: 0, savedRevision: 0,
      path: document.path, lineEnding: document.lineEnding, bom: document.bom ?? false,
    };
  }

  get path(): string | null { return this.current.path; }
  get name(): string { return this.path?.split(/[\\/]/).pop() || "未命名"; }
  get text(): string { return this.current.text; }
  // Comparing the saved contents also recognizes undo back to the saved state.
  get dirty(): boolean {
    return this.current.revision !== this.current.savedRevision && this.current.text !== this.current.savedText;
  }
  get saving(): boolean { return this.pendingSaves > 0; }
  get transitioning(): boolean { return this.pendingTransitions > 0; }
  get isClosing(): boolean { return this.closing; }
  get needsUnloadProtection(): boolean { return this.dirty || this.saving; }

  updateText(text: string): void {
    if (text === this.current.text) return;
    this.current.text = text;
    this.current.revision++;
    this.ports.changed();
  }

  save(saveAs = false): Promise<boolean> {
    if (this.closing) return Promise.resolve(false);
    this.saveEpoch++;
    const document = this.current;
    const { text, revision, lineEnding, bom } = document;
    this.pendingSaves++;
    this.ports.changed();
    const operation = this.saveTail.then(async () => {
      // Resolve the destination when this queued write begins: a preceding
      // Save As may have established a new path for this very document.
      const saved = await this.ports.save(saveAs ? null : document.path, text, lineEnding, bom);
      if (!saved) return false;
      document.path = saved.path;
      document.savedText = text;
      document.savedRevision = revision;
      return true;
    });
    const settled = operation.finally(() => {
      this.pendingSaves--;
      this.ports.changed();
    });
    // A failed write must not poison the queue or mark its snapshot as saved.
    this.saveTail = settled.then(() => undefined, () => undefined);
    return settled;
  }

  /**
   * Replace the document.
   *
   * With no argument the host asks which one; with a reader, that one — the
   * file tree already knows the path, and a new document is a reader that
   * returns an empty one. Either way the unsaved-changes guard runs first.
   */
  open(picked?: () => Promise<SessionDocument>): Promise<boolean> {
    return this.transition(async () => {
      const read = picked ?? await this.ports.open();
      if (!read) return false;
      // Confirm after the picker/read completes, so edits made while either
      // was pending are included in the decision to replace the document.
      const replace = async (): Promise<boolean> => {
        const document = this.current;
        const revision = document.revision;
        const epoch = this.saveEpoch;
        // Read only after saving/discarding, including when opening the same
        // path. A read interrupted by another edit or save must be retried.
        const opened = await read();
        if (document !== this.current || revision !== document.revision || epoch !== this.saveEpoch) {
          return this.leave(replace);
        }
        this.current = this.newDocument(opened);
        this.ports.loaded({ ...opened, contents: this.current.text });
        this.ports.changed();
        return true;
      };
      return this.leave(replace);
    });
  }

  close(finish: () => Promise<void>): Promise<boolean> {
    return this.transition(() => this.leave(async () => {
      this.closing = true;
      this.ports.changed();
      try {
        await finish();
        return true;
      } catch (error) {
        this.closing = false;
        this.ports.changed();
        throw error;
      }
    }));
  }

  private transition(action: () => Promise<boolean>): Promise<boolean> {
    this.pendingTransitions++;
    this.ports.changed();
    const operation = this.transitionTail.then(() => this.closing ? false : action());
    const settled = operation.finally(() => {
      this.pendingTransitions--;
      this.ports.changed();
    });
    this.transitionTail = settled.then(() => undefined, () => undefined);
    return settled;
  }

  private async leave(perform: () => boolean | Promise<boolean>): Promise<boolean> {
    for (;;) {
      // A queued older snapshot can change what is on disk even if an undo
      // has temporarily made the current text look clean.
      while (this.pendingSaves) await this.saveTail;
      const document = this.current;
      const revision = document.revision;
      if (!this.dirty) return perform();
      const decision = await this.ports.confirmLeave(this.name);
      if (decision === "cancel") return false;
      if (document !== this.current || revision !== document.revision) continue;
      if (decision === "save") {
        if (!await this.save()) return false;
        // Saving does not freeze editing. Any newer revision needs its own
        // save/discard decision before the document can be replaced or closed.
        continue;
      }
      while (this.pendingSaves) await this.saveTail;
      if (document === this.current && revision === document.revision) return perform();
    }
  }
}
