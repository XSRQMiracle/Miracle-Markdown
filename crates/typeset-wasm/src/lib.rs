//! The bridge between the typesetting core and the browser.
//!
//! Measurement stays on the JavaScript side — `measureText` uses the same
//! shaper the platform will draw with, so the widths the optimiser reasons
//! about are the widths that actually appear. Crossing the boundary is
//! therefore a two-step handshake per paragraph: the core says what it needs
//! measured, the host measures (from a cache, almost always), and the core
//! lays out. Both directions travel as flat typed arrays, so a paragraph
//! costs two calls regardless of how many words it holds.

use typeset_core::{
    break_lines, layout_lines, prepare, tokenize, CharClass, Config, Paragraph, PunctStyle, Token,
};
use wasm_bindgen::prelude::*;

/// Values written into the token array, matching `CharClass` on the JS side.
fn class_code(c: CharClass) -> u32 {
    match c {
        CharClass::Cjk => 0,
        CharClass::PunctLeft => 1,
        CharClass::PunctRight => 2,
        CharClass::PunctCenter => 3,
        CharClass::Letter => 4,
        CharClass::Space => 5,
        CharClass::Other => 6,
    }
}

#[wasm_bindgen]
pub struct Engine {
    config: Config,
    text: String,
    tokens: Vec<Token>,
    para: Option<Paragraph>,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine { config: Config::default(), text: String::new(), tokens: Vec::new(), para: None }
    }

    /// Update typesetting parameters. Anything left at `-1` keeps its value,
    /// so the UI can toggle one switch without restating the rest.
    #[allow(clippy::too_many_arguments)]
    pub fn configure(
        &mut self,
        font_size: f32,
        justify: bool,
        cjk_latin_spacing: bool,
        punct_squeeze: bool,
        protrusion: bool,
        hyphenate: bool,
        tolerance: f32,
        max_expand: f32,
        punct_style: u8,
    ) {
        self.config.font_size = font_size;
        self.config.justify = justify;
        self.config.cjk_latin_spacing = cjk_latin_spacing;
        self.config.punct_squeeze = punct_squeeze;
        self.config.protrusion = protrusion;
        self.config.hyphenate = hyphenate;
        self.config.tolerance = tolerance;
        self.config.max_expand = max_expand;
        self.config.punct_style = match punct_style {
            1 => PunctStyle::Jis,
            2 => PunctStyle::Cns,
            _ => PunctStyle::Gb,
        };
    }

    /// Step one: split the paragraph into units the host must measure.
    ///
    /// Returns `[start, end, class]` triples as byte offsets into `text`.
    pub fn tokenize(&mut self, text: &str) -> Vec<u32> {
        self.text = text.to_string();
        self.tokens = tokenize(&self.text, self.config.punct_style, self.config.hyphenate);
        self.para = None;
        let mut out = Vec::with_capacity(self.tokens.len() * 3);
        for t in &self.tokens {
            out.push(t.start);
            out.push(t.end);
            out.push(class_code(t.class));
        }
        out
    }

    /// Step two: hand back the measured widths and build the horizontal list.
    pub fn prepare(&mut self, advances: &[f32], space_width: f32) {
        self.para =
            Some(prepare(&self.text, &self.tokens, advances, space_width, self.config));
    }

    /// Step three: break and position. Cheap enough to call on every frame of
    /// a window resize, which is the whole reason measurement is cached.
    ///
    /// Layout of the returned buffer:
    ///   [0]                     line count
    ///   per line: run_count, ratio, width, hyphenated, src_start, src_end
    ///   per run:  x, src_start, src_end, scale_x
    ///
    /// A run whose `src_start` is `-1` is a discretionary hyphen the host
    /// should draw itself; it has no source text of its own.
    pub fn layout(&mut self, width: f32) -> Vec<f32> {
        let Some(para) = &self.para else { return vec![0.0] };
        let breaks = break_lines(para, width);
        let lines = layout_lines(para, &breaks, width);

        let mut out = Vec::with_capacity(lines.len() * 8 + 1);
        out.push(lines.len() as f32);
        for line in &lines {
            out.push(line.runs.len() as f32);
            out.push(line.ratio);
            out.push(line.width);
            out.push(if line.hyphenated { 1.0 } else { 0.0 });
            out.push(line.source_start as f32);
            out.push(line.source_end as f32);
            for r in &line.runs {
                out.push(r.x);
                out.push(if r.start == u32::MAX { -1.0 } else { r.start as f32 });
                out.push(r.end as f32);
                out.push(r.scale_x);
            }
        }
        out
    }

    /// Number of tokens produced by the last `tokenize`, so the host can size
    /// its advance buffer without re-reading the token array.
    pub fn token_count(&self) -> usize {
        self.tokens.len()
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}
