/**
 * The faces the page can be set in.
 *
 * Canvas resolves each character from the first family in the stack that has
 * it, and every CJK serif carries a complete Latin repertoire — so a Latin
 * face listed *after* a CJK one is unreachable, and the Latin in a mixed
 * document is drawn by the Song face. That is what "字母间距很奇怪" was: Songti
 * SC kerns nothing (0 of 5929 pairs, against Iowan Old Style's 201), sets its
 * digits narrower than its lowercase, and gives an em dash a full CJK em.
 *
 * So the Latin face comes first and the CJK tail is appended. A reader picks
 * the Latin half; the CJK half follows from whether they picked a serif or a
 * sans, because mixing those two is the one combination that always looks
 * wrong.
 */

/** Appended to every serif choice. */
const CJK_SERIF =
  '"Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", "Songti SC", SimSun, serif';
/** Appended to every sans choice. */
const CJK_SANS = '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif';

export interface BodyFaceOption {
  id: string;
  label: string;
  kind: "serif" | "sans";
  /** The family to test for before offering this choice. Null means the
   *  option is a stack rather than one face and is always available. */
  probe: string | null;
  /** The Latin half. The CJK tail for `kind` is appended to it. */
  latin: string;
  /** A serif at 700 is heavier than this page wants; a sans needs it. */
  headingWeight: number;
  lineHeight: number;
}

/**
 * Ordered best-first.
 *
 * The two `probe: null` entries are the defaults — whole stacks that degrade
 * through the platform's own faces. The named entries below them are offered
 * only where they exist, which is why the list can name both macOS and
 * Windows faces without either platform seeing the other's.
 */
export const BODY_FACES: BodyFaceOption[] = [
  {
    id: "serif",
    label: "衬线（跟随系统）",
    kind: "serif",
    probe: null,
    latin: '"Miracle Serif", "Iowan Old Style", Charter, Palatino, Cambria, Constantia, "Palatino Linotype", Georgia',
    headingWeight: 600,
    lineHeight: 1.85,
  },
  {
    id: "sans",
    label: "无衬线（跟随系统）",
    kind: "sans",
    probe: null,
    latin: 'Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui',
    headingWeight: 700,
    lineHeight: 1.8,
  },
  { id: "iowan", label: "Iowan Old Style", kind: "serif", probe: "Iowan Old Style", latin: '"Iowan Old Style"', headingWeight: 600, lineHeight: 1.85 },
  { id: "charter", label: "Charter", kind: "serif", probe: "Charter", latin: "Charter", headingWeight: 600, lineHeight: 1.85 },
  { id: "palatino", label: "Palatino", kind: "serif", probe: "Palatino", latin: "Palatino", headingWeight: 600, lineHeight: 1.9 },
  { id: "baskerville", label: "Baskerville", kind: "serif", probe: "Baskerville", latin: "Baskerville", headingWeight: 600, lineHeight: 1.9 },
  { id: "cambria", label: "Cambria", kind: "serif", probe: "Cambria", latin: "Cambria", headingWeight: 600, lineHeight: 1.85 },
  { id: "constantia", label: "Constantia", kind: "serif", probe: "Constantia", latin: "Constantia", headingWeight: 600, lineHeight: 1.85 },
  { id: "georgia", label: "Georgia", kind: "serif", probe: "Georgia", latin: "Georgia", headingWeight: 600, lineHeight: 1.8 },
  { id: "times", label: "Times New Roman", kind: "serif", probe: "Times New Roman", latin: '"Times New Roman"', headingWeight: 700, lineHeight: 1.85 },
  { id: "helvetica", label: "Helvetica Neue", kind: "sans", probe: "Helvetica Neue", latin: '"Helvetica Neue"', headingWeight: 700, lineHeight: 1.8 },
  { id: "segoe", label: "Segoe UI", kind: "sans", probe: "Segoe UI", latin: '"Segoe UI"', headingWeight: 700, lineHeight: 1.8 },
];

/** The whole family stack a choice resolves to. */
export function faceStack(face: BodyFaceOption): string {
  return `${face.latin}, ${face.kind === "serif" ? CJK_SERIF : CJK_SANS}`;
}

export function findFace(id: string): BodyFaceOption | null {
  return BODY_FACES.find((f) => f.id === id) ?? null;
}

/**
 * Is this family actually installed?
 *
 * `document.fonts.check` answers "could I paint this string", not "is that
 * family present", so it returns true for a family that will be substituted.
 * Measuring is the only reliable test: set the candidate with a generic behind
 * it, and see whether the width moves off the generic's own.
 */
let probeContext: CanvasRenderingContext2D | null | undefined;
const availability = new Map<string, boolean>();

function context(): CanvasRenderingContext2D | null {
  if (probeContext === undefined) {
    probeContext = document.createElement("canvas").getContext("2d");
  }
  return probeContext;
}

export function fontAvailable(family: string): boolean {
  const cached = availability.get(family);
  if (cached !== undefined) return cached;
  const ctx = context();
  if (!ctx) return false;
  // Wide and narrow letters plus digits, so a substitution moves the total.
  const sample = "mmmmmmmmmmlliWWWMMM0123456789";
  let found = false;
  for (const generic of ["monospace", "serif", "sans-serif"]) {
    ctx.font = `72px ${generic}`;
    const base = ctx.measureText(sample).width;
    ctx.font = `72px "${family}", ${generic}`;
    if (Math.abs(ctx.measureText(sample).width - base) > 0.5) {
      found = true;
      break;
    }
  }
  availability.set(family, found);
  return found;
}

/** The choices worth offering on this machine, in order. */
export function installedFaces(): BodyFaceOption[] {
  return BODY_FACES.filter((f) => f.probe === null || fontAvailable(f.probe));
}
