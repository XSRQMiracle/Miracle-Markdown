//! Behavioural tests. Widths are synthetic (1 em per ideograph, ½ em per Latin
//! character) so that expected line contents can be reasoned about exactly.

use crate::unicode::*;
use crate::*;

const EM: f32 = 16.0;

/// Ordinary text metrics: an ascent of 0.8 em above the baseline and a
/// descent of 0.2 em below, the same for every token.
const ASCENT: f32 = EM * 0.8;
const DESCENT: f32 = EM * 0.2;

/// Measure tokens the way a real host would, but deterministically.
/// Returns [width, height, depth, break penalty, hyphen width, glyph width] per token.
fn measure(text: &str, tokens: &[Token]) -> Vec<f32> {
    let mut out = Vec::with_capacity(tokens.len() * 6);
    for t in tokens {
        let s = &text[t.start as usize..t.end as usize];
        let w = match t.class {
            CharClass::Cjk
            | CharClass::PunctLeft
            | CharClass::PunctRight
            | CharClass::PunctCenter => EM,
            CharClass::Space => EM / 3.0,
            _ => s.chars().count() as f32 * EM * 0.5,
        };
        out.extend_from_slice(&[w, ASCENT, DESCENT, f32::NAN, char_width('-'), w]);
    }
    out
}

/// Baseline-to-baseline of 1.5 em, with a hair of clearance when a line is
/// tall enough that honouring it would cause a collision.
fn test_config() -> Config {
    Config {
        font_size: EM,
        baseline_skip: EM * 1.5,
        line_skip: EM * 0.1,
        line_skip_limit: 0.0,
        ..Default::default()
    }
}

fn build(text: &str, cfg: Config) -> Paragraph {
    let tokens = tokenize(text, cfg.punct_style, cfg.hyphenate);
    let adv = measure(text, &tokens);
    prepare(text, &tokens, &adv, EM / 3.0, cfg)
}

/// Reconstruct the visible text of each line, so assertions read naturally.
fn lines_of(text: &str, width: f32, cfg: Config) -> Vec<String> {
    let para = build(text, cfg);
    let breaks = break_lines(&para, width);
    layout_lines(&para, &breaks)
        .iter()
        .map(|l| {
            l.runs
                .iter()
                .filter(|r| r.start != u32::MAX)
                .map(|r| &text[r.start as usize..r.end as usize])
                .collect::<String>()
        })
        .collect()
}

#[test]
fn tokenizes_latin_words_whole_and_cjk_per_char() {
    let text = "hello 世界 ok";
    let toks = tokenize(text, PunctStyle::Gb, false);
    let got: Vec<&str> = toks
        .iter()
        .map(|t| &text[t.start as usize..t.end as usize])
        .collect();
    assert_eq!(got, vec!["hello", " ", "世", "界", " ", "ok"]);
}

#[test]
fn western_punctuation_is_measured_without_inventing_breaks() {
    for text in ["\"Hello.\"", "“Hello,”", "don't", "re-do"] {
        let cfg = Config { hyphenate: false, ..test_config() };
        let para = build(text, cfg);
        assert!(para.atoms.iter().any(|a| a.class == CharClass::PunctWestern));
        assert!(para.items[..para.items.len() - 3].iter().all(|it| it.kind == Kind::Box),
            "punctuation measurement must not create a break inside {text:?}");
        assert_eq!(lines_of(text, EM, cfg), vec![text]);
    }
    let text = "\"Hello.";
    let cfg = Config { hyphenate: false, ..test_config() };
    let tokens = tokenize(text, cfg.punct_style, false);
    let parts: Vec<_> = tokens.iter().map(|t| &text[t.start as usize..t.end as usize]).collect();
    assert_eq!(parts, vec!["\"", "Hello", "."]);
    let mut metrics = measure(text, &tokens);
    // A kerned period advances by 2px in context but its own glyph is 4px.
    metrics[2 * 6] = 2.0;
    metrics[2 * 6 + 5] = 4.0;
    let para = prepare(text, &tokens, &metrics, EM / 3.0, cfg);
    assert_eq!(para.atoms[0].protrude_left, 4.0, "half the quote, not half the word");
    assert_eq!(para.atoms[1].protrude_left, 0.0);
    assert!((para.atoms[2].protrude_right - 2.8).abs() < 0.001,
        "right protrusion uses the period's own advance");
}

#[test]
fn discretionary_hyphens_use_host_metrics_and_the_drawn_scale() {
    let text = "a extraordinary";
    let cfg = Config { max_expand: 0.02, ..test_config() };
    let tokens = tokenize(text, cfg.punct_style, true);
    let mut metrics = measure(text, &tokens);
    for (i, _) in tokens.iter().enumerate() {
        metrics[i * 6 + 4] = 3.0 + i as f32;
    }
    let para = prepare(text, &tokens, &metrics, EM / 3.0, cfg);
    for (i, token) in tokens.iter().enumerate().filter(|(_, t)| t.hyphen_after) {
        let position = para.items.iter().position(|it| it.kind == Kind::Box
            && para.atoms[it.atom as usize].end == token.end).unwrap() + 1;
        assert!(para.items[position].flagged);
        assert_eq!(para.items[position].width, metrics[i * 6 + 4]);
        let lines = layout_lines(&para, &[crate::linebreak::Breakpoint {
            position, start: 0, ratio: 1.0, hyphenated: true,
        }]);
        let line = &lines[0];
        let hyphen = line.runs.last().unwrap();
        assert_eq!(hyphen.start, u32::MAX);
        assert!(hyphen.scale_x > 1.0);
        assert!((line.width - hyphen.x - metrics[i * 6 + 4] * hyphen.scale_x).abs() < 0.0001,
            "the inserted glyph's drawn width must equal its reserved width");
    }
}

