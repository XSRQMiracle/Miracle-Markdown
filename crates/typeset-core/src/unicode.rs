//! Character classification for CJK-aware typesetting.
//!
//! The punctuation tables follow CLReq appendix A.3 (Table of bracket
//! indication punctuation marks) and JLReq appendix A.1/A.2, matching the
//! classification used by TeX's CJK packages and by Typst.

/// Punctuation style. Mainland China (GB), Japan (JIS) and Taiwan (CNS)
/// place the same codepoints differently inside the em box.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PunctStyle {
    /// GB/T 15834 — mainland China. Full stop and comma sit bottom-left.
    #[default]
    Gb,
    /// JIS — Japan.
    Jis,
    /// CNS — Taiwan. Full stop and comma sit in the *center* of the em box.
    Cns,
}

/// What a single character is, for typesetting purposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CharClass {
    /// Han / Hiragana / Katakana — a full-width ideograph.
    Cjk,
    /// Full-width punctuation drawn in the *left* half of its em box, so the
    /// empty right half may be squeezed away. (。，、：；！？ and closers)
    PunctLeft,
    /// Full-width punctuation drawn in the *right* half, squeezable on the
    /// left. (（「《【 and other openers)
    PunctRight,
    /// Full-width punctuation drawn centered, squeezable on both sides. (·・)
    PunctCenter,
    /// Latin/Greek/Cyrillic letter or digit.
    Letter,
    /// Space.
    Space,
    /// U+FFFC OBJECT REPLACEMENT CHARACTER: something the text stream cannot
    /// represent, standing in for content laid out elsewhere — for us, an
    /// inline formula. It behaves like a western word for spacing purposes,
    /// which is what CLReq asks for when non-Han content meets Han.
    Object,
    /// U+2028 LINE SEPARATOR: a break the author asked for, as opposed to one
    /// the optimiser chose. Unicode defines it for exactly this.
    Break,
    /// Anything else (western punctuation, symbols).
    Other,
}

impl CharClass {
    /// Whether this is any kind of squeezable full-width CJK punctuation.
    pub fn is_cjk_punct(self) -> bool {
        matches!(self, Self::PunctLeft | Self::PunctRight | Self::PunctCenter)
    }

    /// Whether this participates in CJK-Latin auto spacing on the CJK side.
    pub fn is_cj(self) -> bool {
        matches!(self, Self::Cjk)
    }

    /// Whether this participates in CJK-Latin auto spacing on the Latin side.
    pub fn is_letter_or_number(self) -> bool {
        matches!(self, Self::Letter | Self::Object)
    }
}

/// True for Han, Hiragana and Katakana (i.e. CJ, not including Hangul, which
/// is word-spaced and behaves like Latin for our purposes).
pub fn is_cj_script(c: char) -> bool {
    matches!(c as u32,
        0x3400..=0x4DBF   // CJK Unified Ideographs Extension A
      | 0x4E00..=0x9FFF   // CJK Unified Ideographs
      | 0xF900..=0xFAFF   // CJK Compatibility Ideographs
      | 0x3040..=0x309F   // Hiragana
      | 0x30A0..=0x30FF   // Katakana
      | 0x20000..=0x2A6DF // Extension B
      | 0x2A700..=0x2EBEF // Extension C-F
      | 0x30000..=0x323AF // Extension G-H
    ) || c == '\u{30FC}' // Katakana-Hiragana prolonged sound mark
}

/// Punctuation whose glyph sits in the left half of the em box.
///
/// Note the two "ambiguous" quotes: U+2019 and U+201D are shared between
/// Latin and CJK. We treat them as CJK only when the font gives them a full
/// em of advance, which the caller signals via `full_width`.
pub fn is_left_aligned_punct(c: char, style: PunctStyle, full_width: bool) -> bool {
    if matches!(c, '\u{201D}' | '\u{2019}') && full_width {
        return true;
    }
    if matches!(style, PunctStyle::Gb | PunctStyle::Jis)
        && matches!(c, '，' | '。' | '．' | '、' | '：' | '；')
    {
        return true;
    }
    // In GB style exclamation and question marks are left aligned too; in the
    // other styles they are centered in their box and must not be squeezed.
    if style == PunctStyle::Gb && matches!(c, '？' | '！') {
        return true;
    }
    matches!(c,
        '》' | '）' | '』' | '」' | '】' | '〗' | '〕'
      | '〉' | '］' | '｝' | '｠' | '〙' | '〟')
}

