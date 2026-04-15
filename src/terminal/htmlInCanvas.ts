// ---------------------------------------------------------------------------
// HTML-in-Canvas feature detection
// ---------------------------------------------------------------------------
// Tests for the three entry-points we actually use from the WICG proposal.
// Enable in Chrome Canary via: chrome://flags/#canvas-draw-element

export function isHtmlInCanvasSupported(): boolean {
  try {
    const el = document.createElement("canvas");
    return (
      "layoutSubtree" in el &&
      "requestPaint" in el &&
      "onpaint" in el &&
      typeof (CanvasRenderingContext2D.prototype as any).drawElementImage === "function"
    );
  } catch {
    return false;
  }
}