#[test]
fn inserts_quarter_em_between_han_and_latin() {
    let cfg = test_config();
    let para = build("中abc文", cfg);
    let glue: Vec<f32> = para
        .items
        .iter()
        .filter(|i| i.kind == Kind::Glue && i.width > 0.0)
        .map(|i| i.width)
        .collect();
    // One before "abc" and one after it.
    assert_eq!(glue.len(), 2, "expected two mixed-script gaps, got {glue:?}");
    for w in glue {
        assert!((w - EM * 0.25).abs() < 1e-3, "gap should be ¼ em, was {w}");
    }
}

#[test]
fn no_mixed_script_spacing_when_disabled() {
    let cfg = Config { cjk_latin_spacing: false, ..test_config() };
    let para = build("中abc文", cfg);
    assert!(para.items.iter().all(|i| i.kind != Kind::Glue || i.width == 0.0));
}

#[test]
fn kinsoku_forbids_breaking_before_a_full_stop() {
    // The measure fits exactly four ideographs. A greedy breaker would put 。
    // at the head of line two; kinsoku must pull a character down instead.
    let cfg = test_config();
    let text = "中文排版。中文排版。";
    let lines = lines_of(text, EM * 4.0, cfg);
    for l in &lines {
        assert!(
            !l.starts_with('。'),
            "a line began with a full stop, which kinsoku forbids: {lines:?}"
        );
    }
}

#[test]
fn kinsoku_forbids_breaking_after_an_opening_bracket() {
    let cfg = test_config();
    let text = "中文排版「中文排版」中文";
    let lines = lines_of(text, EM * 4.0, cfg);
    for l in &lines {
        assert!(!l.ends_with('「'), "line ended with an opener: {lines:?}");
        assert!(!l.starts_with('」'), "line began with a closer: {lines:?}");
    }
}

#[test]
fn punctuation_carries_shrinkability_on_its_empty_half() {
    let cfg = test_config();
    let para = build("中。文（中", cfg);
    let full_stop = para.atoms.iter().find(|a| a.class == CharClass::PunctLeft).unwrap();
    assert!(full_stop.shrink_right > 0.0 && full_stop.shrink_left == 0.0);
    let open = para.atoms.iter().find(|a| a.class == CharClass::PunctRight).unwrap();
    assert!(open.shrink_left > 0.0 && open.shrink_right == 0.0);
}

#[test]
fn every_run_maps_back_to_its_source_bytes() {
    // The property the editor depends on: concatenating all runs in order
    // reproduces the paragraph exactly.
    let cfg = test_config();
    let text = "The quick brown fox 跳过了那只懒狗 and kept running onward.";
    let para = build(text, cfg);
    let breaks = break_lines(&para, EM * 20.0);
    let lines = layout_lines(&para, &breaks);
    let mut seen = String::new();
    for l in &lines {
        for r in l.runs.iter().filter(|r| r.start != u32::MAX) {
            seen.push_str(&text[r.start as usize..r.end as usize]);
        }
    }
    let expected: String = text.chars().filter(|c| *c != ' ').collect();
    assert_eq!(seen, expected);
}

/// First-fit line breaking — the algorithm every browser uses. Returns the
/// adjustment ratio of each line, so the two strategies can be compared on
/// the metric that actually matters: how uneven the word spacing ends up.
fn greedy_ratios(para: &Paragraph, width: f32) -> Vec<f32> {
    let items = &para.items;
    let mut ratios = Vec::new();
    let (mut w, mut y, mut z) = (0.0f32, 0.0f32, 0.0f32);
    let (mut lw, mut ly, mut lz) = (0.0f32, 0.0f32, 0.0f32);
    let mut last: Option<(f32, f32, f32)> = None;
    for (i, it) in items.iter().enumerate() {
        let legal = match it.kind {
            Kind::Glue => i > 0 && items[i - 1].kind == Kind::Box,
            Kind::Penalty => it.penalty < INFINITE_PENALTY,
            Kind::Box => false,
        };
        if legal {
            let natural = w - lw + if it.kind == Kind::Penalty { it.width } else { 0.0 };
            if natural > width {
                if let Some((bw, by, bz)) = last.take() {
                    let d = width - (bw - lw);
                    let pool = if d > 0.0 { by - ly } else { bz - lz };
                    ratios.push(if pool > 0.0 { d / pool } else { 0.0 });
                    lw = bw;
                    ly = by;
                    lz = bz;
                }
            }
            last = Some((w + if it.kind == Kind::Penalty { it.width } else { 0.0 }, y, z));
        }
        if it.kind != Kind::Penalty {
            w += it.width;
        }
        y += it.stretch;
        z += it.shrink;
    }
    ratios
}

fn total_badness(ratios: &[f32]) -> f32 {
    ratios.iter().map(|r| 100.0 * r.abs().powi(3)).sum()
}

