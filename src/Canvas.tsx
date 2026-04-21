import { onMount, onCleanup, createEffect, createSignal, For, Show, type Component } from "solid-js";
import { CanvasHost, type CanvasTool } from "./canvas/CanvasHost";
import type { CanvasDocument } from "./canvas/CanvasData";
import { emptyCanvasDocument } from "./canvas/CanvasData";
import type { AppConfig } from "./ipc/types";

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

interface CanvasEntry {
  id: string;
  name: string;
}

function loadCanvasList(): CanvasEntry[] {
  try { return JSON.parse(localStorage.getItem("canvas-list") ?? "[]"); } catch { return []; }
}

function saveCanvasList(list: CanvasEntry[]) {
  localStorage.setItem("canvas-list", JSON.stringify(list));
}

function loadCanvasDoc(id: string): CanvasDocument {
  try { return JSON.parse(localStorage.getItem(`canvas-doc-${id}`) ?? "null") ?? emptyCanvasDocument(); }
  catch { return emptyCanvasDocument(); }
}

function saveCanvasDoc(id: string, doc: CanvasDocument) {
  localStorage.setItem(`canvas-doc-${id}`, JSON.stringify(doc));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface CanvasModalProps {
  config: AppConfig;
  isActive: boolean;
  onClose: () => void;
}

const TOOLBAR_H = 36;
const FOOTER_H = 40;

const toolDefs: { id: CanvasTool; label: string; shortcut: string }[] = [
  { id: "select",    label: "Select",    shortcut: "V" },
  { id: "rectangle", label: "Rectangle", shortcut: "R" },
  { id: "connect",   label: "Connect",   shortcut: "L" },
  { id: "pan",       label: "Pan",       shortcut: "H" },
];

const CanvasModal: Component<CanvasModalProps> = (props) => {
  let canvasRef!: HTMLCanvasElement;
  let nameInputRef!: HTMLInputElement;
  let host: CanvasHost | undefined;

  const [activeTool, setActiveTool] = createSignal<CanvasTool>("select");
  const [canvasList, setCanvasList] = createSignal<CanvasEntry[]>(loadCanvasList());
  const [activeId, setActiveId] = createSignal<string | null>(null);
  const [activeCanvasName, setActiveCanvasName] = createSignal("Untitled");
  const [editingName, setEditingName] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [savingNew, setSavingNew] = createSignal(false);
  let saveNameInputRef!: HTMLInputElement;

  // Inline text editing state (rendered in JSX for proper browser input support)
  const [editNode, setEditNode] = createSignal<{
    nodeId: string;
    rect: { x: number; y: number; w: number; h: number };
    text: string;
  } | null>(null);
  let editTextRef!: HTMLTextAreaElement;

  onMount(() => {
    host = new CanvasHost(canvasRef, {
      background: props.config.theme.background,
    });
    host.onToolChange = (t) => setActiveTool(t);
    host.onDocumentChange = () => setDirty(true);
    host.onEditRequest = (nodeId, rect, text) => {
      setEditNode({ nodeId, rect, text });
      requestAnimationFrame(() => {
        editTextRef?.focus();
        editTextRef?.select();
      });
    };

    const ro = new ResizeObserver(() => host?.fit());
    const container = canvasRef.parentElement;
    if (container) ro.observe(container);

    onCleanup(() => {
      ro.disconnect();
      host?.dispose();
    });
  });

  createEffect(() => {
    if (props.isActive) host?.focus();
  });

  // ------ Tool switching ------
  const selectTool = (tool: CanvasTool) => {
    host?.setTool(tool);
    setActiveTool(tool);
  };

  // ------ Canvas management ------
  const loadCanvas = (id: string) => {
    const doc = loadCanvasDoc(id);
    host?.setDocument(doc);
    setActiveId(id);
    const entry = canvasList().find((e) => e.id === id);
    setActiveCanvasName(entry?.name ?? "Untitled");
    setDirty(false);
    setMenuOpen(false);
  };

  const newCanvas = () => {
    host?.setDocument(emptyCanvasDocument());
    setActiveId(null);
    setActiveCanvasName("Untitled");
    setDirty(false);
    setMenuOpen(false);
  };

  const saveCanvas = () => {
    if (!host) return;
    const id = activeId();

    if (!id) {
      // Show inline name input for first save
      setSavingNew(true);
      requestAnimationFrame(() => saveNameInputRef?.focus());
      return;
    }

    // Already saved — update in place
    saveCanvasDoc(id, host.getDocument());
    const name = activeCanvasName();
    const list = canvasList().filter((e) => e.id !== id);
    list.push({ id, name });
    saveCanvasList(list);
    setCanvasList(list);
    setDirty(false);
  };

  const commitNewSave = (name: string) => {
    if (!host || !name.trim()) { setSavingNew(false); return; }
    const id = crypto.randomUUID();
    setActiveId(id);
    setActiveCanvasName(name.trim());
    saveCanvasDoc(id, host.getDocument());
    const list = [...canvasList(), { id, name: name.trim() }];
    saveCanvasList(list);
    setCanvasList(list);
    setDirty(false);
    setSavingNew(false);
  };

  const startEditName = () => {
    if (!activeId()) return;
    setEditingName(true);
    requestAnimationFrame(() => nameInputRef?.focus());
  };

  const commitName = () => {
    setEditingName(false);
    const id = activeId();
    if (!id) return;
    const name = activeCanvasName();
    const list = canvasList().map((e) => e.id === id ? { ...e, name } : e);
    saveCanvasList(list);
    setCanvasList(list);
  };

  const deleteCanvas = (id: string) => {
    const list = canvasList().filter((e) => e.id !== id);
    saveCanvasList(list);
    setCanvasList(list);
    localStorage.removeItem(`canvas-doc-${id}`);
    if (activeId() === id) newCanvas();
  };

  // ------ Button style helper ------
  const btnStyle = (active = false) => ({
    background: active ? "var(--bg-tab-active)" : "none",
    border: active ? "1px solid var(--border)" : "1px solid transparent",
    color: active ? "dodgerblue" : "#aaa",
    cursor: "pointer",
    padding: "4px 12px",
    "font-size": "11px",
    "font-family": "var(--font-mono)",
    "border-radius": "3px",
  });

  const footerBtnStyle = () => ({
    background: "none",
    border: "1px solid var(--border)",
    color: "#cdd6f4",
    cursor: "pointer",
    padding: "4px 14px",
    "font-size": "11px",
    "font-family": "var(--font-mono)",
    "border-radius": "3px",
  });

  return (
    <div style={{
      display: "flex",
      "flex-direction": "column",
      width: "100%",
      height: "100%",
      "min-height": "0",
    }}>
      {/* ---- Toolbar ---- */}
      <div style={{
        height: `${TOOLBAR_H}px`,
        "flex-shrink": "0",
        display: "flex",
        "align-items": "center",
        "justify-content": "space-between",
        padding: "0 8px",
        background: "var(--bg-tab-bar)",
        "border-bottom": "1px solid var(--border)",
        "user-select": "none",
      }}>
        <div style={{ display: "flex", gap: "2px", "align-items": "center" }}>
          {toolDefs.map((t) => (
            <button onClick={() => selectTool(t.id)} title={`${t.label} (${t.shortcut})`} style={btnStyle(activeTool() === t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <button
          onClick={props.onClose}
          title="Close Canvas (Esc)"
          style={{
            background: "none",
            border: "none",
            color: "var(--text-faint)",
            cursor: "pointer",
            "font-size": "16px",
            "font-family": "var(--font-mono)",
            padding: "4px 8px",
          }}
        >���</button>
      </div>

      {/* ---- Canvas area ---- */}
      <div style={{ flex: "1", position: "relative", overflow: "hidden", "min-height": "0" }}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          style={{
            position: "absolute",
            top: "0", left: "0",
            width: "100%", height: "100%",
            display: "block",
            outline: "none",
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !editNode()) { props.onClose(); return; }
            if (e.target !== canvasRef) return;
            const key = e.key.toLowerCase();
            if (key === "v") selectTool("select");
            else if (key === "r") selectTool("rectangle");
            else if (key === "l") selectTool("connect");
            else if (key === "h") selectTool("pan");
          }}
        />

        {/* Inline text editor — rendered in JSX so paste & voice input work natively */}
        <Show when={editNode()}>
          {(en) => (
            <textarea
              ref={editTextRef}
              value={en().text}
              spellcheck={true}
              style={{
                position: "absolute",
                left: `${en().rect.x}px`,
                top: `${en().rect.y}px`,
                width: `${en().rect.w}px`,
                height: `${en().rect.h}px`,
                background: "#1e1e2e",
                color: "#cdd6f4",
                border: "2px solid #5b8aff",
                "font-family": "var(--font-mono)",
                "font-size": "12px",
                padding: "6px",
                resize: "none",
                outline: "none",
                "box-sizing": "border-box",
                "z-index": "20",
                overflow: "auto",
                "white-space": "pre-wrap",
                "word-wrap": "break-word",
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  host?.commitEdit(en().nodeId, editTextRef.value);
                  setEditNode(null);
                }
                if (e.key === "Escape") {
                  host?.cancelEdit();
                  setEditNode(null);
                }
                e.stopPropagation();
              }}
              onBlur={() => {
                // Delay so paste dialogs / voice input don't kill the editor
                setTimeout(() => {
                  if (editNode() && document.activeElement !== editTextRef) {
                    host?.commitEdit(en().nodeId, editTextRef.value);
                    setEditNode(null);
                  }
                }, 300);
              }}
            />
          )}
        </Show>
      </div>

      {/* ---- Footer ---- */}
      <div style={{
        height: `${FOOTER_H}px`,
        "flex-shrink": "0",
        display: "flex",
        "align-items": "center",
        gap: "12px",
        padding: "0 12px",
        background: "var(--bg-tab-bar)",
        "border-top": "1px solid var(--border)",
        "user-select": "none",
        position: "relative",
      }}>
        {/* Open Canvas button + popup */}
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setMenuOpen(!menuOpen())}
            style={footerBtnStyle()}
          >Open Canvas</button>

          <Show when={menuOpen()}>
            <div style={{
              position: "absolute",
              bottom: `${FOOTER_H - 4}px`,
              left: "0",
              background: "var(--bg-tab-bar)",
              border: "1px solid var(--border)",
              "border-radius": "4px",
              "min-width": "200px",
              "max-height": "300px",
              "overflow-y": "auto",
              "z-index": "50",
              "box-shadow": "0 -4px 16px rgba(0,0,0,0.5)",
            }}>
              <div
                onClick={newCanvas}
                style={{
                  padding: "8px 14px",
                  cursor: "pointer",
                  color: "#cdd6f4",
                  "font-size": "12px",
                  "font-family": "var(--font-mono)",
                  "border-bottom": "1px solid var(--border)",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-tab-active)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >+ New Canvas</div>

              <For each={canvasList()}>
                {(entry) => (
                  <div style={{
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "space-between",
                    padding: "6px 14px",
                    cursor: "pointer",
                    color: entry.id === activeId() ? "dodgerblue" : "#cdd6f4",
                    "font-size": "12px",
                    "font-family": "var(--font-mono)",
                    background: entry.id === activeId() ? "var(--bg-tab-active)" : "transparent",
                  }}
                    onClick={() => loadCanvas(entry.id)}
                    onMouseEnter={(e) => { if (entry.id !== activeId()) e.currentTarget.style.background = "var(--bg-tab-active)"; }}
                    onMouseLeave={(e) => { if (entry.id !== activeId()) e.currentTarget.style.background = "transparent"; }}
                  >
                    <span>{entry.name}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteCanvas(entry.id); }}
                      title="Delete canvas"
                      style={{
                        background: "none", border: "none",
                        color: "#aaa", cursor: "pointer",
                        "font-size": "11px", padding: "0 4px",
                        "font-family": "var(--font-mono)",
                      }}
                    >✕</button>
                  </div>
                )}
              </For>

              <Show when={canvasList().length === 0}>
                <div style={{
                  padding: "8px 14px",
                  color: "#aaa",
                  "font-size": "11px",
                  "font-family": "var(--font-mono)",
                  "font-style": "italic",
                }}>No saved canvases</div>
              </Show>
            </div>
          </Show>
        </div>

        {/* Canvas name (editable) */}
        <Show when={editingName()}>
          <input
            ref={nameInputRef}
            value={activeCanvasName()}
            onInput={(e) => setActiveCanvasName(e.currentTarget.value)}
            onBlur={commitName}
            onKeyDown={(e) => { if (e.key === "Enter") commitName(); if (e.key === "Escape") setEditingName(false); }}
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              color: "#cdd6f4",
              "font-size": "12px",
              "font-family": "var(--font-mono)",
              padding: "2px 8px",
              "border-radius": "3px",
              outline: "none",
              width: "200px",
            }}
          />
        </Show>
        <Show when={!editingName()}>
          <span
            onClick={startEditName}
            title={activeId() ? "Click to rename" : ""}
            style={{
              color: activeId() ? "dodgerblue" : "#aaa",
              "font-size": "12px",
              "font-family": "var(--font-mono)",
              cursor: activeId() ? "pointer" : "default",
              "font-style": activeId() ? "normal" : "italic",
            }}
          >{activeId() ? activeCanvasName() : "Unsaved canvas"}</span>
        </Show>

        <Show when={dirty()}>
          <span style={{ color: "#aaa", "font-size": "10px", "font-family": "var(--font-mono)" }}>●</span>
        </Show>

        <div style={{ flex: "1" }} />

        {/* Save name input (shown when saving a new canvas) */}
        <Show when={savingNew()}>
          <input
            ref={saveNameInputRef}
            placeholder="Canvas name..."
            onKeyDown={(e) => {
              if (e.key === "Enter") commitNewSave(e.currentTarget.value);
              if (e.key === "Escape") setSavingNew(false);
              e.stopPropagation();
            }}
            onBlur={(e) => commitNewSave(e.currentTarget.value)}
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              color: "#cdd6f4",
              "font-size": "12px",
              "font-family": "var(--font-mono)",
              padding: "2px 8px",
              "border-radius": "3px",
              outline: "none",
              width: "160px",
            }}
          />
        </Show>

        {/* Save button */}
        <button onClick={saveCanvas} style={footerBtnStyle()}>Save</button>
      </div>
    </div>
  );
};

export default CanvasModal;
