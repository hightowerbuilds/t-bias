import AppKit
import Foundation
let destination = CommandLine.arguments[1]
let manager = FileManager.default
try manager.createDirectory(atPath: destination, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        let s = CGFloat(pixels)
        let rect = NSRect(x: s * 0.05, y: s * 0.05, width: s * 0.9, height: s * 0.9)
        NSColor(calibratedRed: 0.05, green: 0.08, blue: 0.12, alpha: 1).setFill()
        NSBezierPath(roundedRect: rect, xRadius: s * 0.19, yRadius: s * 0.19).fill()
        let path = NSBezierPath()
        path.move(to: NSPoint(x: s * 0.25, y: s * 0.69))
        path.line(to: NSPoint(x: s * 0.43, y: s * 0.5))
        path.line(to: NSPoint(x: s * 0.25, y: s * 0.31))
        path.lineWidth = s * 0.075
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        NSColor(calibratedRed: 0.35, green: 0.65, blue: 1, alpha: 1).setStroke()
        path.stroke()
        let cursor = NSBezierPath(roundedRect: NSRect(x: s * 0.51, y: s * 0.30, width: s * 0.23, height: s * 0.07), xRadius: s * 0.02, yRadius: s * 0.02)
        NSColor(calibratedRed: 0.4, green: 0.9, blue: 0.65, alpha: 1).setFill()
        cursor.fill()
        NSGraphicsContext.restoreGraphicsState()
        let filename = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
        try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: destination).appendingPathComponent(filename))
    }
}