#[test]
fn optimal_breaking_beats_greedy() {
    // The whole point of Knuth-Plass: accept a slightly worse line here to
    // save two much worse ones later. On a narrow measure — where the choice
    // actually bites — the difference should be dramatic, not marginal.
    let cfg = test_config();
    let text = "The quick brown fox jumps over the lazy dog while the \
                typesetter considers whether this particular line of prose \
                would look better broken somewhere else entirely, as it so \
                often does in practice.";
    let width = EM * 18.0;
    let para = build(text, cfg);
    let breaks = break_lines(&para, width);
    assert!(breaks.len() > 3, "expected several lines, got {}", breaks.len());

    let kp: Vec<f32> = breaks[..breaks.len() - 1].iter().map(|b| b.ratio).collect();
    let greedy = greedy_ratios(&para, width);

    let kp_worst = kp.iter().fold(0.0f32, |m, r| m.max(r.abs()));
    let greedy_worst = greedy.iter().fold(0.0f32, |m, r| m.max(r.abs()));

    assert!(
        total_badness(&kp) < total_badness(&greedy) / 4.0,
        "optimal badness {:.0} should be far below greedy's {:.0} (ratios {kp:?})",
        total_badness(&kp),
        total_badness(&greedy),
    );
    assert!(
        kp_worst < greedy_worst,
        "worst line should improve: {kp_worst:.2} vs {greedy_worst:.2}"
    );
    assert!(kp_worst <= cfg.tolerance, "no line may exceed tolerance");
}

#[test]
fn never_exceeds_tolerance_when_a_feasible_solution_exists() {
    let cfg = test_config();
    let text = "The quick brown fox jumps over the lazy dog and keeps on \
                going for quite some considerable distance afterwards.";
    for ems in [16.0, 20.0, 24.0, 28.0, 32.0, 40.0] {
        let para = build(text, cfg);
        let breaks = break_lines(&para, EM * ems);
        for b in &breaks[..breaks.len() - 1] {
            assert!(
                b.ratio <= cfg.tolerance + 1e-3,
                "ratio {} exceeded tolerance at {ems} em",
                b.ratio
            );
        }
    }
}

#[test]
fn justified_lines_land_on_the_measure() {
    let cfg = test_config();
    let text = "The quick brown fox jumps over the lazy dog and then turns \
                around to jump back over it again for good measure.";
    let width = EM * 16.0;
    let para = build(text, cfg);
    let breaks = break_lines(&para, width);
    let lines = layout_lines(&para, &breaks);
    // Every line but the last should be flush to within a rounding error.
    for l in &lines[..lines.len() - 1] {
        assert!(
            (l.width - width).abs() < 1.0,
            "justified line was {} wide, wanted {width}",
            l.width
        );
    }
}

#[test]
fn pure_cjk_at_an_integer_measure_needs_no_stretching() {
    // Every ideograph is exactly 1 em, so a measure that is a whole number of
    // ems should produce perfectly rigid lines.
    let cfg = test_config();
    let text = "中文排版中文排版中文排版中文排版中文排版中文排版";
    let para = build(text, cfg);
    let width = EM * 8.0;
    let breaks = break_lines(&para, width);
    for b in &breaks[..breaks.len() - 1] {
        assert!(b.ratio.abs() < 1e-3, "ratio should be ~0, was {}", b.ratio);
    }
}

#[test]
fn avoids_hyphenating_two_lines_in_a_row() {
    let cfg = test_config();
    let text = "Extraordinary transformations accompanied the international \
                organisation's administrative reorganisation programme \
                throughout the preceding administrative period.";
    let width = EM * 20.0;
    let para = build(text, cfg);
    let breaks = break_lines(&para, width);
    let mut consecutive = 0;
    let mut worst = 0;
    for b in &breaks {
        if b.hyphenated {
            consecutive += 1;
            worst = worst.max(consecutive);
        } else {
            consecutive = 0;
        }
    }
    assert!(worst <= 2, "{worst} hyphenated lines in a row is too many");
}

#[test]
fn the_first_pass_avoids_hyphens_altogether_when_it_can() {
    // TeX only reaches for hyphenation when a tight, unhyphenated setting is
    // impossible. Comfortable text should come out with none at all.
    let cfg = test_config();
    let text = "The quick brown fox jumps over the lazy dog and then it \
                turns around and goes back over the dog once more.";
    let para = build(text, cfg);
    let breaks = break_lines(&para, EM * 30.0);
    assert!(
        breaks.iter().all(|b| !b.hyphenated),
        "a roomy measure should need no hyphens"
    );
}

#[test]
fn handles_degenerate_input_without_panicking() {
    let cfg = test_config();
    for text in ["", " ", "a", "。", "中", "\u{200B}", &"x".repeat(500)] {
        let para = build(text, cfg);
        for width in [1.0, EM, EM * 3.0, 10_000.0] {
            let breaks = break_lines(&para, width);
            let _ = layout_lines(&para, &breaks);
        }
    }
}

#[test]
fn an_unbreakable_word_wider_than_the_measure_still_lays_out() {
    let cfg = test_config();
    let text = "supercalifragilisticexpialidocious";
    let para = build(text, cfg);
    let breaks = break_lines(&para, EM * 3.0);
    assert!(!breaks.is_empty(), "must still produce a line");
}

#[test]
fn the_last_line_reports_its_own_width_not_the_measure() {
    // The paragraph ends with infinitely stretchable glue so that the final
    // line is never justified. That glue must not be counted as ink.
    let cfg = test_config();
    let text = "The quick brown fox jumps over the lazy dog. End.";
    let width = EM * 18.0;
    let para = build(text, cfg);
    let breaks = break_lines(&para, width);
    let lines = layout_lines(&para, &breaks);
    let last = lines.last().unwrap();
    assert!(
        last.width < width,
        "a short last line reported {} against a measure of {width}",
        last.width
    );
    assert!(last.width > 0.0);
}

