// Type augmentations for the WICG HTML-in-Canvas proposal.
// https://github.com/WICG/html-in-canvas
// Remove this file once TypeScript ships official lib.dom definitions.

interface PaintEvent extends Event {
  /** Which canvas child elements changed their visual output this cycle. */
  readonly changedElements: ReadonlyArray<Element>;
}

interface PaintEventInit extends EventInit {
  changedElements?: Element[];
}

interface ElementImage {
  readonly width: number;
  readonly height: number;
  close(): void;
}

interface HTMLCanvasElement {
  /**
   * When true, direct children of this canvas participate in layout and
   * hit-testing, and appear in the accessibility tree.  They remain visually
   * invisible until drawn with drawElementImage().
   */
  layoutSubtree: boolean;

  /**
   * Fires after intersection-observer steps when a child element's rendered
   * output changes, or when requestPaint() has been called.
   */
  onpaint: ((this: HTMLCanvasElement, ev: PaintEvent) => void) | null;

  /**
   * Schedule an onpaint event on the next rendering opportunity, even if no
   * child element has changed.
   */
  requestPaint(): void;

  /**
   * Capture a transferable snapshot of a child element.  The snapshot can be
   * sent to a Worker and drawn onto an OffscreenCanvas via drawElementImage().
   */
  captureElementImage(element: Element): ElementImage;

  /**
   * Return the CSS transform that synchronises a drawn element's visual
   * position with its layout position inside the canvas.
   */
  getElementTransform(
    element: Element | ElementImage,
    drawTransform: DOMMatrix,
  ): DOMMatrix;
}

interface CanvasRenderingContext2D {
  /**
   * Draw a child element (or a transferred ElementImage snapshot) into the
   * 2D canvas context at (dx, dy).  Returns a DOMMatrix for CSS positioning.
   */
  drawElementImage(
    element: Element | ElementImage,
    dx: number,
    dy: number,
    dw?: number,
    dh?: number,
  ): DOMMatrix;
}

interface OffscreenCanvasRenderingContext2D {
  drawElementImage(
    element: ElementImage,
    dx: number,
    dy: number,
    dw?: number,
    dh?: number,
  ): DOMMatrix;
}
