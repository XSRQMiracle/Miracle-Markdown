//! The Knuth-Plass optimal line breaking algorithm.
//!
//! Rather than filling each line as full as possible and moving on — which is
//! what CSS does, and what makes a greedy paragraph's right edge ripple — this
//! considers the paragraph as a whole. Every legal breakpoint becomes a node;
//! the cost of a line is a function of how far its glue had to stretch or
//! shrink; and dynamic programming finds the set of breaks with the least
//! total cost. A line that is slightly too loose is accepted if it saves two
//! later lines from being awful.

use crate::{Item, Kind, Paragraph, FORCED_BREAK, INFINITE_PENALTY};

/// Lines tighter than this would have to overlap their glyphs, so they are
/// never feasible.
const MIN_RATIO: f32 = -1.0;
/// Demerits added when consecutive lines sit in non-adjacent fitness classes.
const FITNESS_MISMATCH: f32 = 3000.0;
/// Extra charge, applied before squaring, when two consecutive lines both
/// end in a hyphen.
const DOUBLE_HYPHEN: f32 = 300.0;

/// A chosen breakpoint together with the ratio its line was set at.
#[derive(Debug, Clone, Copy)]
pub struct Breakpoint {
    /// Index of the item at which the line ends.
    pub position: usize,
    /// Index of the first item of this line.
    pub start: usize,
    /// Adjustment ratio: positive means glue was stretched, negative shrunk.
    pub ratio: f32,
    /// True if this line ends with a discretionary hyphen.
    pub hyphenated: bool,
}

#[derive(Clone, Copy)]
struct Node {
    position: usize,
    line: usize,
    fitness: u8,
    demerits: f32,
    ratio: f32,
    start: usize,
    prev: u32,
}

/// Prefix sums, so the metrics of any item range are an O(1) subtraction
/// instead of a walk. This is what keeps re-breaking cheap enough to run on
/// every keystroke.
struct Sums {
    width: Vec<f32>,
    stretch: Vec<f32>,
    shrink: Vec<f32>,
}

impl Sums {
    fn new(items: &[Item]) -> Self {
        let n = items.len();
        let mut width = vec![0.0; n + 1];
        let mut stretch = vec![0.0; n + 1];
        let mut shrink = vec![0.0; n + 1];
        for (i, it) in items.iter().enumerate() {
            // A penalty's width only materialises if the line breaks there, so
            // it must not accumulate.
            let w = if it.kind == Kind::Penalty { 0.0 } else { it.width };
            width[i + 1] = width[i] + w;
            stretch[i + 1] = stretch[i] + it.stretch;
            shrink[i + 1] = shrink[i] + it.shrink;
        }
        Sums { width, stretch, shrink }
    }
}

/// Whether a line may end at item `i`.
fn is_legal_break(items: &[Item], i: usize) -> bool {
    match items[i].kind {
        // Glue is a breakpoint only when it follows a box. Putting an infinite
        // penalty in front of glue therefore suppresses the break while
        // keeping the space — which is how kinsoku shori is expressed.
        Kind::Glue => i > 0 && items[i - 1].kind == Kind::Box,
        Kind::Penalty => items[i].penalty < INFINITE_PENALTY,
        Kind::Box => false,
    }
}

/// The first item of the line that follows a break at `pos`.
///
/// Glue and penalties immediately after a break are discarded, which is what
/// stops a line from beginning with a space, or with the ¼ em of mixed-script
/// spacing that would have sat at the break.
fn line_start(items: &[Item], pos: usize) -> usize {
    let mut i = pos + 1;
    while i < items.len() && items[i].kind != Kind::Box {
        i += 1;
    }
    i
}

/// Where the line *following* `node` begins.
///
/// The root node is not a real breakpoint — it sits before item 0 — so the
/// paragraph's first line must start at 0 rather than skipping past it. No
/// genuine breakpoint can land on item 0, since a box is never a break and
/// glue needs a box in front of it, so testing for position 0 is sufficient.
fn following_start(items: &[Item], node: &Node) -> usize {
    if node.prev == u32::MAX {
        0
    } else {
        line_start(items, node.position)
    }
}

fn fitness_class(ratio: f32) -> u8 {
    if ratio < -0.5 {
        0 // tight
    } else if ratio <= 0.5 {
        1 // decent
    } else if ratio <= 1.0 {
        2 // loose
    } else {
        3 // very loose
    }
}

/// How permissive a pass is. TeX makes up to three attempts at a paragraph,
/// loosening its standards each time, so that the common case is set to a
/// tight tolerance without hyphens and only genuinely awkward text pays for
/// the looser options.
#[derive(Clone, Copy)]
struct Pass {
    /// Largest adjustment ratio a line may have and still be feasible.
    tolerance: f32,
    /// Whether discretionary hyphens may be broken at.
    hyphenate: bool,
    /// Extra stretch, free of charge, granted to every line. This is TeX's
    /// \emergencystretch: it guarantees the final pass finds *some* answer.
    emergency_stretch: f32,
}

