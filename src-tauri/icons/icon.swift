// Draw the app icon with the same stack the app itself paints on: CoreGraphics
// for the shape, CoreText for the glyph. Apple's grid — an 824 squircle inside
// a 1024 canvas — so the icon sits the size a native one does.
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

let N: CGFloat = 1024
let BODY: CGFloat = 824          // art box
let EXP: CGFloat = 5             // superellipse exponent ~ Apple's corner
let GLYPH_FRAC: CGFloat = 0.54   // ink height as a fraction of the art box

// Top-down y (how the design was specified) -> CoreGraphics y.
func ty(_ y: CGFloat) -> CGFloat { N - y }

func squircle() -> CGPath {
    let p = CGMutablePath()
    let a = BODY / 2, c = N / 2, steps = 720
    for i in 0...steps {
        let t = CGFloat(i) / CGFloat(steps) * .pi * 2
        let ct = cos(t), st = sin(t)
        let x = c + a * (ct < 0 ? -1 : 1) * pow(abs(ct), 2 / EXP)
        let y = c + a * (st < 0 ? -1 : 1) * pow(abs(st), 2 / EXP)
        if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
    }
    p.closeSubpath()
    return p
}

let space = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(data: nil, width: Int(N), height: Int(N), bitsPerComponent: 8,
                          bytesPerRow: 0, space: space,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    fatalError("could not create the context")
}
ctx.setAllowsAntialiasing(true)
ctx.setShouldAntialias(true)

ctx.addPath(squircle())
ctx.clip()

// Paper: a warm vertical gradient, light at the head of the page.
let top = CGColor(red: 0xfe/255, green: 0xfc/255, blue: 0xf7/255, alpha: 1)
let bot = CGColor(red: 0xf2/255, green: 0xe7/255, blue: 0xd4/255, alpha: 1)
if let g = CGGradient(colorsSpace: space, colors: [top, bot] as CFArray, locations: [0, 1]) {
    ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: ty(100)),
                           end: CGPoint(x: 0, y: ty(924)), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
}

// 「文」, sized by its ink box rather than its em box so the margins read even.
let name = "Songti SC" as CFString
var probe = CTFontCreateWithName(name, 600, nil)
var ch: [UniChar] = Array("文".utf16)
var glyphs = [CGGlyph](repeating: 0, count: 1)
guard CTFontGetGlyphsForCharacters(probe, &ch, &glyphs, 1) else { fatalError("no glyph for 文") }
// The outline's own bounding box, which is the ink — not the em box, which
// would sit the character high and leave the margins uneven.
func inkBox(_ f: CTFont, _ g: CGGlyph) -> CGRect {
    guard let path = CTFontCreatePathForGlyph(f, g, nil) else { fatalError("no outline for 文") }
    return path.boundingBoxOfPath
}
var box = inkBox(probe, glyphs[0])
let target = BODY * GLYPH_FRAC
let size = 600 * target / box.height
let font = CTFontCreateWithName(name, size, nil)
guard CTFontGetGlyphsForCharacters(font, &ch, &glyphs, 1) else { fatalError("no glyph") }
box = inkBox(font, glyphs[0])

// Centre the character AND its baseline as one group, not the character alone:
// the rule is part of the mark, so hanging it below a centred glyph would sit
// the whole composition low in the frame.
let GAP: CGFloat = 30, RULE_H: CGFloat = 16
let groupH = box.height + GAP + RULE_H
let groupTop = (N - groupH) / 2          // top-down

ctx.setFillColor(CGColor(red: 0x21/255, green: 0x1f/255, blue: 0x1d/255, alpha: 1))
var at = CGPoint(x: N/2 - (box.minX + box.width/2),
                 y: ty(groupTop + box.height) - box.minY)
CTFontDrawGlyphs(font, &glyphs, &at, 1, ctx)

// The baseline the character sits on — a detail only a typesetter draws.
let ruleTop = groupTop + box.height + GAP
let rule = CGRect(x: N/2 - 232, y: ty(ruleTop + RULE_H), width: 464, height: RULE_H)
ctx.setFillColor(CGColor(red: 0xc6/255, green: 0x71/255, blue: 0x39/255, alpha: 0.85))
ctx.addPath(CGPath(roundedRect: rule, cornerWidth: RULE_H/2, cornerHeight: RULE_H/2, transform: nil))
ctx.fillPath()

guard let image = ctx.makeImage() else { fatalError("no image") }
let out = URL(fileURLWithPath: CommandLine.arguments[1])
guard let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fatalError("no destination")
}
CGImageDestinationAddImage(dest, image, nil)
CGImageDestinationFinalize(dest)
print("wrote \(out.path) — font \(String(format: "%.1f", size))pt, ink \(String(format: "%.0f", box.width))x\(String(format: "%.0f", box.height))")
