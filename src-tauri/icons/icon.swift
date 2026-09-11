// The app icon, drawn with the same stack the app itself paints on.
//
//   swift src-tauri/icons/icon.swift src-tauri/icons/icon-source.png
//   npx tauri icon src-tauri/icons/icon-source.png -o src-tauri/icons
//
// A justified paragraph: words are boxes, and every line but the last is set
// to the full measure — both edges flush, which is what the line breaker is
// for. Word-granular rather than solid bars, because a paragraph is made of
// words and the line breaker's whole job is deciding where they go.
//
// The words are pills. Softer than a rounded rectangle, and they read as words
// rather than as cells in a table.
//
// Apple's geometry: an 824 art box inside a 1024 canvas, superellipse corners.
// That 100pt margin is why a native icon sits the size it does beside its
// neighbours; a full-bleed square reads a shape and a size too big.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let N: CGFloat = 1024, BODY: CGFloat = 824, EXP: CGFloat = 5
func ty(_ y: CGFloat) -> CGFloat { N - y }   // top-down y -> CoreGraphics y

let INK    = CGColor(red: 0x21/255, green: 0x1f/255, blue: 0x1d/255, alpha: 1)
let ACCENT = CGColor(red: 0xc6/255, green: 0x71/255, blue: 0x39/255, alpha: 1)
let PAPER0 = CGColor(red: 0xfe/255, green: 0xfc/255, blue: 0xf7/255, alpha: 1)
let PAPER1 = CGColor(red: 0xf2/255, green: 0xe7/255, blue: 0xd4/255, alpha: 1)

func squircle() -> CGPath {
    let p = CGMutablePath(), a = BODY/2, c = N/2, steps = 720
    for i in 0...steps {
        let t = CGFloat(i)/CGFloat(steps) * .pi * 2, ct = cos(t), st = sin(t)
        let x = c + a * (ct < 0 ? -1 : 1) * pow(abs(ct), 2/EXP)
        let y = c + a * (st < 0 ? -1 : 1) * pow(abs(st), 2/EXP)
        if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
    }
    p.closeSubpath(); return p
}

func pill(_ ctx: CGContext, _ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ c: CGColor) {
    ctx.setFillColor(c)
    ctx.addPath(CGPath(roundedRect: CGRect(x: x, y: ty(y+h), width: w, height: h),
                       cornerWidth: min(h/2, w/2), cornerHeight: h/2, transform: nil))
    ctx.fillPath()
}

let L: CGFloat = 250, R: CGFloat = 774      // the measure
let BAR_H: CGFloat = 66, LINE_H: CGFloat = 120

// Spacing here is set tight on purpose, and that is a choice with a cost worth
// writing down so nobody "corrects" it back.
//
//   Word spaces sit at 24-26 against 54 of interline air. Typographically that
//   is about right — a word space really is a fraction of the leading — and it
//   packs each row so the paragraph reads dense rather than airy. What it buys
//   in texture it spends at small sizes: 24px of 1024 is 0.75px at 32pt, so the
//   words in a row merge there and it reads as a solid rule. An earlier pass ran
//   the spaces out to 45-52 to survive that, and the paragraph went slack. This
//   is the other side of the trade, taken deliberately.
//
//   The rhythm comes from the words instead. They span 3.4x (84 to 288), and the
//   rows hold three, three, two, two — so no two rows repeat a shape. Rows all
//   carrying three middling words of the same length rhyme with each other and
//   the block goes flat; varying the count is what stops that. A row of four was
//   tried and does the opposite, since four near-equal chunks read as a grid.
//
//   The shortest word is 1.27x the line height. Below about 1.2 it stops being a
//   word and starts being a bullet.
//
// Word widths are fractions of the measure; the gaps take whatever is left, so
// each row's spaces stretch by a different amount — which is the decision the
// line breaker is making. The last row sets at the paragraph's tightest space
// and stops short, at 73% of the measure: unstretched, which is the shape a
// paragraph actually has.
let ROWS: [[CGFloat]] = [[0.31, 0.44, 0.16],   // medium · long · short
                         [0.22, 0.44, 0.25],   // short · long · medium
                         [0.55, 0.40]]         // two long ones
let LAST: [CGFloat] = [0.28, 0.41]

let space = CGColorSpaceCreateDeviceRGB()
guard CommandLine.arguments.count > 1 else { fatalError("usage: icon.swift <out.png>") }
guard let ctx = CGContext(data: nil, width: Int(N), height: Int(N), bitsPerComponent: 8,
                          bytesPerRow: 0, space: space,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    fatalError("could not create the context")
}
ctx.setShouldAntialias(true)
ctx.addPath(squircle()); ctx.clip()
if let g = CGGradient(colorsSpace: space, colors: [PAPER0, PAPER1] as CFArray, locations: [0, 1]) {
    ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: ty(100)), end: CGPoint(x: 0, y: ty(924)),
                           options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
}

let M = R - L
var natural = CGFloat.greatestFiniteMagnitude
for row in ROWS { natural = min(natural, (M - row.reduce(0, +) * M) / CGFloat(row.count - 1)) }
let top = 512 - (CGFloat(ROWS.count) * LINE_H + BAR_H) / 2
for (i, row) in (ROWS + [LAST]).enumerated() {
    let isLast = i == ROWS.count
    let ink = row.reduce(0, +) * M
    let gap = isLast ? natural : (M - ink) / CGFloat(row.count - 1)
    var x = L
    for w in row {
        let ww = w * M
        pill(ctx, x, top + CGFloat(i) * LINE_H, ww, BAR_H, i == 0 ? ACCENT : INK)
        x += ww + gap
    }
}

let out = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil)
else { fatalError("could not write \(out.path)") }
CGImageDestinationAddImage(dest, image, nil)
CGImageDestinationFinalize(dest)
print("wrote \(out.path)")