#[test]
fn ragged_right_does_not_stretch_the_glue() {
    // Turning justification off must actually leave the lines ragged. The
    // optimiser still runs — that is the point, it produces a *better* ragged
    // edge than greedy filling — but no line may be padded out to the measure.
    let text = "The quick brown fox jumps over the lazy dog and then goes \
                back again to make quite sure that it really did happen.";
    let width = EM * 18.0;

    let justified = {
        let cfg = Config { justify: true, ..test_config() };
        let para = build(text, cfg);
        let breaks = break_lines(&para, width);
        layout_lines(&para, &breaks)
    };
    let ragged = {
        let cfg = Config { justify: false, ..test_config() };
        let para = build(text, cfg);
        let breaks = break_lines(&para, width);
        layout_lines(&para, &breaks)
    };

    assert!(justified.len() > 2 && ragged.len() > 2);
    for l in &justified[..justified.len() - 1] {
        assert!((l.width - width).abs() < 1.0, "justified line should be flush");
    }
    let any_short = ragged[..ragged.len() - 1].iter().any(|l| l.width < width - 2.0);
    assert!(any_short, "ragged lines should fall short of the measure");
    for l in &ragged {
        assert!(l.width <= width + 1.0, "a ragged line must not overrun: {}", l.width);
    }
}

#[test]
fn font_expansion_scales_glyphs_instead_of_spaces() {
    let text = "The quick brown fox jumps over the lazy dog and keeps on going.";
    let width = EM * 17.0;
    let cfg = Config { max_expand: 0.02, ..test_config() };
    let para = build(text, cfg);
    let breaks = break_lines(&para, width);
    let lines = layout_lines(&para, &breaks);
    let scaled = lines
        .iter()
        .flat_map(|l| l.runs.iter())
        .any(|r| (r.scale_x - 1.0).abs() > 1e-4);
    assert!(scaled, "some run should have been expanded or condensed");
    for r in lines.iter().flat_map(|l| l.runs.iter()) {
        assert!(
            (r.scale_x - 1.0).abs() <= 0.02 + 1e-6,
            "expansion must stay within the configured limit, saw {}",
            r.scale_x
        );
    }
}

/// Per-character widths that differ sharply, so that any scheme which
/// apportions a word's width evenly across its parts is exposed.
fn variable_measure(text: &str, tokens: &[Token]) -> Vec<f32> {
    let mut out = Vec::with_capacity(tokens.len() * 6);
    for t in tokens {
        let s = &text[t.start as usize..t.end as usize];
        let w = match t.class {
            CharClass::Cjk
            | CharClass::PunctLeft
            | CharClass::PunctRight
            | CharClass::PunctCenter => EM,
            CharClass::Space => EM / 3.0,
            _ => s.chars().map(char_width).sum(),
        };
        out.extend_from_slice(&[w, ASCENT, DESCENT, f32::NAN, char_width('-'), w]);
    }
    out
}

fn char_width(c: char) -> f32 {
    match c {
        'i' | 'l' | 'j' | 't' | 'f' | 'I' | '.' | ',' => EM * 0.22,
        'm' | 'w' | 'M' | 'W' => EM * 0.95,
        _ => EM * 0.5,
    }
}

#[test]
fn every_box_is_as_wide_as_the_text_it_draws() {
    // The invariant the renderer depends on: a box's width is the measured
    // width of its own characters. Break it and adjacent runs either overlap
    // or leave a gap, because the next run is positioned by adding this width.
    let cfg = test_config();
    let text = "Extraordinary internationalisation transformations accompanied \
                the organisation's administrative reorganisation programme.";
    let tokens = tokenize(&text, cfg.punct_style, cfg.hyphenate);
    let adv = variable_measure(text, &tokens);
    let para = prepare(text, &tokens, &adv, EM / 3.0, cfg);

    for atom in &para.atoms {
        let s = &text[atom.start as usize..atom.end as usize];
        let expected: f32 = s.chars().map(char_width).sum();
        assert!(
            (atom.width - expected).abs() < 0.01,
            "box for {s:?} is {} wide but its glyphs measure {expected}",
            atom.width,
        );
    }
}

#[test]
fn hyphenated_words_are_split_into_measurable_pieces() {
    // Hyphenation points have to exist before measurement, not after, or the
    // pieces get widths nobody measured.
    let cfg = test_config();
    let toks = tokenize("extraordinary", cfg.punct_style, true);
    assert!(toks.len() > 1, "a long word should offer hyphenation points");
    assert!(toks[..toks.len() - 1].iter().all(|token| token.hyphen_after));
    assert!(!toks.last().unwrap().hyphen_after);
    let joined: String = toks
        .iter()
        .map(|t| &"extraordinary"[t.start as usize..t.end as usize])
        .collect();
    assert_eq!(joined, "extraordinary", "the pieces must reassemble exactly");

    // And with hyphenation off it stays whole.
    let whole = tokenize("extraordinary", cfg.punct_style, false);
    assert_eq!(whole.len(), 1);
}

#[test]
fn style_boundaries_split_measurement_without_inventing_hyphens() {
    let cfg = Config { hyphenate: false, ..test_config() };
    let text = "abc";
    let tokens = tokenize_with_boundaries(text, cfg.punct_style, cfg.hyphenate, &[1]);
    let pieces: Vec<&str> = tokens
        .iter()
        .map(|t| &text[t.start as usize..t.end as usize])
        .collect();
    assert_eq!(pieces, vec!["a", "bc"]);
    assert!(tokens.iter().all(|t| !t.hyphen_after));

    let para = prepare(text, &tokens, &measure(text, &tokens), EM / 3.0, cfg);
    assert_eq!(para.items[0].kind, Kind::Box);
    assert_eq!(para.items[1].kind, Kind::Box, "a style cut must not insert a penalty");
    assert!(para.items.iter().all(|item| !item.flagged));
}

