use typeset_core::*;
const EM: f32 = 18.0;

fn measure(text: &str, tokens: &[Token]) -> Vec<f32> {
    tokens.iter().map(|t| {
        let s = &text[t.start as usize..t.end as usize];
        match t.class {
            CharClass::Cjk | CharClass::PunctLeft | CharClass::PunctRight | CharClass::PunctCenter => EM,
            CharClass::Space => EM * 0.25,
            _ => s.chars().count() as f32 * EM * 0.5,
        }
    }).collect()
}

fn main() {
    let text = std::env::args().nth(1).unwrap_or_else(||
        "TeX 把一段文字拆成三样东西，其余一切都由它们组合而成：".to_string());
    let cfg = Config { font_size: EM, ..Default::default() };
    let tokens = tokenize(&text, cfg.punct_style, cfg.hyphenate);
    let adv = measure(&text, &tokens);
    let para = prepare(&text, &tokens, &adv, EM * 0.25, cfg);

    println!("{:>4} {:>8} {:>7} {:>7} {:>7} {:>9}  what", "i","kind","width","stretch","shrink","penalty");
    for (i, it) in para.items.iter().enumerate() {
        let what = if it.kind == Kind::Box {
            para.atoms.get(it.atom as usize)
                .map(|a| format!("box  {:?}", &text[a.start as usize..a.end as usize]))
                .unwrap_or_default()
        } else { format!("{:?}", it.kind) };
        // only show non-trivial glue and penalties, plus all boxes
        if it.kind == Kind::Glue && it.width == 0.0 && it.stretch < 1.0 { continue; }
        println!("{i:>4} {:>8} {:>7.2} {:>7.2} {:>7.2} {:>9.0}  {what}",
            format!("{:?}", it.kind), it.width, it.stretch, it.shrink, it.penalty);
    }
    let total_glue: f32 = para.items.iter().filter(|i| i.kind == Kind::Glue).map(|i| i.width).sum();
    println!("\nglue with width>0: {}", para.items.iter().filter(|i| i.kind==Kind::Glue && i.width>0.0).count());
    println!("total glue width : {total_glue:.2}");
}
