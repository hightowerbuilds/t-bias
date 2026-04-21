export interface CanvasNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

export interface CanvasEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
}

export interface CanvasStroke {
  id: string;
  points: { x: number; y: number }[];
}

export interface CanvasLabel {
  id: string;
  x: number;
  y: number;
  text: string;
}

export interface CanvasViewport {
  panX: number;
  panY: number;
  zoom: number;
}

export interface CanvasDocument {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  strokes: CanvasStroke[];
  labels: CanvasLabel[];
  viewport: CanvasViewport;
}

export function emptyCanvasDocument(): CanvasDocument {
  return {
    nodes: [],
    edges: [],
    strokes: [],
    labels: [],
    viewport: { panX: 0, panY: 0, zoom: 1.0 },
  };
}