#[test]
fn style_boundaries_preserve_real_hyphenation_points() {
    let cfg = test_config();
    let text = "extraordinary";
    let plain = tokenize(text, cfg.punct_style, true);
    let split = tokenize_with_boundaries(text, cfg.punct_style, true, &[1, 3, 5, 7]);
    let points = |tokens: &[Token]| {
        tokens
            .iter()
            .filter(|token| token.hyphen_after)
            .map(|token| token.end)
            .collect::<Vec<_>>()
    };
    assert_eq!(points(&split), points(&plain));
    assert!(split.iter().any(|token| token.end == 1 && !token.hyphen_after));
}

#[test]
fn style_boundaries_are_validated_as_utf8_offsets() {
    let cfg = Config { hyphenate: false, ..test_config() };
    let text = "é😀中文";
    // 1 is inside é, 3 is inside the emoji and 7 is inside 中. None may be
    // used for slicing; valid, unsorted and duplicate offsets remain safe.
    let tokens = tokenize_with_boundaries(
        text,
        cfg.punct_style,
        cfg.hyphenate,
        &[7, 2, 3, 2, 6, 999],
    );
    let pieces: Vec<&str> = tokens
        .iter()
        .map(|token| &text[token.start as usize..token.end as usize])
        .collect();
    assert_eq!(pieces, vec!["é", "😀", "中", "文"]);
}

#[test]
fn object_tokens_survive_mandatory_boundaries() {
    let cfg = Config { hyphenate: false, ..test_config() };
    let text = "a\u{FFFC}b\u{FFFC}";
    let tokens = tokenize_with_boundaries(text, cfg.punct_style, cfg.hyphenate, &[1, 4, 5]);
    assert_eq!(tokens.iter().filter(|token| token.class == CharClass::Object).count(), 2);
}

#[test]
fn a_space_uses_its_own_measured_width() {
    let cfg = test_config();
    let text = "a b";
    let tokens = tokenize(text, cfg.punct_style, false);
    let mut metrics = measure(text, &tokens);
    let space = tokens.iter().position(|token| token.class == CharClass::Space).unwrap();
    metrics[space * 6] = 9.0;
    let para = prepare(text, &tokens, &metrics, 5.0, cfg);
    let glue = para.items.iter().find(|item| item.kind == Kind::Glue && item.width > 0.0).unwrap();
    assert_eq!(glue.width, 9.0);
}

#[test]
fn syllables_of_one_word_are_positioned_without_gaps() {
    // Lay a hyphenatable word out on a wide measure so it is never broken,
    // and check that its pieces sit flush against one another.
    let cfg = Config { justify: false, ..test_config() };
    let text = "extraordinary";
    let tokens = tokenize(text, cfg.punct_style, cfg.hyphenate);
    let adv = variable_measure(text, &tokens);
    let para = prepare(text, &tokens, &adv, EM / 3.0, cfg);
    let breaks = break_lines(&para, EM * 40.0);
    let lines = layout_lines(&para, &breaks);
    assert_eq!(lines.len(), 1);

    let runs: Vec<_> = lines[0].runs.iter().filter(|r| r.start != u32::MAX).collect();
    for pair in runs.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        let a_text = &text[a.start as usize..a.end as usize];
        let a_width: f32 = a_text.chars().map(char_width).sum();
        assert!(
            (a.x + a_width - b.x).abs() < 0.01,
            "{a_text:?} ends at {} but the next piece starts at {}",
            a.x + a_width,
            b.x,
        );
    }
}

// ---------------------------------------------------------------------------
// Interline glue. Lines are not stacked on a fixed grid: TeX aims for a
// constant baseline-to-baseline distance but yields when something on a line
// is tall or deep enough that honouring it would cause a collision. That is
// what will let an inline formula sit in running text without crashing into
// the line above.
// ---------------------------------------------------------------------------

/// Lay a paragraph out with one token given outsized vertical metrics, to
/// stand in for an inline formula.
fn build_with_tall_token(
    text: &str,
    tall: &str,
    height: f32,
    depth: f32,
    cfg: Config,
) -> Vec<Line> {
    let tokens = tokenize(text, cfg.punct_style, cfg.hyphenate);
    let mut metrics = Vec::with_capacity(tokens.len() * 6);
    for t in &tokens {
        let s = &text[t.start as usize..t.end as usize];
        let w = match t.class {
            CharClass::Cjk
            | CharClass::PunctLeft
            | CharClass::PunctRight
            | CharClass::PunctCenter => EM,
            CharClass::Space => EM / 3.0,
            _ => s.chars().count() as f32 * EM * 0.5,
        };
        if s == tall {
            metrics.extend_from_slice(&[w, height, depth, f32::NAN, char_width('-'), w]);
        } else {
            metrics.extend_from_slice(&[w, ASCENT, DESCENT, f32::NAN, char_width('-'), w]);
        }
    }
    let para = prepare(text, &tokens, &metrics, EM / 3.0, cfg);
    let breaks = break_lines(&para, EM * 20.0);
    layout_lines(&para, &breaks)
}

