//! Turning source text into TeX's horizontal list.

use crate::unicode::{
    classify, forbidden_at_line_end, forbidden_at_line_start, CharClass, PunctStyle,
};
use crate::{Atom, Config, Item, Paragraph, INFINITE_PENALTY};

/// A unit of text the host must measure.
///
/// `class` is exposed so the host can pick the right font (a CJK face for
/// ideographs, a Latin face for words) before measuring.
#[derive(Debug, Clone, Copy)]
pub struct Token {
    pub start: u32,
    pub end: u32,
    pub class: CharClass,
    /// A real dictionary hyphenation opportunity follows this token.
    ///
    /// Adjacent letter tokens are not enough to infer this: the host may
    /// require an otherwise unbroken word to be split at a paint boundary.
    pub hyphen_after: bool,
}

/// Split text into measurable tokens.
///
/// Latin runs stay whole so the host measures them with kerning and ligatures
/// intact — and since a word is a single indivisible box to the line breaker,
/// nothing is lost by not knowing its interior. CJK characters are split
/// individually because punctuation squeezing has to move them relative to
/// each other.
pub fn tokenize(text: &str, style: PunctStyle, hyphenate: bool) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut latin_start: Option<usize> = None;

    for (i, c) in text.char_indices() {
        // The `full_width` hint only matters for the ambiguous curly quotes.
        // Before measurement we cannot know, so we assume CJK context when the
        // surrounding text is CJK; the host may correct this later.
        let class = classify(c, style, false);
        let is_latin_run = matches!(class, CharClass::Letter | CharClass::Other);

        if is_latin_run {
            if latin_start.is_none() {
                latin_start = Some(i);
            }
            continue;
        }

        if let Some(s) = latin_start.take() {
            push_word(&mut tokens, text, s, i, hyphenate);
        }
        tokens.push(Token {
            start: i as u32,
            end: (i + c.len_utf8()) as u32,
            class,
            hyphen_after: false,
        });
    }
    if let Some(s) = latin_start {
        push_word(&mut tokens, text, s, text.len(), hyphenate);
    }
    tokens
}

/// Split measurable tokens at host-mandated byte boundaries.
///
/// Tokenization and hyphenation deliberately happen first, over the complete
/// word. A bold or link boundary changes how glyphs are measured and painted,
/// but it must neither erase the word's real hyphenation opportunities nor
/// invent a new one. Invalid UTF-8 offsets are ignored rather than sliced.
pub fn tokenize_with_boundaries(
    text: &str,
    style: PunctStyle,
    hyphenate: bool,
    boundaries: &[u32],
) -> Vec<Token> {
    let tokens = tokenize(text, style, hyphenate);
    if boundaries.is_empty() || tokens.is_empty() {
        return tokens;
    }

    let mut cuts: Vec<u32> = boundaries
        .iter()
        .copied()
        .filter(|&cut| {
            cut > 0 &&
                (cut as usize) < text.len() &&
                text.is_char_boundary(cut as usize)
        })
        .collect();
    cuts.sort_unstable();
    cuts.dedup();
    if cuts.is_empty() {
        return tokens;
    }

    let mut split = Vec::with_capacity(tokens.len() + cuts.len());
    let mut cut_index = 0;
    for token in tokens {
        while cuts.get(cut_index).is_some_and(|&cut| cut <= token.start) {
            cut_index += 1;
        }
        let mut start = token.start;
        while let Some(&cut) = cuts.get(cut_index).filter(|&&cut| cut < token.end) {
            split.push(Token {
                start,
                end: cut,
                class: token.class,
                hyphen_after: false,
            });
            start = cut;
            cut_index += 1;
        }
        split.push(Token { start, ..token });
    }
    split
}

/// Emit a Latin word, split at its hyphenation points.
///
/// The split has to happen here rather than later, because the host measures
/// tokens and every box must be exactly as wide as the glyphs it draws. A
/// word broken up after measurement can only have its width guessed at, and a
/// guess apportioned by character count puts an `i` and an `m` on equal
/// footing — which shows up on screen as syllables that overlap or drift
/// apart.
///
fn push_word(tokens: &mut Vec<Token>, text: &str, start: usize, end: usize, hyphenate: bool) {
    let word = &text[start..end];
    let long_enough = word.chars().count() >= 5;
    if !hyphenate || !long_enough || !word.chars().all(char::is_alphabetic) {
        tokens.push(Token {
            start: start as u32,
            end: end as u32,
            class: CharClass::Letter,
            hyphen_after: false,
        });
        return;
    }

    let mut at = start;
    let mut syllables = hypher::hyphenate(word, hypher::Lang::English).peekable();
    while let Some(syllable) = syllables.next() {
        let next = at + syllable.len();
        tokens.push(Token {
            start: at as u32,
            end: next as u32,
            class: CharClass::Letter,
            hyphen_after: syllables.peek().is_some(),
        });
        at = next;
    }
    debug_assert_eq!(at, end, "hyphenation must preserve the word");
}