/// Break a prepared paragraph into lines of `line_width`.
///
/// Runs TeX's three passes in order and returns the first that succeeds:
/// tight and unhyphenated, then tolerant and hyphenated, then a pass with
/// emergency stretch that cannot fail.
pub fn break_lines(para: &Paragraph, line_width: f32) -> Vec<Breakpoint> {
    let cfg = &para.config;
    let passes = [
        Pass { tolerance: 1.0, hyphenate: false, emergency_stretch: 0.0 },
        Pass { tolerance: cfg.tolerance, hyphenate: cfg.hyphenate, emergency_stretch: 0.0 },
        Pass {
            tolerance: f32::INFINITY,
            hyphenate: cfg.hyphenate,
            emergency_stretch: cfg.font_size * 3.0,
        },
    ];
    for (i, pass) in passes.iter().enumerate() {
        if i == 1 && !cfg.hyphenate && passes[0].tolerance >= cfg.tolerance {
            continue; // pass 2 would be identical to pass 1
        }
        if let Some(result) = break_pass(para, line_width, *pass) {
            return result;
        }
    }
    Vec::new()
}

/// A single pass. Returns `None` if no set of breaks stayed within tolerance.
fn break_pass(para: &Paragraph, line_width: f32, pass: Pass) -> Option<Vec<Breakpoint>> {
    let items = &para.items;
    if items.is_empty() {
        return Some(Vec::new());
    }
    let sums = Sums::new(items);

    // How far the last glyph of a line may hang past the right margin, indexed
    // by breakpoint. Protrusion widens the line's usable measure, so it has to
    // be known before the ratio is computed rather than applied afterwards.
    let protrude = protrusion_table(para);

    let mut arena: Vec<Node> = Vec::with_capacity(items.len() / 4 + 8);
    arena.push(Node {
        position: 0,
        line: 0,
        fitness: 1,
        demerits: 0.0,
        ratio: 0.0,
        start: 0,
        prev: u32::MAX,
    });
    let mut active: Vec<u32> = vec![0];

    for b in 0..items.len() {
        if !is_legal_break(items, b) {
            continue;
        }
        if items[b].flagged && !pass.hyphenate {
            continue;
        }
        let forced = items[b].is_forced_break();

        // Best candidate per fitness class, so that consecutive lines can be
        // kept in adjacent classes without exploding the node count.
        let mut best: [Option<(f32, u32, f32)>; 4] = [None; 4];
        let mut survivors: Vec<u32> = Vec::with_capacity(active.len());
        // If every active node dies at this breakpoint the paragraph would
        // have no solution, so remember the least-bad one as a fallback.
        let mut fallback: Option<(f32, u32, f32)> = None;

        for &ai in &active {
            let a = arena[ai as usize];
            let start = following_start(items, &a);
            if start > b {
                survivors.push(ai);
                continue;
            }

            let mut natural = sums.width[b] - sums.width[start];
            if items[b].kind == Kind::Penalty {
                natural += items[b].width; // the hyphen becomes real here
            }
            natural -= protrude[b];
            if let Some(first) = items.get(start).filter(|it| it.kind == Kind::Box) {
                if let Some(atom) = para.atoms.get(first.atom as usize) {
                    natural -= atom.protrude_left;
                }
            }

            let stretch = sums.stretch[b] - sums.stretch[start];
            let stretch = stretch + pass.emergency_stretch;
            let shrink = sums.shrink[b] - sums.shrink[start];
            let delta = line_width - natural;

            let ratio = if delta > 0.0 {
                if stretch > 0.0 { delta / stretch } else { f32::INFINITY }
            } else if delta < 0.0 {
                if shrink > 0.0 { delta / shrink } else { f32::NEG_INFINITY }
            } else {
                0.0
            };

            let too_tight = ratio < MIN_RATIO;
            if too_tight || forced {
                // This node can never reach any later breakpoint, so it leaves
                // the active set. That pruning is what makes the search linear
                // in practice rather than quadratic.
                if too_tight {
                    let d = a.demerits + 1.0e6;
                    if fallback.map_or(true, |(bd, _, _)| d < bd) {
                        fallback = Some((d, ai, MIN_RATIO));
                    }
                    continue;
                }
            } else {
                survivors.push(ai);
            }

            if ratio > pass.tolerance {
                continue;
            }

            let d = a.demerits + demerits(para, items, b, a, ratio, forced);
            let class = fitness_class(ratio);
            let slot = &mut best[class as usize];
            if slot.map_or(true, |(bd, _, _)| d < bd) {
                *slot = Some((d, ai, ratio));
            }
        }

        let mut any = false;
        for (class, cand) in best.iter().enumerate() {
            if let Some((d, prev, ratio)) = *cand {
                let p = arena[prev as usize];
                arena.push(Node {
                    position: b,
                    line: p.line + 1,
                    fitness: class as u8,
                    demerits: d,
                    ratio,
                    start: following_start(items, &p),
                    prev,
                });
                survivors.push(arena.len() as u32 - 1);
                any = true;
            }
        }

        // Nothing fit. On the first two passes that means this pass has
        // failed and the next, more permissive one should try. Only the final
        // pass forces a break through, so that pathological input — an
        // unbreakable URL, a column narrower than one word — still lays out.
        if !any && survivors.is_empty() {
            if pass.tolerance.is_finite() {
                return None;
            }
            if let Some((d, prev, ratio)) = fallback {
                let p = arena[prev as usize];
                arena.push(Node {
                    position: b,
                    line: p.line + 1,
                    fitness: 0,
                    demerits: d,
                    ratio,
                    start: following_start(items, &p),
                    prev,
                });
                survivors.push(arena.len() as u32 - 1);
            }
        }

        active = survivors;
        if active.is_empty() {
            return if pass.tolerance.is_finite() { None } else { Some(Vec::new()) };
        }
    }

    // Walk back from the cheapest node that reached the end.
    let Some(&best_end) = active
        .iter()
        .filter(|&&n| arena[n as usize].position == items.len() - 1)
        .min_by(|&&x, &&y| arena[x as usize].demerits.total_cmp(&arena[y as usize].demerits))
    else {
        // No chain reached the forced break at the end of the paragraph.
        return if pass.tolerance.is_finite() { None } else { Some(Vec::new()) };
    };

    let mut out = Vec::new();
    let mut cur = best_end;
    while cur != u32::MAX {
        let n = arena[cur as usize];
        if n.prev == u32::MAX {
            break;
        }
        out.push(Breakpoint {
            position: n.position,
            start: n.start,
            ratio: n.ratio,
            hyphenated: items[n.position].flagged,
        });
        cur = n.prev;
    }
    out.reverse();
    Some(out)
}