#[test]
fn uniform_text_keeps_an_even_baseline_rhythm() {
    // When every line has the same height and depth, the interline computation
    // must reduce exactly to a constant baseline-to-baseline distance —
    // otherwise ordinary prose would ripple.
    let cfg = test_config();
    let text = "The quick brown fox jumps over the lazy dog and then it turns \
                around and goes back over the dog once more for good measure.";
    let para = build(text, cfg);
    let breaks = break_lines(&para, EM * 20.0);
    let lines = layout_lines(&para, &breaks);
    assert!(lines.len() >= 3, "need several lines, got {}", lines.len());

    assert!(
        (lines[0].baseline - ASCENT).abs() < 1e-3,
        "the first baseline should sit its own height below the top, was {}",
        lines[0].baseline
    );
    for pair in lines.windows(2) {
        let delta = pair[1].baseline - pair[0].baseline;
        assert!(
            (delta - cfg.baseline_skip).abs() < 1e-3,
            "baselines should be {} apart, were {delta}",
            cfg.baseline_skip
        );
    }
}

#[test]
fn a_tall_atom_pushes_its_own_line_down() {
    // A formula taller than the text must not reach up into the line above.
    let cfg = test_config();
    let text = "one two three four five six seven eight nine ten eleven twelve \
                thirteen TALL fourteen fifteen sixteen seventeen eighteen";
    let tall_height = EM * 2.5;
    let lines = build_with_tall_token(text, "TALL", tall_height, DESCENT, cfg);

    let index = lines
        .iter()
        .position(|l| {
            l.runs
                .iter()
                .any(|r| r.start != u32::MAX && &text[r.start as usize..r.end as usize] == "TALL")
        })
        .expect("the tall token should be on some line");
    assert!(index > 0, "put the tall token on a line that has one above it");

    assert!(
        (lines[index].height - tall_height).abs() < 1e-3,
        "the line should be as tall as its tallest atom"
    );

    let above = &lines[index - 1];
    let top_of_tall_line = lines[index].baseline - lines[index].height;
    let bottom_of_line_above = above.baseline + above.depth;
    assert!(
        top_of_tall_line >= bottom_of_line_above - 1e-3,
        "the tall line's top ({top_of_tall_line}) overlaps the line above ({bottom_of_line_above})"
    );
}

#[test]
fn a_deep_atom_pushes_the_following_line_down() {
    let cfg = test_config();
    let text = "one two three four five six seven eight nine ten eleven twelve \
                DEEP thirteen fourteen fifteen sixteen seventeen eighteen nineteen";
    let deep = EM * 2.0;
    let lines = build_with_tall_token(text, "DEEP", ASCENT, deep, cfg);

    let index = lines
        .iter()
        .position(|l| {
            l.runs
                .iter()
                .any(|r| r.start != u32::MAX && &text[r.start as usize..r.end as usize] == "DEEP")
        })
        .expect("the deep token should be on some line");
    assert!(index + 1 < lines.len(), "need a line after the deep one");
    assert!((lines[index].depth - deep).abs() < 1e-3);

    let gap = (lines[index + 1].baseline - lines[index + 1].height)
        - (lines[index].baseline + lines[index].depth);
    assert!(gap >= -1e-3, "the following line overlaps the deep one by {}", -gap);
    assert!(
        (gap - cfg.line_skip).abs() < 1e-3,
        "once the target is exhausted the gap should be exactly lineskip, was {gap}"
    );
}

#[test]
fn no_two_lines_ever_overlap() {
    // The invariant the whole scheme exists to guarantee, checked over a
    // paragraph with several outsized atoms.
    let cfg = test_config();
    let text = "alpha BIG beta gamma delta epsilon zeta eta theta iota kappa \
                lambda BIG mu nu xi omicron pi rho sigma tau upsilon phi chi \
                psi omega and some more words to force several lines here";
    for (h, d) in [(EM * 3.0, DESCENT), (ASCENT, EM * 2.0), (EM * 2.0, EM * 1.5)] {
        let lines = build_with_tall_token(text, "BIG", h, d, cfg);
        for pair in lines.windows(2) {
            let clearance = (pair[1].baseline - pair[1].height) - (pair[0].baseline + pair[0].depth);
            assert!(
                clearance >= -1e-3,
                "lines overlap by {} with height {h} depth {d}",
                -clearance
            );
        }
    }
}

#[test]
fn an_object_is_its_own_token_and_spaces_against_han() {
    // An inline formula reaches the engine as U+FFFC. It must tokenize on its
    // own — never absorbed into a neighbouring word — and must take the same
    // quarter-em against a Han character that a Latin word would, since to a
    // Chinese reader a formula is western content.
    let cfg = test_config();
    let text = "中\u{FFFC}文 and\u{FFFC}here";
    let toks = tokenize(text, cfg.punct_style, cfg.hyphenate);
    let pieces: Vec<&str> = toks
        .iter()
        .map(|t| &text[t.start as usize..t.end as usize])
        .collect();
    assert_eq!(
        pieces,
        vec!["中", "\u{FFFC}", "文", " ", "and", "\u{FFFC}", "here"],
        "the object must not be swallowed into a word"
    );

    let para = build(text, cfg);
    let gaps: Vec<f32> = para
        .items
        .iter()
        .filter(|i| i.kind == Kind::Glue && i.width > 0.0)
        .map(|i| i.width)
        .collect();
    // 中|FFFC and FFFC|文 each earn a quarter em; the literal space is the third.
    let quarter = EM * 0.25;
    let quarters = gaps.iter().filter(|w| (**w - quarter).abs() < 1e-3).count();
    assert_eq!(quarters, 2, "expected two mixed-script gaps, saw {gaps:?}");
}

