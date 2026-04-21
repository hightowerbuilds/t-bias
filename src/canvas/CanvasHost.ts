import {
  type CanvasDocument,
  type CanvasNode,
  type CanvasEdge,
  type CanvasStroke,
  type CanvasLabel,
  emptyCanvasDocument,
} from "./CanvasData";

export type CanvasTool = "select" | "lasso" | "rectangle" | "connect" | "pan" | "marker" | "text";

type Mode =
  | "idle"
  | "panning"
  | "dragging-node"
  | "creating-node"
  | "connecting"
  | "resizing-node"
  | "drawing"
  | "lassoing"
  | "dragging-label"
  | "editing-text";

type ResizeHandle = "nw" | "ne" | "sw" | "se";

const MIN_NODE_W = 60;
const MIN_NODE_H = 40;
const EDGE_HIT_DIST = 10;
const GRID_SPACING = 20;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 5.0;
const NODE_FILL = "#1e1e2e";
const NODE_STROKE = "#444";
const NODE_SELECTED_STROKE = "#5b8aff";
const NODE_TEXT = "#cdd6f4";
const EDGE_COLOR = "#585b70";
const GRID_DOT = "#313244";
const BG = "#11111b";
const MARKER_COLOR = "#f5f5dc"; // beige
const MARKER_WIDTH = 3;

export interface CanvasHostOptions {
  background?: string;
}

export class CanvasHost {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;

  private doc: CanvasDocument;
  private mode: Mode = "idle";
  private activeTool: CanvasTool = "select";
  private selectedNodeId: string | null = null;
  private hoveredNodeId: string | null = null;
  private drawQueued = false;
  private spaceHeld = false;
  private background: string;
  private resizeHandle: ResizeHandle | null = null;
  private resizeOrigRect = { x: 0, y: 0, w: 0, h: 0 };
  private activeStroke: CanvasStroke | null = null;
  private selectedStrokeId: string | null = null;
  private selectedStrokeIds: Set<string> = new Set();
  private selectedLabelId: string | null = null;
  private lassoOriginX = 0;
  private lassoOriginY = 0;
  private lassoEndX = 0;
  private lassoEndY = 0;

  // Drag state
  private dragStartX = 0;
  private dragStartY = 0;
  private dragNodeOffX = 0;
  private dragNodeOffY = 0;
  private createOriginX = 0;
  private createOriginY = 0;
  private connectFromId: string | null = null;
  private connectEndX = 0;
  private connectEndY = 0;

  onDocumentChange?: () => void;
  onToolChange?: (tool: CanvasTool) => void;
  /** Fired when user double-clicks a node. Parent should show a text input overlay. */
  onEditRequest?: (nodeId: string, screenRect: { x: number; y: number; w: number; h: number }, currentText: string) => void;
  /** Fired when user clicks with the text tool. Parent should show a text input at this screen position. */
  onTextPlaceRequest?: (screenX: number, screenY: number, worldX: number, worldY: number) => void;
  /** Fired when user double-clicks a label to edit it. */
  onLabelEditRequest?: (labelId: string, screenX: number, screenY: number, currentText: string) => void;

  get tool(): CanvasTool { return this.activeTool; }

  setTool(tool: CanvasTool) {
    this.activeTool = tool;
    this.updateCursor();
    this.onToolChange?.(tool);
  }

  private updateCursor() {
    if (this.spaceHeld || this.activeTool === "pan") {
      this.canvas.style.cursor = "grab";
    } else if (this.activeTool === "rectangle" || this.activeTool === "connect") {
      this.canvas.style.cursor = "crosshair";
    } else if (this.activeTool === "lasso") {
      this.canvas.style.cursor = "crosshair";
    } else if (this.activeTool === "marker") {
      this.canvas.style.cursor = "crosshair";
    } else if (this.activeTool === "text") {
      this.canvas.style.cursor = "text";
    } else {
      this.canvas.style.cursor = this.hoveredNodeId ? "move" : "default";
    }
  }