/// Protrusion amounts, as a fraction of the glyph's own advance.
///
/// These follow pdfTeX's `\rpcode`/`\lpcode` convention (thousandths of the
/// character width) for Latin. CJK punctuation hangs by its whole empty half,
/// which is the traditional 标点悬挂.
fn protrusion(c: char, class: CharClass, width: f32, em: f32) -> (f32, f32) {
    if class == CharClass::PunctLeft {
        // The glyph sits left; its empty right half may hang past the margin.
        return (0.0, (em * 0.5).min(width));
    }
    if class == CharClass::PunctRight {
        return ((em * 0.5).min(width), 0.0);
    }
    let right = match c {
        '.' | ',' => 0.70,
        '-' | '\u{2010}' | '\u{2013}' => 0.70,
        ';' | ':' | '!' | '?' => 0.30,
        '\'' | '"' | '\u{2019}' | '\u{201D}' => 0.50,
        _ => 0.0,
    };
    let left = match c {
        '\u{2018}' | '\u{201C}' | '"' | '\'' => 0.50,
        _ => 0.0,
    };
    (left * width, right * width)
}

/// Build the horizontal list.
///
/// `metrics` holds four floats per token, in the same order as `tokens`:
/// advance, height above the baseline, depth below it, and the penalty for
/// breaking immediately after it (NaN for "no explicit penalty").
///
/// The vertical pair is what lets a line make room for something taller than
/// the text. The penalty is what lets an inline formula be handed over as
/// several boxes with TeX's `\binoppenalty` and `\relpenalty` between them,
/// so the optimiser can split a formula across lines rather than shunting the
/// whole thing down and leaving a hole.
pub fn prepare(
    text: &str,
    tokens: &[Token],
    metrics: &[f32],
    space_width: f32,
    config: Config,
) -> Paragraph {
    let em = config.font_size;
    let hyphen_width = em * 0.33;
    let mut items: Vec<Item> = Vec::with_capacity(tokens.len() * 2 + 4);
    let mut atoms: Vec<Atom> = Vec::with_capacity(tokens.len());

    // First and last character of each token, used for the adjacency rules.
    let first_char = |t: &Token| text[t.start as usize..t.end as usize].chars().next();
    let last_char = |t: &Token| text[t.start as usize..t.end as usize].chars().next_back();

    for (i, tok) in tokens.iter().enumerate() {
        let measured_width = metrics.get(i * 4).copied();
        let width = measured_width.filter(|w| w.is_finite()).unwrap_or(0.0);
        let height = metrics.get(i * 4 + 1).copied().unwrap_or(0.0);
        let depth = metrics.get(i * 4 + 2).copied().unwrap_or(0.0);
        let break_after = metrics.get(i * 4 + 3).copied().unwrap_or(f32::NAN);
        let c = match first_char(tok) {
            Some(c) => c,
            None => continue,
        };

        if tok.class == CharClass::Space {
            // TeX's interword glue: for a typical serif, w ± w/2 ∓ w/3.
            // Use this token's measured style: code and heading spaces need
            // not have the same advance as body text. `space_width` remains a
            // defensive fallback for an incomplete metrics buffer.
            let w = measured_width
                .filter(|w| w.is_finite() && *w >= 0.0)
                .unwrap_or(space_width);
            items.push(Item::glue(w, w * 0.5, w / 3.0));
            continue;
        }

        // ---- punctuation squeezing (标点挤压) ----------------------------
        let (shrink_l, shrink_r) = if !config.punct_squeeze {
            (0.0, 0.0)
        } else {
            match tok.class {
                // Glyph drawn in the left half — the right half may collapse.
                CharClass::PunctLeft => (0.0, (width * 0.5).min(em * 0.5)),
                CharClass::PunctRight => ((width * 0.5).min(em * 0.5), 0.0),
                CharClass::PunctCenter => {
                    let q = (width * 0.25).min(em * 0.25);
                    (q, q)
                }
                _ => (0.0, 0.0),
            }
        };

        let (protrude_left, protrude_right) = if config.protrusion {
            protrusion(c, tok.class, width, em)
        } else {
            (0.0, 0.0)
        };

        let atom_index = atoms.len() as u32;
        atoms.push(Atom {
            start: tok.start,
            end: tok.end,
            class: tok.class,
            width,
            height,
            depth,
            shrink_left: shrink_l,
            shrink_right: shrink_r,
            protrude_left,
            protrude_right,
            style: 0,
        });

        items.push(Item::boxed(atom_index, width, 0.0, shrink_l + shrink_r));

        // ---- what goes between this token and the next -------------------
        let Some(next) = tokens.get(i + 1) else { continue };

        // An explicit penalty overrides the adjacency rules entirely. This is
        // how the pieces of a split formula are joined: TeX's cost for
        // breaking after a binary operator or a relation, and nothing else
        // between them.
        if !break_after.is_nan() {
            items.push(Item::penalty(0.0, break_after, false));
            continue;
        }
        if next.class == CharClass::Space {
            continue; // the space itself becomes glue on the next iteration
        }
        let Some(next_c) = first_char(next) else { continue };
        let this_c = last_char(tok).unwrap_or(c);

        // A dictionary hyphenation point. Adjacent letter boxes may merely be
        // a style boundary and must remain unbreakable.
        if tok.hyphen_after
            && tok.class == CharClass::Letter
            && next.class == CharClass::Letter
            && tok.end == next.start
        {
            items.push(Item::penalty(
                hyphen_width,
                hyphenation_cost(text, tokens, i, config),
                true,
            ));
            continue;
        }

        let breakable = !forbidden_at_line_end(this_c) && !forbidden_at_line_start(next_c);

        let cjk_side = matches!(tok.class, CharClass::Cjk) || tok.class.is_cjk_punct();
        let next_cjk = matches!(next.class, CharClass::Cjk) || next.class.is_cjk_punct();

        // 中西文间距: ¼ em between a Han character and a Latin letter/digit,
        // compressible to ⅛ em. Modelling it as glue rather than as padding on
        // the glyph means it disappears automatically when the optimiser
        // breaks the line here — which is exactly the required behaviour.
        let mixed = config.cjk_latin_spacing
            && ((tok.class.is_cj() && next.class.is_letter_or_number())
                || (tok.class.is_letter_or_number() && next.class.is_cj()));

        if mixed {
            if !breakable {
                items.push(Item::penalty(0.0, INFINITE_PENALTY, false));
            }
            items.push(Item::glue(em * 0.25, em * 0.125, em * 0.125));
        } else if cjk_side && next_cjk {
            // 避头尾: a forbidden break is just an infinite penalty. Placing it
            // before the glue also removes the glue's own breakpoint, since
            // glue is only a legal break when preceded by a box.
            if !breakable {
                items.push(Item::penalty(0.0, INFINITE_PENALTY, false));
            }
            // A whisper of inter-character stretch. Without it a run of Han
            // glyphs is perfectly rigid and can only justify by luck.
            items.push(Item::glue(0.0, em * config.cjk_stretch, 0.0));
        } else if cjk_side != next_cjk && breakable {
            // Script boundary that is not letter/digit adjacent (e.g. Han next
            // to western punctuation): a breakpoint, but no extra space.
            items.push(Item::penalty(0.0, 0.0, false));
        }
    }

    // TeX's paragraph ending: infinitely stretchable glue so the last line is
    // never justified, then a forced break.
    items.push(Item::penalty(0.0, INFINITE_PENALTY, false));
    items.push(Item::glue(0.0, 1.0e6, 0.0));
    items.push(Item::penalty(0.0, crate::FORCED_BREAK, false));

    Paragraph { items, atoms, config }
}

/// Cost of breaking at the hyphenation point after token `i`.
///
/// Following Typst, a break within five characters of either end of the word
/// is charged extra — "ex-traordinary" is a worse place to split than
/// "extraordi-nary" even though both are valid.
fn hyphenation_cost(text: &str, tokens: &[Token], i: usize, config: Config) -> f32 {
    const LIMIT: u32 = 5;
    let mut left = 0u32;
    let mut j = i as isize;
    while j >= 0 {
        let t = &tokens[j as usize];
        left += text[t.start as usize..t.end as usize].chars().count() as u32;
        if j == 0 || tokens[j as usize - 1].end != t.start || tokens[j as usize - 1].class != CharClass::Letter {
            break;
        }
        j -= 1;
    }
    let mut right = 0u32;
    let mut k = i + 1;
    while k < tokens.len() {
        let t = &tokens[k];
        right += text[t.start as usize..t.end as usize].chars().count() as u32;
        if k + 1 >= tokens.len() || tokens[k + 1].start != t.end || tokens[k + 1].class != CharClass::Letter {
            break;
        }
        k += 1;
    }

    let steps = LIMIT.saturating_sub(left) + LIMIT.saturating_sub(right);
    (1.0 + 0.15 * steps as f32) * config.hyph_cost
}