#[test]
fn a_tall_object_makes_its_line_taller() {
    // The end-to-end property inline math depends on: give one token the
    // metrics of a fraction and the line it lands on grows to hold it.
    let cfg = test_config();
    let text = "the value \u{FFFC} appears in the middle of this sentence here";
    let short = build_with_tall_token(text, "\u{FFFC}", ASCENT, DESCENT, cfg);
    let tall = build_with_tall_token(text, "\u{FFFC}", EM * 2.2, EM * 1.1, cfg);

    let line_of = |lines: &[Line]| {
        lines
            .iter()
            .position(|l| {
                l.runs.iter().any(|r| {
                    r.start != u32::MAX && text[r.start as usize..r.end as usize] == *"\u{FFFC}"
                })
            })
            .expect("the object should be on some line")
    };
    let i = line_of(&tall);
    assert!((tall[i].height - EM * 2.2).abs() < 1e-3);
    assert!((tall[i].depth - EM * 1.1).abs() < 1e-3);

    // And the paragraph grows to accommodate it rather than overlapping.
    let last = |lines: &[Line]| lines.last().unwrap().baseline + lines.last().unwrap().depth;
    assert!(
        last(&tall) > last(&short),
        "a taller formula should make the paragraph taller"
    );
}

// ---------------------------------------------------------------------------
// Breaking inside an inline formula.
//
// TeX allows a line to end after a binary operator or a relation at the outer
// level of an inline formula, charging \binoppenalty or \relpenalty. The host
// hands the formula over as several object atoms with those penalties between
// them; from the optimiser's point of view nothing is new, which is the whole
// reason this works.
// ---------------------------------------------------------------------------

/// A paragraph in which one "formula" arrives as several pieces.
fn build_split_formula(
    lead: &str,
    pieces: &[(f32, Option<f32>)],
    trail: &str,
    cfg: Config,
) -> (String, Paragraph) {
    let mut text = String::from(lead);
    for _ in pieces {
        text.push('\u{FFFC}');
    }
    text.push_str(trail);

    let tokens = tokenize(&text, cfg.punct_style, cfg.hyphenate);
    let mut metrics = Vec::with_capacity(tokens.len() * 6);
    let mut piece = 0usize;
    for t in &tokens {
        let s = &text[t.start as usize..t.end as usize];
        if s == "\u{FFFC}" {
            let (w, penalty) = pieces[piece];
            piece += 1;
            metrics.extend_from_slice(&[w, ASCENT, DESCENT, penalty.unwrap_or(f32::NAN), char_width('-'), w]);
        } else {
            let w = match t.class {
                CharClass::Cjk
                | CharClass::PunctLeft
                | CharClass::PunctRight
                | CharClass::PunctCenter => EM,
                CharClass::Space => EM / 3.0,
                _ => s.chars().count() as f32 * EM * 0.5,
            };
            metrics.extend_from_slice(&[w, ASCENT, DESCENT, f32::NAN, char_width('-'), w]);
        }
    }
    let para = prepare(&text, &tokens, &metrics, EM / 3.0, cfg);
    (text, para)
}

#[test]
fn the_penalties_reach_the_horizontal_list() {
    // The mechanism, checked directly: a penalty supplied with a token
    // becomes a penalty item between that box and the next, carrying TeX's
    // own cost, and nothing else is inserted between them.
    let cfg = test_config();
    let (_, para) = build_split_formula(
        "x ",
        &[(EM * 2.0, Some(700.0)), (EM * 2.0, Some(500.0)), (EM * 2.0, None)],
        " y",
        cfg,
    );
    let costs: Vec<f32> = para
        .items
        .iter()
        .filter(|i| i.kind == Kind::Penalty && i.penalty > 0.0 && i.penalty < INFINITE_PENALTY)
        .map(|i| i.penalty)
        .collect();
    assert_eq!(costs, vec![700.0, 500.0], "binoppenalty then relpenalty");

    // The pieces are adjacent boxes with only that penalty between them.
    let kinds: Vec<Kind> = para.items.iter().map(|i| i.kind).collect();
    let first_object = para
        .atoms
        .iter()
        .position(|a| a.class == CharClass::Object)
        .expect("an object atom");
    assert!(first_object > 0);
    let window: Vec<Kind> = kinds
        .iter()
        .skip_while(|k| **k != Kind::Box)
        .copied()
        .collect();
    assert!(window.contains(&Kind::Penalty));
}

#[test]
fn a_formula_can_break_after_a_binary_operator() {
    // The formula is wider than the measure, so no arrangement fits it on one
    // line. A breaker that treats it as indivisible has no answer here except
    // to overflow; one that can split it does the obvious thing.
    //
    // Note what the previous behaviour would be: given a formula that *does*
    // fit on a line of its own, the optimiser rightly prefers an ordinary word
    // space to paying \binoppenalty. Splitting is a last resort, which is
    // exactly TeX's intent.
    let cfg = test_config();
    let (text, para) = build_split_formula(
        "the identity ",
        &[(EM * 4.5, Some(700.0)), (EM * 4.5, Some(500.0)), (EM * 4.5, None)],
        " holds for every n",
        cfg,
    );
    let width = EM * 10.0;
    let breaks = break_lines(&para, width);
    let lines = layout_lines(&para, &breaks);
    assert!(lines.len() >= 2, "expected the paragraph to wrap");

    let objects_on = |line: &Line| {
        line.runs
            .iter()
            .filter(|r| r.start != u32::MAX && text[r.start as usize..r.end as usize] == *"\u{FFFC}")
            .count()
    };
    let spread: Vec<usize> = lines.iter().map(objects_on).collect();
    assert_eq!(spread.iter().sum::<usize>(), 3, "every piece must be placed once");
    assert!(
        spread.iter().filter(|n| **n > 0).count() >= 2,
        "the formula should have been split across lines, was {spread:?}"
    );
}

