import {
  createSignal,
  For,
  Show,
  type Component,
} from "solid-js";
import type { AppConfig } from "./ipc/types";

export interface SettingsProps {
  config: AppConfig;
  onClose: () => void;
  onUpdateVteApps: (apps: string[]) => void;
}

const Settings: Component<SettingsProps> = (props) => {
  const [vteApps, setVteApps] = createSignal<string[]>([...props.config.vte_apps]);
  const [newApp, setNewApp] = createSignal("");

  const addApp = () => {
    const name = newApp().trim();
    if (!name || vteApps().includes(name)) return;
    const next = [...vteApps(), name];
    setVteApps(next);
    setNewApp("");
    props.onUpdateVteApps(next);
  };

  const removeApp = (name: string) => {
    const next = vteApps().filter((a) => a !== name);
    setVteApps(next);
    props.onUpdateVteApps(next);
  };

  return (
    <div
      style={{
        flex: "1",
        display: "flex",
        "flex-direction": "column",
        gap: "18px",
        padding: "26px",
        "min-height": "0",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "flex-start" }}>
        <div>
          <div style={{ "font-size": "14px", color: "var(--text-muted)" }}>t-bias</div>
          <div style={{ "font-size": "18px", color: "var(--text-bright)", "margin-top": "8px" }}>Settings</div>
        </div>
        <button class="btn btn-secondary" style={{ padding: "9px 14px" }} onClick={props.onClose}>
          Close
        </button>
      </div>

      {/* VTE Apps Section */}
      <div style={{
        border: "1px solid var(--border-subtle)",
        overflow: "hidden",
        background: "var(--bg-deep)",
        display: "flex",
        "flex-direction": "column",
        "min-height": "0",
        flex: "1",
      }}>
        <div class="section-label" style={{ padding: "12px 14px", "border-bottom": "1px solid var(--border-subtle)" }}>
          VTE Renderer Apps
        </div>
        <div style={{ padding: "12px 14px", "font-size": "11px", color: "var(--text-sublabel)", "line-height": "1.6", "border-bottom": "1px solid var(--border-subtle)" }}>
          These apps use the Rust VTE renderer for better TUI compatibility. When one of these processes is detected as the foreground app, the terminal switches from canvas to VTE rendering.
        </div>

        {/* Add new app */}
        <div style={{
          display: "flex",
          gap: "8px",
          padding: "12px 14px",
          "border-bottom": "1px solid var(--border-subtle)",
        }}>
          <input
            type="text"
            placeholder="Process name (e.g. Claude Code)"
            value={newApp()}
            onInput={(e) => setNewApp(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addApp();
              e.stopPropagation();
            }}
            class="input-field"
            style={{ flex: "1", padding: "8px 10px", "font-size": "12px" }}
          />
          <button
            class="btn btn-primary"
            style={{ padding: "8px 14px", "flex-shrink": "0" }}
            onClick={addApp}
          >
            Add
          </button>
        </div>

        {/* App list */}
        <div style={{ overflow: "auto", flex: "1" }}>
          <Show
            when={vteApps().length > 0}
            fallback={
              <div style={{ padding: "18px 14px", color: "var(--text-faint)", "font-size": "12px" }}>
                No VTE apps configured
              </div>
            }
          >
            <For each={vteApps()}>
              {(app) => (
                <div style={{
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "space-between",
                  padding: "10px 14px",
                  "border-bottom": "1px solid #1d1d1d",
                }}>
                  <span style={{ "font-size": "12px", color: "var(--text-bright)" }}>{app}</span>
                  <button
                    onClick={() => removeApp(app)}
                    style={{
                      background: "none",
                      border: "1px solid var(--border)",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      padding: "4px 10px",
                      "font-size": "11px",
                      "font-family": "inherit",
                    }}
                    onMouseEnter={(e) => { (e.target as HTMLElement).style.color = "#e06c6c"; (e.target as HTMLElement).style.borderColor = "#633535"; }}
                    onMouseLeave={(e) => { (e.target as HTMLElement).style.color = "var(--text-muted)"; (e.target as HTMLElement).style.borderColor = "var(--border)"; }}
                  >
                    Remove
                  </button>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default Settings;
