//! A TeX-quality line breaking and CJK typesetting engine.
//!
//! The pipeline mirrors TeX's: text becomes a horizontal list of *boxes*,
//! *glue* and *penalties*; the Knuth-Plass optimiser picks the set of
//! breakpoints minimising total demerits; then each line distributes its
//! stretch or shrink over the items to produce final glyph positions.
//!
//! Chinese/Japanese typesetting is not bolted on as a special case. The three
//! rules that matter — mixed-script spacing, punctuation squeezing and
//! kinsoku shori — fall out of the same three primitives:
//!
//! * 中西文间距 is a [`Glue`] of ¼ em between a Han character and a Latin one,
//!   which the optimiser discards for free when it happens to break there.
//! * 标点挤压 is per-glyph shrinkability on the punctuation's empty half.
//! * 避头尾 is an infinite [`Penalty`] at the forbidden breakpoints.

#[cfg(test)]
mod tests;

pub mod layout;
pub mod linebreak;
pub mod prepare;
pub mod unicode;

pub use layout::{layout_lines, DrawRun, Line};
pub use linebreak::{break_lines, Breakpoint};
pub use prepare::{prepare, tokenize, Token};
pub use unicode::{CharClass, PunctStyle};

/// One measurable unit of text handed to the host for width measurement.
///
/// Latin words are measured whole so that kerning and ligatures inside the
/// word survive; CJK characters are measured (and later drawn) individually
/// so that punctuation squeezing can move them.
pub const TOKEN_STRIDE: usize = 3;

/// Which of TeX's three primitives an item is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Box,
    Glue,
    Penalty,
}

/// A penalty value meaning "never break here".
pub const INFINITE_PENALTY: f32 = 10_000.0;
/// A penalty value meaning "always break here".
pub const FORCED_BREAK: f32 = -10_000.0;

/// An entry in the horizontal list.
///
/// Boxes carry stretch/shrink of their own — unlike classic TeX, where only
/// glue is adjustable. That extension is what lets full-width CJK punctuation
/// give up its empty half during justification.
#[derive(Debug, Clone, Copy)]
pub struct Item {
    pub kind: Kind,
    /// Index into the atom table for `Kind::Box`, else `u32::MAX`.
    pub atom: u32,
    pub width: f32,
    pub stretch: f32,
    pub shrink: f32,
    pub penalty: f32,
    /// Set on penalties that insert a hyphen, so that two hyphenated lines in
    /// a row can be penalised extra.
    pub flagged: bool,
}

impl Item {
    pub fn boxed(atom: u32, width: f32, stretch: f32, shrink: f32) -> Self {
        Item { kind: Kind::Box, atom, width, stretch, shrink, penalty: 0.0, flagged: false }
    }
    pub fn glue(width: f32, stretch: f32, shrink: f32) -> Self {
        Item {
            kind: Kind::Glue,
            atom: u32::MAX,
            width,
            stretch,
            shrink,
            penalty: 0.0,
            flagged: false,
        }
    }
    pub fn penalty(width: f32, penalty: f32, flagged: bool) -> Self {
        Item {
            kind: Kind::Penalty,
            atom: u32::MAX,
            width,
            stretch: 0.0,
            shrink: 0.0,
            penalty,
            flagged,
        }
    }
    pub fn is_forced_break(&self) -> bool {
        self.kind == Kind::Penalty && self.penalty <= FORCED_BREAK
    }
}

/// A drawable unit: either one CJK glyph or one whole Latin word.
///
/// Every atom keeps the byte range it came from, which is what makes the
/// engine usable in an editor — caret placement is a binary search over these
/// rather than a query into an opaque layout tree.
#[derive(Debug, Clone, Copy)]
pub struct Atom {
    pub start: u32,
    pub end: u32,
    pub class: CharClass,
    /// Natural advance as measured by the host.
    pub width: f32,
    /// How much the glyph may be squeezed on each side (punctuation only).
    pub shrink_left: f32,
    pub shrink_right: f32,
    /// How far the glyph may hang past the margin (protrusion / 标点悬挂).
    pub protrude_left: f32,
    pub protrude_right: f32,
    pub style: u16,
}

/// Typesetting parameters.
#[derive(Debug, Clone, Copy)]
pub struct Config {
    pub font_size: f32,
    pub punct_style: PunctStyle,
    pub justify: bool,
    /// Insert ¼ em between Han characters and Latin letters/digits.
    pub cjk_latin_spacing: bool,
    /// Allow full-width punctuation to give up its empty half.
    pub punct_squeeze: bool,
    /// Let punctuation hang into the margin so the edge reads straight.
    pub protrusion: bool,
    pub hyphenate: bool,
    /// Cost of ending a line with a hyphen. TeX's default is 50; Typst uses
    /// 135, which hyphenates noticeably less often.
    pub hyph_cost: f32,
    /// Cost of leaving a lone word on the last line.
    pub runt_cost: f32,
    /// TeX's \linepenalty — added to every line to discourage extra lines.
    pub line_penalty: f32,
    /// Maximum adjustment ratio a line may have and still be considered on
    /// the main pass. TeX expresses this as a badness (its default, 200,
    /// corresponds to a ratio of about 1.26); a ratio is easier to reason
    /// about and 2.0 — spaces at triple width — is about the worst a reader
    /// tolerates before the line looks gappy.
    pub tolerance: f32,
    /// Inter-character stretch for runs of CJK, in em. This is what lets a
    /// pure-Han line justify at all, since every glyph is exactly 1 em wide.
    pub cjk_stretch: f32,
    /// pdfTeX's `hz` font expansion, as a fraction. 0.02 means glyphs may be
    /// scaled up to ±2% horizontally to relieve the word spaces.
    pub max_expand: f32,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            font_size: 16.0,
            punct_style: PunctStyle::Gb,
            justify: true,
            cjk_latin_spacing: true,
            punct_squeeze: true,
            protrusion: true,
            hyphenate: true,
            hyph_cost: 135.0,
            runt_cost: 100.0,
            line_penalty: 10.0,
            tolerance: 2.0,
            cjk_stretch: 0.02,
            max_expand: 0.0,
        }
    }
}

/// A prepared paragraph: the horizontal list plus the atoms it refers to.
pub struct Paragraph {
    pub items: Vec<Item>,
    pub atoms: Vec<Atom>,
    pub config: Config,
}
