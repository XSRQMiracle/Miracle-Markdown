//! Side-by-side comparison of greedy (what CSS does) and Knuth-Plass.
use typeset_core::*;
const EM: f32 = 16.0;

fn measure(text: &str, tokens: &[Token]) -> Vec<f32> {
    tokens.iter().flat_map(|t| {
        let s = &text[t.start as usize..t.end as usize];
        let w = match t.class {
            CharClass::Cjk | CharClass::PunctLeft | CharClass::PunctRight | CharClass::PunctCenter => EM,
            CharClass::Space => EM / 3.0,
            _ => s.chars().count() as f32 * EM * 0.5,
        };
        [w, EM * 0.8, EM * 0.2, f32::NAN, EM * 0.5, w]
    }).collect()
}

/// First-fit: take breakpoints as they come, break as late as still fits.
/// This is the algorithm every browser uses.
fn greedy(para: &Paragraph, width: f32) -> Vec<f32> {
    let items = &para.items;
    let mut ratios = Vec::new();
    let (mut w, mut y, mut z) = (0.0f32, 0.0f32, 0.0f32);
    let (mut lw, mut ly, mut lz) = (0.0f32, 0.0f32, 0.0f32);
    let mut last_legal: Option<(f32, f32, f32)> = None;
    for (i, it) in items.iter().enumerate() {
        let legal = match it.kind {
            Kind::Glue => i > 0 && items[i - 1].kind == Kind::Box,
            Kind::Penalty => it.penalty < 10_000.0,
            Kind::Box => false,
        };
        if legal {
            let n = w - lw + if it.kind == Kind::Penalty { it.width } else { 0.0 };
            if n > width {
                if let Some((bw, by, bz)) = last_legal.take() {
                    let d = width - (bw - lw);
                    let pool = if d > 0.0 { by - ly } else { bz - lz };
                    ratios.push(if pool > 0.0 { d / pool } else { 0.0 });
                    lw = bw; ly = by; lz = bz;
                }
            }
            last_legal = Some((w + if it.kind == Kind::Penalty { it.width } else { 0.0 }, y, z));
        }
        if it.kind != Kind::Penalty { w += it.width; }
        y += it.stretch; z += it.shrink;
    }
    ratios
}

fn run(label: &str, text: &str, ems: f32) {
    let cfg = Config { font_size: EM, ..Default::default() };
    let width = EM * ems;
    let tokens = tokenize(text, cfg.punct_style, cfg.hyphenate);
    let adv = measure(text, &tokens);
    let para = prepare(text, &tokens, &adv, EM / 3.0, cfg);
    let breaks = break_lines(&para, width);
    let lines = layout_lines(&para, &breaks);

    let kp: Vec<f32> = breaks[..breaks.len().saturating_sub(1)].iter().map(|b| b.ratio).collect();
    let gr = greedy(&para, width);
    let badness = |rs: &[f32]| rs.iter().map(|r| 100.0 * r.abs().powi(3)).sum::<f32>();
    let worst = |rs: &[f32]| rs.iter().fold(0.0f32, |m, r| m.max(r.abs()));

    println!("\n=== {label}  ({ems} em measure) ===");
    for l in &lines {
        let s: String = l.runs.iter()
            .map(|r| if r.start == u32::MAX { "-".into() }
                 else { text[r.start as usize..r.end as usize].to_string() })
            .collect();
        println!("  {:>7.3} |{s}", l.ratio);
    }
    println!("  knuth-plass: {} lines, worst |r| {:.2}, total badness {:.0}",
             kp.len() + 1, worst(&kp), badness(&kp));
    println!("  greedy     : {} lines, worst |r| {:.2}, total badness {:.0}",
             gr.len() + 1, worst(&gr), badness(&gr));
}

fn main() {
    let en = "The quick brown fox jumps over the lazy dog while the typesetter \
              considers whether this particular line of prose would look better \
              broken somewhere else entirely, as it so often does in practice.";
    run("english, narrow", en, 18.0);
    run("english, book measure", en, 32.0);

    let zh = "中文排版需要处理标点挤压与避头尾规则，在中西文混排时还要自动插入四分之一空格。\
              这套逻辑与 TeX 的 Knuth-Plass 断行算法结合后，可以得到远比浏览器贪心断行更均匀的灰度。";
    run("chinese mixed", zh, 20.0);
    run("chinese mixed, wide", zh, 30.0);
}