  constructor(canvas: HTMLCanvasElement, options: CanvasHostOptions = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.background = options.background ?? BG;
    this.doc = emptyCanvasDocument();
    this.dpr = window.devicePixelRatio || 1;

    canvas.addEventListener("mousedown", this.onMouseDown);
    canvas.addEventListener("mousemove", this.onMouseMove);
    canvas.addEventListener("mouseup", this.onMouseUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("keydown", this.onKeyDown);
    canvas.addEventListener("keyup", this.onKeyUp);
    canvas.addEventListener("dblclick", this.onDblClick);

    this.fit();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  fit() {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;
    this.dpr = window.devicePixelRatio || 1;
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.ceil(this.w * this.dpr);
    this.canvas.height = Math.ceil(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.scheduleDraw();
  }

  focus() {
    this.canvas.focus();
  }

  dispose() {
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    this.canvas.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("mouseup", this.onMouseUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("keydown", this.onKeyDown);
    this.canvas.removeEventListener("keyup", this.onKeyUp);
    this.canvas.removeEventListener("dblclick", this.onDblClick);
  }

  getDocument(): CanvasDocument {
    return this.doc;
  }

  setDocument(doc: CanvasDocument) {
    this.doc = doc;
    this.selectedNodeId = null;
    this.mode = "idle";
    this.scheduleDraw();
  }

  // ---------------------------------------------------------------------------
  // Coordinate transforms
  // ---------------------------------------------------------------------------

  private worldToScreenX(wx: number): number {
    return (wx + this.doc.viewport.panX) * this.doc.viewport.zoom;
  }

  private worldToScreenY(wy: number): number {
    return (wy + this.doc.viewport.panY) * this.doc.viewport.zoom;
  }

  private screenToWorldX(sx: number): number {
    return sx / this.doc.viewport.zoom - this.doc.viewport.panX;
  }

  private screenToWorldY(sy: number): number {
    return sy / this.doc.viewport.zoom - this.doc.viewport.panY;
  }

  // ---------------------------------------------------------------------------
  // Hit testing
  // ---------------------------------------------------------------------------

  private hitTestNode(wx: number, wy: number): CanvasNode | null {
    for (let i = this.doc.nodes.length - 1; i >= 0; i--) {
      const n = this.doc.nodes[i];
      if (wx >= n.x && wx <= n.x + n.width && wy >= n.y && wy <= n.y + n.height) {
        return n;
      }
    }
    return null;
  }

  private isNearNodeBorder(wx: number, wy: number, node: CanvasNode): boolean {
    const d = EDGE_HIT_DIST / this.doc.viewport.zoom;
    const inside =
      wx >= node.x && wx <= node.x + node.width &&
      wy >= node.y && wy <= node.y + node.height;
    if (!inside) return false;
    const innerX = wx > node.x + d && wx < node.x + node.width - d;
    const innerY = wy > node.y + d && wy < node.y + node.height - d;
    return !(innerX && innerY);
  }

  /** Check if a world-space point is near a text label. */
  private hitTestLabel(wx: number, wy: number): CanvasLabel | null {
    const labels = this.doc.labels || [];
    const fontSize = 14;
    for (let i = labels.length - 1; i >= 0; i--) {
      const l = labels[i];
      // Approximate label bounds: width from text length, height from font size
      const approxW = l.text.length * fontSize * 0.6;
      const approxH = fontSize * 1.4;
      if (wx >= l.x - 4 && wx <= l.x + approxW + 4 && wy >= l.y - approxH && wy <= l.y + 4) {
        return l;
      }
    }
    return null;
  }

  /** Check if a world-space point is over a resize handle of the selected node. */
  /** Check if a world-space point is near any stroke. Returns stroke id or null. */
  private hitTestStroke(wx: number, wy: number): string | null {
    const threshold = 8 / this.doc.viewport.zoom;
    const strokes = this.doc.strokes || [];
    for (let i = strokes.length - 1; i >= 0; i--) {
      const stroke = strokes[i];
      for (let j = 1; j < stroke.points.length; j++) {
        const a = stroke.points[j - 1];
        const b = stroke.points[j];
        if (this.pointToSegmentDist(wx, wy, a.x, a.y, b.x, b.y) < threshold) {
          return stroke.id;
        }
      }
    }
    return null;
  }

  private pointToSegmentDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  private hitResizeHandle(wx: number, wy: number): ResizeHandle | null {
    if (!this.selectedNodeId) return null;
    const node = this.doc.nodes.find((n) => n.id === this.selectedNodeId);
    if (!node) return null;
    const hs = 6 / this.doc.viewport.zoom; // handle half-size in world space
    const corners: [number, number, ResizeHandle][] = [
      [node.x, node.y, "nw"],
      [node.x + node.width, node.y, "ne"],
      [node.x, node.y + node.height, "sw"],
      [node.x + node.width, node.y + node.height, "se"],
    ];
    for (const [cx, cy, handle] of corners) {
      if (Math.abs(wx - cx) <= hs && Math.abs(wy - cy) <= hs) return handle;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Input handlers
  // ---------------------------------------------------------------------------

  private onMouseDown = (e: MouseEvent) => {
    e.stopPropagation();
    this.canvas.focus();
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wx = this.screenToWorldX(sx);
    const wy = this.screenToWorldY(sy);

    // Middle-click or space+click or pan tool → pan
    if (e.button === 1 || (e.button === 0 && (this.spaceHeld || this.activeTool === "pan"))) {
      this.mode = "panning";
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      this.canvas.style.cursor = "grabbing";
      return;
    }

    if (e.button !== 0) return;

    // Check resize handles first (any tool can resize when a node is selected)
    const handle = this.hitResizeHandle(wx, wy);
    if (handle) {
      const node = this.doc.nodes.find((n) => n.id === this.selectedNodeId)!;
      this.mode = "resizing-node";
      this.resizeHandle = handle;
      this.resizeOrigRect = { x: node.x, y: node.y, w: node.width, h: node.height };
      this.dragStartX = wx;
      this.dragStartY = wy;
      return;
    }

    // Tool-specific behavior
    if (this.activeTool === "rectangle") {
      this.selectedNodeId = null;
      this.mode = "creating-node";
      this.createOriginX = wx;
      this.createOriginY = wy;
      this.connectEndX = wx;
      this.connectEndY = wy;
      this.scheduleDraw();
      return;
    }

    if (this.activeTool === "lasso") {
      this.mode = "lassoing";
      this.lassoOriginX = wx;
      this.lassoOriginY = wy;
      this.lassoEndX = wx;
      this.lassoEndY = wy;
      this.selectedStrokeIds.clear();
      this.selectedStrokeId = null;
      this.selectedNodeId = null;
      this.scheduleDraw();
      return;
    }

    if (this.activeTool === "text") {
      this.onTextPlaceRequest?.(sx, sy, wx, wy);
      return;
    }

    if (this.activeTool === "marker") {
      this.mode = "drawing";
      this.activeStroke = {
        id: crypto.randomUUID(),
        points: [{ x: wx, y: wy }],
      };
      this.scheduleDraw();
      return;
    }

    if (this.activeTool === "connect") {
      const hitNode = this.hitTestNode(wx, wy);
      if (hitNode) {
        this.mode = "connecting";
        this.connectFromId = hitNode.id;
        this.connectEndX = wx;
        this.connectEndY = wy;
      }
      return;
    }

    // Select tool (default)
    const hitNode = this.hitTestNode(wx, wy);
    if (hitNode) {
      this.selectedNodeId = hitNode.id;
      this.selectedStrokeId = null;
      this.mode = "dragging-node";
      this.dragNodeOffX = wx - hitNode.x;
      this.dragNodeOffY = wy - hitNode.y;
      this.scheduleDraw();
      return;
    }

    // Check if clicking a label → select + start drag
    const hitLabel = this.hitTestLabel(wx, wy);
    if (hitLabel) {
      this.selectedLabelId = hitLabel.id;
      this.selectedNodeId = null;
      this.selectedStrokeId = null;
      this.mode = "dragging-label";
      this.dragNodeOffX = wx - hitLabel.x;
      this.dragNodeOffY = wy - hitLabel.y;
      this.scheduleDraw();
      return;
    }

    // Check if clicking a stroke
    const hitStroke = this.hitTestStroke(wx, wy);
    if (hitStroke) {
      this.selectedStrokeId = hitStroke;
      this.selectedNodeId = null;
      this.selectedLabelId = null;
      this.scheduleDraw();
      return;
    }

    // Click empty area → deselect all
    this.selectedNodeId = null;
    this.selectedStrokeId = null;
    this.selectedLabelId = null;
    this.scheduleDraw();
  };

  private onMouseMove = (e: MouseEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wx = this.screenToWorldX(sx);
    const wy = this.screenToWorldY(sy);

    if (this.mode === "panning") {
      const dx = e.clientX - this.dragStartX;
      const dy = e.clientY - this.dragStartY;
      this.doc.viewport.panX += dx / this.doc.viewport.zoom;
      this.doc.viewport.panY += dy / this.doc.viewport.zoom;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      this.scheduleDraw();
      return;
    }

    if (this.mode === "dragging-node") {
      const node = this.doc.nodes.find((n) => n.id === this.selectedNodeId);
      if (node) {
        node.x = wx - this.dragNodeOffX;
        node.y = wy - this.dragNodeOffY;
        this.scheduleDraw();
      }
      return;
    }

    if (this.mode === "dragging-label") {
      const label = (this.doc.labels || []).find((l) => l.id === this.selectedLabelId);
      if (label) {
        label.x = wx - this.dragNodeOffX;
        label.y = wy - this.dragNodeOffY;
        this.scheduleDraw();
      }
      return;
    }

    if (this.mode === "lassoing") {
      this.lassoEndX = wx;
      this.lassoEndY = wy;
      this.scheduleDraw();
      return;
    }

    if (this.mode === "drawing" && this.activeStroke) {
      this.activeStroke.points.push({ x: wx, y: wy });
      this.scheduleDraw();
      return;
    }

    if (this.mode === "creating-node") {
      this.connectEndX = wx;
      this.connectEndY = wy;
      this.scheduleDraw();
      return;
    }

    if (this.mode === "connecting") {
      this.connectEndX = wx;
      this.connectEndY = wy;
      this.scheduleDraw();
      return;
    }

    if (this.mode === "resizing-node") {
      const node = this.doc.nodes.find((n) => n.id === this.selectedNodeId);
      if (node) {
        const dx = wx - this.dragStartX;
        const dy = wy - this.dragStartY;
        const o = this.resizeOrigRect;
        switch (this.resizeHandle) {
          case "se":
            node.width = Math.max(MIN_NODE_W, o.w + dx);
            node.height = Math.max(MIN_NODE_H, o.h + dy);
            break;
          case "sw":
            node.x = Math.min(o.x + o.w - MIN_NODE_W, o.x + dx);
            node.width = Math.max(MIN_NODE_W, o.w - dx);
            node.height = Math.max(MIN_NODE_H, o.h + dy);
            break;
          case "ne":
            node.width = Math.max(MIN_NODE_W, o.w + dx);
            node.y = Math.min(o.y + o.h - MIN_NODE_H, o.y + dy);
            node.height = Math.max(MIN_NODE_H, o.h - dy);
            break;
          case "nw":
            node.x = Math.min(o.x + o.w - MIN_NODE_W, o.x + dx);
            node.width = Math.max(MIN_NODE_W, o.w - dx);
            node.y = Math.min(o.y + o.h - MIN_NODE_H, o.y + dy);
            node.height = Math.max(MIN_NODE_H, o.h - dy);
            break;
        }
        this.scheduleDraw();
      }
      return;
    }

    // Hover detection — update cursor based on context
    const resHandle = this.hitResizeHandle(wx, wy);
    if (resHandle) {
      this.canvas.style.cursor = resHandle === "nw" || resHandle === "se" ? "nwse-resize" : "nesw-resize";
      return;
    }
    const hit = this.hitTestNode(wx, wy);
    const newHover = hit?.id ?? null;
    if (newHover !== this.hoveredNodeId) {
      this.hoveredNodeId = newHover;
      this.scheduleDraw();
    }
    this.updateCursor();
  };

  private onMouseUp = (e: MouseEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wx = this.screenToWorldX(sx);
    const wy = this.screenToWorldY(sy);

    if (this.mode === "creating-node") {
      const x = Math.min(this.createOriginX, wx);
      const y = Math.min(this.createOriginY, wy);
      const w = Math.abs(wx - this.createOriginX);
      const h = Math.abs(wy - this.createOriginY);
      if (w >= MIN_NODE_W / 2 && h >= MIN_NODE_H / 2) {
        const node: CanvasNode = {
          id: crypto.randomUUID(),
          x,
          y,
          width: Math.max(w, MIN_NODE_W),
          height: Math.max(h, MIN_NODE_H),
          text: "",
        };
        this.doc.nodes.push(node);
        this.selectedNodeId = node.id;
        this.notifyChange();
      }
    }

    if (this.mode === "lassoing") {
      const lx = Math.min(this.lassoOriginX, this.lassoEndX);
      const ly = Math.min(this.lassoOriginY, this.lassoEndY);
      const lw = Math.abs(this.lassoEndX - this.lassoOriginX);
      const lh = Math.abs(this.lassoEndY - this.lassoOriginY);

      this.selectedStrokeIds.clear();
      this.selectedNodeId = null;
      if (lw > 2 && lh > 2) {
        for (const stroke of (this.doc.strokes || [])) {
          for (const p of stroke.points) {
            if (p.x >= lx && p.x <= lx + lw && p.y >= ly && p.y <= ly + lh) {
              this.selectedStrokeIds.add(stroke.id);
              break;
            }
          }
        }
      }
    }

    if (this.mode === "drawing" && this.activeStroke) {
      if (this.activeStroke.points.length > 1) {
        if (!this.doc.strokes) this.doc.strokes = [];
        this.doc.strokes.push(this.activeStroke);
        this.notifyChange();
      }
      this.activeStroke = null;
    }

    if (this.mode === "connecting") {
      const targetNode = this.hitTestNode(wx, wy);
      if (targetNode && targetNode.id !== this.connectFromId && this.connectFromId) {
        const alreadyConnected = this.doc.edges.some(
          (e) =>
            (e.fromNodeId === this.connectFromId && e.toNodeId === targetNode.id) ||
            (e.fromNodeId === targetNode.id && e.toNodeId === this.connectFromId),
        );
        if (!alreadyConnected) {
          this.doc.edges.push({
            id: crypto.randomUUID(),
            fromNodeId: this.connectFromId,
            toNodeId: targetNode.id,
          });
          this.notifyChange();
        }
      }
    }

    if (this.mode === "dragging-node" || this.mode === "resizing-node" || this.mode === "dragging-label") {
      this.notifyChange();
    }

    this.mode = "idle";
    this.resizeHandle = null;
    this.connectFromId = null;
    this.updateCursor();
    this.scheduleDraw();
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // Zoom toward cursor
    const oldZoom = this.doc.viewport.zoom;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, oldZoom * delta));

    // Adjust pan so the world point under the cursor stays fixed
    const wx = sx / oldZoom - this.doc.viewport.panX;
    const wy = sy / oldZoom - this.doc.viewport.panY;
    this.doc.viewport.panX = sx / newZoom - wx;
    this.doc.viewport.panY = sy / newZoom - wy;
    this.doc.viewport.zoom = newZoom;

    this.scheduleDraw();
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === " ") {
      e.preventDefault();
      this.spaceHeld = true;
      this.canvas.style.cursor = "grab";
      return;
    }
    if (e.key === " " && e.type === "keyup") {
      this.spaceHeld = false;
      this.canvas.style.cursor = "crosshair";
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && this.mode !== "editing-text") {
      if (this.selectedNodeId) {
        e.preventDefault();
        this.doc.edges = this.doc.edges.filter(
          (edge) => edge.fromNodeId !== this.selectedNodeId && edge.toNodeId !== this.selectedNodeId,
        );
        this.doc.nodes = this.doc.nodes.filter((n) => n.id !== this.selectedNodeId);
        this.selectedNodeId = null;
        this.notifyChange();
        this.scheduleDraw();
      } else if (this.selectedStrokeId) {
        e.preventDefault();
        this.doc.strokes = (this.doc.strokes || []).filter((s) => s.id !== this.selectedStrokeId);
        this.selectedStrokeId = null;
        this.notifyChange();
        this.scheduleDraw();
      } else if (this.selectedLabelId) {
        e.preventDefault();
        this.doc.labels = (this.doc.labels || []).filter((l) => l.id !== this.selectedLabelId);
        this.selectedLabelId = null;
        this.notifyChange();
        this.scheduleDraw();
      } else if (this.selectedStrokeIds.size > 0) {
        e.preventDefault();
        this.doc.strokes = (this.doc.strokes || []).filter((s) => !this.selectedStrokeIds.has(s.id));
        this.selectedStrokeIds.clear();
        this.notifyChange();
        this.scheduleDraw();
      }
    }
  };

  private onDblClick = (e: MouseEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wx = this.screenToWorldX(sx);
    const wy = this.screenToWorldY(sy);

    // Double-click label → edit
    const label = this.hitTestLabel(wx, wy);
    if (label) {
      this.selectedLabelId = label.id;
      this.mode = "editing-text";
      this.onLabelEditRequest?.(label.id, this.worldToScreenX(label.x), this.worldToScreenY(label.y), label.text);
      return;
    }

    // Double-click node → edit
    const node = this.hitTestNode(wx, wy);
    if (node) {
      this.requestTextEdit(node);
    }
  };

  // Also listen for keyup on window to catch space release
  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key === " ") {
      this.spaceHeld = false;
      this.canvas.style.cursor = this.hoveredNodeId ? "move" : "crosshair";
    }
  };

  // ---------------------------------------------------------------------------
  // Text editing — delegated to parent component via onEditRequest callback
  // ---------------------------------------------------------------------------

  private requestTextEdit(node: CanvasNode) {
    this.mode = "editing-text";
    this.selectedNodeId = node.id;
    const zoom = this.doc.viewport.zoom;
    this.onEditRequest?.(node.id, {
      x: this.worldToScreenX(node.x),
      y: this.worldToScreenY(node.y),
      w: node.width * zoom,
      h: node.height * zoom,
    }, node.text);
    this.scheduleDraw();
  }

  /** Called by the parent component when the user finishes editing text. */
  commitEdit(nodeId: string, text: string) {
    const node = this.doc.nodes.find((n) => n.id === nodeId);
    if (node) {
      node.text = text;
      this.notifyChange();
    }
    this.mode = "idle";
    this.scheduleDraw();
    this.canvas.focus();
  }

  /** Called by the parent to add a new text label at world coordinates. */
  addLabel(worldX: number, worldY: number, text: string) {
    if (!text.trim()) return;
    if (!this.doc.labels) this.doc.labels = [];
    this.doc.labels.push({
      id: crypto.randomUUID(),
      x: worldX,
      y: worldY,
      text: text.trim(),
    });
    this.notifyChange();
    this.scheduleDraw();
  }

  /** Called by the parent to update an existing label's text. */
  updateLabel(labelId: string, text: string) {
    const labels = this.doc.labels || [];
    const label = labels.find((l) => l.id === labelId);
    if (label) {
      if (!text.trim()) {
        this.doc.labels = labels.filter((l) => l.id !== labelId);
      } else {
        label.text = text.trim();
      }
      this.notifyChange();
      this.scheduleDraw();
    }
    this.mode = "idle";
    this.canvas.focus();
  }

  /** Called by the parent if the user cancels editing. */
  cancelEdit() {
    this.mode = "idle";
    this.scheduleDraw();
    this.canvas.focus();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private scheduleDraw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  private draw() {
    const { ctx, w, h, dpr } = this;
    const { panX, panY, zoom } = this.doc.viewport;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(panX * zoom, panY * zoom);
    ctx.scale(zoom, zoom);

    this.drawGrid();
    this.drawStrokes();
    this.drawLabels();
    this.drawLassoPreview();
    this.drawEdges();
    this.drawCreationPreview();
    this.drawConnectionPreview();
    this.drawNodes();

    ctx.restore();
  }

  private drawStrokes() {
    const { ctx } = this;
    const allStrokes = [...(this.doc.strokes || [])];
    if (this.activeStroke) allStrokes.push(this.activeStroke);
    if (allStrokes.length === 0) return;

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const stroke of allStrokes) {
      if (stroke.points.length < 2) continue;
      const selected = stroke.id === this.selectedStrokeId || this.selectedStrokeIds.has(stroke.id);
      ctx.strokeStyle = selected ? "#5b8aff" : MARKER_COLOR;
      ctx.lineWidth = (selected ? MARKER_WIDTH + 1 : MARKER_WIDTH) / this.doc.viewport.zoom;
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      ctx.stroke();
    }
  }

  private drawGrid() {
    const { ctx, w, h } = this;
    const { panX, panY, zoom } = this.doc.viewport;
    if (zoom < 0.2) return;

    const spacing = zoom < 0.5 ? GRID_SPACING * 5 : GRID_SPACING;
    const worldLeft = -panX;
    const worldTop = -panY;
    const worldRight = worldLeft + w / zoom;
    const worldBottom = worldTop + h / zoom;

    const startX = Math.floor(worldLeft / spacing) * spacing;
    const startY = Math.floor(worldTop / spacing) * spacing;

    ctx.fillStyle = GRID_DOT;
    const dotSize = 1.5 / zoom;
    for (let x = startX; x <= worldRight; x += spacing) {
      for (let y = startY; y <= worldBottom; y += spacing) {
        ctx.fillRect(x - dotSize / 2, y - dotSize / 2, dotSize, dotSize);
      }
    }
  }

  private drawEdges() {
    const { ctx } = this;
    const nodeMap = new Map(this.doc.nodes.map((n) => [n.id, n]));

    ctx.strokeStyle = EDGE_COLOR;
    ctx.lineWidth = 1.5 / this.doc.viewport.zoom;

    for (const edge of this.doc.edges) {
      const from = nodeMap.get(edge.fromNodeId);
      const to = nodeMap.get(edge.toNodeId);
      if (!from || !to) continue;

      const fx = from.x + from.width / 2;
      const fy = from.y + from.height / 2;
      const tx = to.x + to.width / 2;
      const ty = to.y + to.height / 2;

      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }
  }

  private drawNodes() {
    const { ctx } = this;
    const fontSize = 12;

    for (const node of this.doc.nodes) {
      const selected = node.id === this.selectedNodeId;
      const hovered = node.id === this.hoveredNodeId;

      // Fill
      ctx.fillStyle = NODE_FILL;
      ctx.fillRect(node.x, node.y, node.width, node.height);

      // Border
      ctx.strokeStyle = selected ? NODE_SELECTED_STROKE : hovered ? "#666" : NODE_STROKE;
      ctx.lineWidth = (selected ? 2 : 1) / this.doc.viewport.zoom;
      ctx.strokeRect(node.x, node.y, node.width, node.height);

      // Text
      if (node.text && !(this.mode === "editing-text" && node.id === this.selectedNodeId)) {
        ctx.fillStyle = NODE_TEXT;
        ctx.font = `${fontSize}px monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        ctx.save();
        ctx.beginPath();
        ctx.rect(node.x + 4, node.y + 4, node.width - 8, node.height - 8);
        ctx.clip();
        ctx.fillText(node.text, node.x + node.width / 2, node.y + node.height / 2);
        ctx.restore();
      }

      // Resize handles on selected node
      if (selected) {
        const hs = 4 / this.doc.viewport.zoom;
        ctx.fillStyle = NODE_SELECTED_STROKE;
        const corners = [
          [node.x, node.y],
          [node.x + node.width, node.y],
          [node.x, node.y + node.height],
          [node.x + node.width, node.y + node.height],
        ];
        for (const [cx, cy] of corners) {
          ctx.fillRect(cx - hs, cy - hs, hs * 2, hs * 2);
        }
      }
    }
  }

  private drawLabels() {
    const labels = this.doc.labels || [];
    if (labels.length === 0) return;
    const { ctx } = this;
    const fontSize = 14;
    ctx.font = `${fontSize}px monospace`;
    ctx.textBaseline = "bottom";

    for (const label of labels) {
      if (this.mode === "editing-text" && label.id === this.selectedLabelId) continue;
      const selected = label.id === this.selectedLabelId;
      ctx.fillStyle = selected ? "#5b8aff" : "#cdd6f4";
      ctx.fillText(label.text, label.x, label.y);

      if (selected) {
        const w = ctx.measureText(label.text).width;
        ctx.strokeStyle = "#5b8aff";
        ctx.lineWidth = 1 / this.doc.viewport.zoom;
        ctx.setLineDash([4 / this.doc.viewport.zoom]);
        ctx.strokeRect(label.x - 2, label.y - fontSize - 2, w + 4, fontSize + 4);
        ctx.setLineDash([]);
      }
    }
  }

  private drawLassoPreview() {
    if (this.mode !== "lassoing") return;
    const { ctx } = this;
    const x = Math.min(this.lassoOriginX, this.lassoEndX);
    const y = Math.min(this.lassoOriginY, this.lassoEndY);
    const w = Math.abs(this.lassoEndX - this.lassoOriginX);
    const h = Math.abs(this.lassoEndY - this.lassoOriginY);

    ctx.strokeStyle = "#5b8aff";
    ctx.lineWidth = 1 / this.doc.viewport.zoom;
    ctx.setLineDash([6 / this.doc.viewport.zoom]);
    ctx.fillStyle = "rgba(91, 138, 255, 0.08)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  private drawCreationPreview() {
    if (this.mode !== "creating-node") return;
    const { ctx } = this;
    const x = Math.min(this.createOriginX, this.connectEndX);
    const y = Math.min(this.createOriginY, this.connectEndY);
    const w = Math.abs(this.connectEndX - this.createOriginX);
    const h = Math.abs(this.connectEndY - this.createOriginY);

    ctx.strokeStyle = NODE_SELECTED_STROKE;
    ctx.lineWidth = 1 / this.doc.viewport.zoom;
    ctx.setLineDash([4 / this.doc.viewport.zoom]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  private drawConnectionPreview() {
    if (this.mode !== "connecting" || !this.connectFromId) return;
    const { ctx } = this;
    const from = this.doc.nodes.find((n) => n.id === this.connectFromId);
    if (!from) return;

    const fx = from.x + from.width / 2;
    const fy = from.y + from.height / 2;

    ctx.strokeStyle = NODE_SELECTED_STROKE;
    ctx.lineWidth = 1.5 / this.doc.viewport.zoom;
    ctx.setLineDash([6 / this.doc.viewport.zoom]);
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(this.connectEndX, this.connectEndY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private notifyChange() {
    this.onDocumentChange?.();
  }
}
