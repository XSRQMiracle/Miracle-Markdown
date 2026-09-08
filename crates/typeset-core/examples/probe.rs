// Enumerate every legal first-line breakpoint by hand and score it, to see
// what the optimiser had available to choose from.
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
        [w, EM * 0.8, EM * 0.2, f32::NAN]
    }).collect()
}

fn main() {
    let cfg = Config { font_size: EM, ..Default::default() };
    let text = "The quick brown fox jumps over the lazy dog while the typesetter considers";
    let width = EM * 18.0;
    let tokens = tokenize(text, cfg.punct_style, cfg.hyphenate);
    let adv = measure(text, &tokens);
    let para = prepare(text, &tokens, &adv, EM / 3.0, cfg);

    let items = &para.items;
    let mut w = 0.0f32; let mut y = 0.0f32; let mut z = 0.0f32;
    println!("{:>4} {:>9} {:>8} {:>8} {:>8} {:>9} {:>7}  content", "idx","kind","natural","stretch","shrink","ratio","legal");
    for (i, it) in items.iter().enumerate() {
        let legal = match it.kind {
            Kind::Glue => i > 0 && items[i-1].kind == Kind::Box,
            Kind::Penalty => it.penalty < 10_000.0,
            Kind::Box => false,
        };
        if legal {
            let natural = w + if it.kind == Kind::Penalty { it.width } else { 0.0 };
            let delta = width - natural;
            let ratio = if delta > 0.0 { if y > 0.0 { delta / y } else { f32::INFINITY } }
                        else if delta < 0.0 { if z > 0.0 { delta / z } else { f32::NEG_INFINITY } }
                        else { 0.0 };
            let upto: String = items[..i].iter().filter(|x| x.kind == Kind::Box)
                .filter_map(|x| para.atoms.get(x.atom as usize))
                .map(|a| text[a.start as usize..a.end as usize].to_string()).collect::<Vec<_>>().join("");
            let tail: String = upto.chars().rev().take(18).collect::<Vec<_>>().into_iter().rev().collect();
            println!("{i:>4} {:>9} {natural:>8.1} {y:>8.1} {z:>8.1} {ratio:>9.3} {legal:>7}  …{tail}",
                format!("{:?}", it.kind));
        }
        if it.kind != Kind::Penalty { w += it.width; }
        y += it.stretch; z += it.shrink;
    }
}
