//! Turning chosen breakpoints into drawable positions.

use crate::linebreak::Breakpoint;
use crate::{Kind, Paragraph};

/// One `fillText` call for the host: a whole Latin word, or a single CJK glyph.
#[derive(Debug, Clone, Copy)]
pub struct DrawRun {
    pub x: f32,
    /// Byte range in the source text. This is the link back to the document
    /// model that makes caret placement a binary search.
    pub start: u32,
    pub end: u32,
    /// Horizontal scale for font expansion. 1.0 unless `max_expand` is on.
    pub scale_x: f32,
    pub style: u16,
}

#[derive(Debug, Clone)]
pub struct Line {
    pub runs: Vec<DrawRun>,
    /// Adjustment ratio the line was set at, for diagnostics and for the
    /// "show badness" debugging overlay.
    pub ratio: f32,
    /// Ink width after justification, including any protrusion.
    pub width: f32,
    pub hyphenated: bool,
    pub source_start: u32,
    pub source_end: u32,
}

/// Distribute each line's stretch or shrink and emit final positions.
pub fn layout_lines(para: &Paragraph, breaks: &[Breakpoint], line_width: f32) -> Vec<Line> {
    let items = &para.items;
    let atoms = &para.atoms;
    let max_expand = para.config.max_expand;
    let mut lines = Vec::with_capacity(breaks.len());

    for bp in breaks {
        let mut runs = Vec::new();
        let end = bp.position;
        // Ragged right is not "the same breaks, unstretched": the optimiser
        // still minimises badness, which for unjustified text means it
        // minimises how ragged the edge is — a better result than the greedy
        // ragged setting a browser produces. What changes here is only that
        // the glue is never stretched to close the gap.
        let upper = if para.config.justify { para.config.tolerance } else { 0.0 };
        let ratio = bp.ratio.clamp(-1.0, upper);

        // Font expansion (pdfTeX's `hz`): let the glyphs themselves take up
        // some of the slack so the word spaces do not have to carry all of it.
        // Applied as a post-pass rather than inside the optimiser's cost
        // function, which is an approximation, but a visually effective one.
        let mut scale_x = 1.0;
        if max_expand > 0.0 && ratio.is_finite() && ratio != 0.0 {
            let glyph_total: f32 = items[bp.start..end]
                .iter()
                .filter(|it| it.kind == Kind::Box)
                .map(|it| it.width)
                .sum();
            if glyph_total > 0.0 {
                let stretch: f32 = items[bp.start..end].iter().map(|it| it.stretch).sum();
                let shrink: f32 = items[bp.start..end].iter().map(|it| it.shrink).sum();
                let delta = ratio * if ratio > 0.0 { stretch } else { shrink };
                scale_x = (1.0 + delta / glyph_total).clamp(1.0 - max_expand, 1.0 + max_expand);
            }
        }
        // Whatever expansion absorbed no longer has to come out of the glue.
        let residual = if scale_x != 1.0 {
            let glyph_total: f32 = items[bp.start..end]
                .iter()
                .filter(|it| it.kind == Kind::Box)
                .map(|it| it.width)
                .sum();
            let absorbed = glyph_total * (scale_x - 1.0);
            let pool: f32 = items[bp.start..end]
                .iter()
                .map(|it| if ratio > 0.0 { it.stretch } else { it.shrink })
                .sum();
            if pool > 0.0 { ratio - absorbed / pool } else { ratio }
        } else {
            ratio
        };
        let r = residual.clamp(-1.0, upper);

        // Protrusion at the left margin pulls the whole line outward.
        let mut x = 0.0;
        if let Some(first) = items.get(bp.start).filter(|it| it.kind == Kind::Box) {
            if let Some(a) = atoms.get(first.atom as usize) {
                x = -a.protrude_left;
            }
        }

        let mut source_start = u32::MAX;
        let mut source_end = 0u32;
        // Where the ink actually ends. The paragraph's final glue is
        // infinitely stretchable so that the last line is never justified,
        // and letting that phantom stretch into the reported width would make
        // every short last line look full.
        let mut ink = x;

        for it in &items[bp.start..end] {
            match it.kind {
                Kind::Box => {
                    let Some(atom) = atoms.get(it.atom as usize) else { continue };
                    // 标点挤压: the empty half of a full-width punctuation mark
                    // collapses, and the glyph slides into the space it left.
                    let (sl, sr) = if r < 0.0 {
                        (-r * atom.shrink_left, -r * atom.shrink_right)
                    } else {
                        (0.0, 0.0)
                    };
                    let advance = (atom.width - sl - sr) * scale_x;
                    runs.push(DrawRun {
                        x: x - sl * scale_x,
                        start: atom.start,
                        end: atom.end,
                        scale_x,
                        style: atom.style,
                    });
                    source_start = source_start.min(atom.start);
                    source_end = source_end.max(atom.end);
                    x += advance;
                    ink = x;
                }
                Kind::Glue => {
                    let adjust = if r > 0.0 { r * it.stretch } else { r * it.shrink };
                    x += it.width + adjust;
                }
                Kind::Penalty => {}
            }
        }

        // A discretionary hyphen only exists on the line that breaks there.
        if items[end].kind == Kind::Penalty && items[end].flagged {
            if let Some(last) = runs.last() {
                runs.push(DrawRun {
                    x,
                    start: u32::MAX, // sentinel: draw a hyphen, not source text
                    end: last.end,
                    scale_x,
                    style: last.style,
                });
            }
            x += items[end].width;
            ink = x;
        }

        lines.push(Line {
            runs,
            ratio: bp.ratio,
            width: ink,
            hyphenated: bp.hyphenated,
            source_start: if source_start == u32::MAX { 0 } else { source_start },
            source_end,
        });
    }
    lines
}