/// Punctuation whose glyph sits in the right half of the em box.
pub fn is_right_aligned_punct(c: char, full_width: bool) -> bool {
    if matches!(c, '\u{201C}' | '\u{2018}') && full_width {
        return true;
    }
    matches!(c,
        '《' | '（' | '『' | '「' | '【' | '〖' | '〔'
      | '〈' | '［' | '｛' | '｟' | '〘' | '〝')
}

/// Punctuation drawn centered in its em box.
pub fn is_center_aligned_punct(c: char, style: PunctStyle) -> bool {
    if style == PunctStyle::Cns && matches!(c, '，' | '。' | '．' | '、' | '：' | '；') {
        return true;
    }
    matches!(c, '\u{30FB}' | '\u{00B7}') // Katakana middle dot, middle dot
}

/// Classify a character. `full_width` reports whether the font gives this
/// character a full em of advance (only consulted for the ambiguous quotes).
pub fn classify(c: char, style: PunctStyle, full_width: bool) -> CharClass {
    if c == ' ' || c == '\t' || c == '\u{00A0}' {
        return CharClass::Space;
    }
    if c == '\u{FFFC}' {
        return CharClass::Object;
    }
    if c == '\u{2028}' {
        return CharClass::Break;
    }
    if is_left_aligned_punct(c, style, full_width) {
        return CharClass::PunctLeft;
    }
    if is_right_aligned_punct(c, full_width) {
        return CharClass::PunctRight;
    }
    if is_center_aligned_punct(c, style) {
        return CharClass::PunctCenter;
    }
    if is_cj_script(c) {
        return CharClass::Cjk;
    }
    // Remaining CJK symbols and full-width forms behave like ideographs for
    // breaking purposes even though they are not squeezable.
    if matches!(c as u32, 0x3000..=0x303F | 0xFF00..=0xFFEF | 0xAC00..=0xD7AF) {
        return CharClass::Cjk;
    }
    if c.is_alphanumeric() {
        return CharClass::Letter;
    }
    CharClass::Other
}

// ---------------------------------------------------------------------------
// Kinsoku shori (避头尾) — line-start and line-end prohibitions.
//
// In the Knuth-Plass model these are not special cases: they are simply
// infinite penalties at the corresponding breakpoints, so the optimiser
// routes around them for free.
// ---------------------------------------------------------------------------

/// Characters that may not begin a line (不可行首). A break *before* one of
/// these is forbidden.
pub fn forbidden_at_line_start(c: char) -> bool {
    matches!(c,
        // Closing brackets and quotes
        '）' | '］' | '｝' | '〕' | '〉' | '》' | '」' | '』' | '】' | '〗' | '〙' | '〛'
      | ')' | ']' | '}' | '\u{2019}' | '\u{201D}' | '〞' | '〟'
        // Sentence-final and separating punctuation
      | '。' | '．' | '，' | '、' | '：' | '；' | '！' | '？' | '.' | ',' | ':' | ';' | '!' | '?'
      | '‼' | '⁇' | '⁈' | '⁉'
        // Marks that hang onto the preceding character
      | '·' | '・' | '～' | '〜' | '‐' | '–' | '—' | '…' | '‥' | '─'
      | 'ー' | '々' | '〻' | 'ゝ' | 'ゞ' | 'ヽ' | 'ヾ'
        // Small kana
      | 'ぁ' | 'ぃ' | 'ぅ' | 'ぇ' | 'ぉ' | 'っ' | 'ゃ' | 'ゅ' | 'ょ' | 'ゎ'
      | 'ァ' | 'ィ' | 'ゥ' | 'ェ' | 'ォ' | 'ッ' | 'ャ' | 'ュ' | 'ョ' | 'ヮ'
        // Units that must stay with their number
      | '%' | '‰' | '℃' | '°'
    )
}

/// Characters that may not end a line (不可行尾). A break *after* one of these
/// is forbidden.
pub fn forbidden_at_line_end(c: char) -> bool {
    matches!(c,
        '（' | '［' | '｛' | '〔' | '〈' | '《' | '「' | '『' | '【' | '〖' | '〘' | '〚'
      | '(' | '[' | '{' | '\u{2018}' | '\u{201C}' | '〝'
      | '$' | '￥' | '＄' | '£' | '€' | '#' | '＃'
    )
}