/// Cost of the line ending at `b`, following Knuth-Plass §5 with Typst's
/// refinements: the penalty is folded in before squaring, and hyphenating
/// near a word's edge costs extra.
fn demerits(
    para: &Paragraph,
    items: &[Item],
    b: usize,
    prev: Node,
    ratio: f32,
    forced: bool,
) -> f32 {
    let cfg = &para.config;

    // A last line that is merely short is not "bad" — it is expected. Only
    // charge badness when the line is justified or has to shrink.
    let badness = if forced && !cfg.justify && ratio >= 0.0 {
        0.0
    } else {
        100.0 * ratio.abs().powi(3)
    };

    let mut penalty = 0.0;
    let p = if items[b].kind == Kind::Penalty { items[b].penalty } else { 0.0 };
    if p > 0.0 && p < INFINITE_PENALTY {
        penalty += p;
    }

    // A lone word on the final line (a runt) reads as an accident.
    if forced && prev.line > 0 {
        let words = items[prev.position..b]
            .iter()
            .filter(|it| it.kind == Kind::Glue && it.width > 0.0)
            .count();
        if words == 0 {
            penalty += cfg.runt_cost;
        }
    }

    // Two hyphens in a row is the classic typographic sin the algorithm is
    // best known for avoiding. Knuth adds this after squaring; charging it
    // before instead keeps it significant on lines whose badness is already
    // large, which is exactly where the run-on hyphens appear.
    if items[b].flagged && items[prev.position].flagged {
        penalty += cfg.hyph_cost + DOUBLE_HYPHEN;
    }

    let mut d = (cfg.line_penalty + badness + penalty).powi(2);

    if p < 0.0 && p > FORCED_BREAK {
        d -= p * p;
    }

    let class = fitness_class(ratio);
    if (class as i16 - prev.fitness as i16).abs() > 1 {
        d += FITNESS_MISMATCH;
    }
    d
}

/// For every item index, how far the line ending there may hang past the
/// margin.
fn protrusion_table(para: &Paragraph) -> Vec<f32> {
    let items = &para.items;
    let mut table = vec![0.0; items.len()];
    let mut last: f32 = 0.0;
    for (i, it) in items.iter().enumerate() {
        match it.kind {
            Kind::Box => {
                last = para
                    .atoms
                    .get(it.atom as usize)
                    .map(|a| a.protrude_right)
                    .unwrap_or(0.0);
                table[i] = 0.0;
            }
            // A discretionary hyphen protrudes like the character it is.
            Kind::Penalty if it.flagged => table[i] = it.width * 0.70,
            _ => table[i] = last,
        }
    }
    table
}