#[test]
fn an_unbreakable_formula_stays_whole() {
    // The same paragraph with no penalties offered: the optimiser has no
    // choice but to keep the pieces together.
    let cfg = test_config();
    let (text, para) = build_split_formula(
        "the identity ",
        &[(EM * 3.0, None), (EM * 3.0, None), (EM * 3.0, None)],
        " holds for every n",
        cfg,
    );
    let breaks = break_lines(&para, EM * 10.0);
    let lines = layout_lines(&para, &breaks);
    let counts: Vec<usize> = lines
        .iter()
        .map(|l| {
            l.runs
                .iter()
                .filter(|r| {
                    r.start != u32::MAX && text[r.start as usize..r.end as usize] == *"\u{FFFC}"
                })
                .count()
        })
        .collect();
    assert_eq!(
        counts.iter().filter(|n| **n > 0).count(),
        1,
        "with no penalties the pieces must stay on one line, were {counts:?}"
    );
}

#[test]
fn breaking_a_formula_costs_more_than_breaking_at_a_space() {
    // The penalties must actually be felt: given a choice, the optimiser
    // should prefer an ordinary word space to splitting the formula.
    let cfg = test_config();
    let (_, cheap) = build_split_formula(
        "alpha beta ",
        &[(EM * 2.0, Some(700.0)), (EM * 2.0, None)],
        " gamma delta",
        cfg,
    );
    let width = EM * 12.0;
    let breaks = break_lines(&cheap, width);
    // Whatever it chooses, no line may exceed tolerance and every piece is
    // placed — the optimiser is free, but must remain correct.
    for b in &breaks[..breaks.len() - 1] {
        assert!(b.ratio <= cfg.tolerance + 1e-3, "ratio {} exceeded tolerance", b.ratio);
    }
}

#[test]
fn an_infinite_penalty_between_pieces_forbids_the_break() {
    let cfg = test_config();
    let (text, para) = build_split_formula(
        "the identity ",
        &[(EM * 3.0, Some(INFINITE_PENALTY)), (EM * 3.0, None)],
        " holds",
        cfg,
    );
    let breaks = break_lines(&para, EM * 14.0);
    let lines = layout_lines(&para, &breaks);
    let counts: Vec<usize> = lines
        .iter()
        .map(|l| {
            l.runs
                .iter()
                .filter(|r| {
                    r.start != u32::MAX && text[r.start as usize..r.end as usize] == *"\u{FFFC}"
                })
                .count()
        })
        .collect();
    assert_eq!(
        counts.iter().filter(|n| **n > 0).count(),
        1,
        "an infinite penalty must keep the pieces together, were {counts:?}"
    );
}

#[test]
fn a_line_separator_ends_its_line_wherever_it_falls() {
    // U+2028 is a break the author asked for, not one the optimiser chose, so
    // it holds even where the line had room to spare.
    let cfg = test_config();
    let text = "alpha\u{2028}beta gamma";
    let para = build(text, cfg);
    let breaks = break_lines(&para, EM * 40.0);
    let lines = layout_lines(&para, &breaks);
    assert_eq!(lines.len(), 2, "the separator must start a new line");

    let content: Vec<String> = lines
        .iter()
        .map(|l| {
            l.runs
                .iter()
                .filter(|r| r.start != u32::MAX)
                .map(|r| text[r.start as usize..r.end as usize].to_string())
                .collect()
        })
        .collect();
    assert_eq!(content[0], "alpha");
    assert_eq!(content[1], "betagamma");
}

#[test]
fn a_line_separator_paints_nothing() {
    let cfg = test_config();
    let text = "a\u{2028}b";
    let para = build(text, cfg);
    assert!(
        !para.atoms.iter().any(|a| a.class == CharClass::Break),
        "a forced break carries no ink, so it contributes no box"
    );
    let breaks = break_lines(&para, EM * 20.0);
    let lines = layout_lines(&para, &breaks);
    let drawn: String = lines
        .iter()
        .flat_map(|l| l.runs.iter())
        .filter(|r| r.start != u32::MAX)
        .map(|r| text[r.start as usize..r.end as usize].to_string())
        .collect();
    assert_eq!(drawn, "ab", "the separator itself is never drawn");
}

#[test]
fn a_forced_break_costs_the_optimiser_nothing() {
    // LaTeX's `\\` is `\hfil\break`. Without the `\hfil` the short line before
    // the break is charged its full badness, and the optimiser pays for a
    // decision it never made — pulling text up into earlier lines to fill a
    // line it cannot lengthen.
    let cfg = test_config();
    let text = "one two three\u{2028}four five six seven eight nine ten eleven twelve";
    let para = build(text, cfg);
    let breaks = break_lines(&para, EM * 30.0);
    assert!(breaks.len() >= 2);

    // The line ending at the forced break must be free, however short it is.
    let forced = breaks
        .iter()
        .find(|b| para.items[b.position].is_forced_break())
        .expect("a forced break among the chosen breakpoints");
    assert!(
        forced.ratio.abs() < 1e-3,
        "a forced break should need no stretching, ratio was {}",
        forced.ratio
    );
}
