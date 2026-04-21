import { For, Show, type Component } from "solid-js";
import { isRestorableShell, shellStatusLabel, formatShellTime } from "./useShellRegistry";
import type { ShellRecord } from "./ipc/types";

export const ShellLanding: Component<{
  records: ShellRecord[];
  hasTabs: boolean;
  findOpenShell: (shellId: string) => { tabId: number; paneId: number } | null;
  onOpenRecord: (record: ShellRecord) => void;
  onTogglePersist: (shellId: string, persist: boolean) => void;
  onRestoreAll: () => void;
  onNewShell: () => void;
  onClose: () => void;
}> = (props) => {
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
        <div style={{ display: "flex", "justify-content": "space-between", gap: "18px", "align-items": "flex-start" }}>
          <div>
            <div style={{ "font-size": "14px", color: "var(--text-muted)" }}>t-bias</div>
            <div style={{ "font-size": "18px", color: "var(--text-bright)", "margin-top": "8px" }}>Shell Registry</div>
            <div style={{ "font-size": "12px", color: "var(--text-sublabel)", "margin-top": "6px", "line-height": "1.6" }}>
              Restore your previous workspace layout (tabs, splits, and working directories) or start fresh. Individual shells are listed below.
            </div>
          </div>
          <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-wrap": "wrap", "justify-content": "flex-end" }}>
            <Show when={props.records.some(isRestorableShell)}>
              <button class="btn btn-primary" style={{ padding: "9px 14px" }} onClick={props.onRestoreAll}>
                Restore Last Session
              </button>
            </Show>
            <button class="btn btn-secondary" style={{ padding: "9px 14px" }} onClick={props.onClose}>
              Close
            </button>
          </div>
        </div>

        <div style={{
          border: "1px solid var(--border-subtle)",
          "border-radius": "10px",
          overflow: "hidden",
          background: "var(--bg-deep)",
          display: "flex",
          "flex-direction": "column",
          "min-height": "0",
          flex: "1",
        }}>
          <div class="section-label" style={{ padding: "12px 14px", "border-bottom": "1px solid var(--border-subtle)" }}>
            Shell History
          </div>
          <Show
            when={props.records.length > 0}
            fallback={
              <div style={{ padding: "18px 14px", color: "var(--text-faint)", "font-size": "12px" }}>
                No shells have been tracked yet
              </div>
            }
          >
            <div style={{ display: "flex", "flex-direction": "column", overflow: "auto" }}>
              <For each={props.records}>
                {(record) => {
                  const isOpen = () => Boolean(props.findOpenShell(record.id));
                  return (
                    <div style={{
                      display: "flex",
                      gap: "12px",
                      padding: "12px 14px",
                      "border-top": "1px solid #1d1d1d",
                      "align-items": "center",
                    }}>
                      <button
                        onClick={() => props.onOpenRecord(record)}
                        style={{
                          flex: "1",
                          background: "none",
                          border: "none",
                          color: "var(--text-primary)",
                          cursor: "pointer",
                          "text-align": "left",
                          padding: "0",
                          "font-family": "inherit",
                        }}
                      >
                        <div style={{ display: "flex", "align-items": "center", gap: "10px", "margin-bottom": "4px", "flex-wrap": "wrap" }}>
                          <span style={{ "font-size": "12px", color: "var(--text-bright)" }}>{record.title || "Shell"}</span>
                          <span style={{
                            "font-size": "10px",
                            color: isOpen() ? "var(--open-text)" : record.status === "detached" ? "var(--detached-text)" : "var(--text-muted)",
                            background: isOpen() ? "var(--open-bg)" : record.status === "detached" ? "var(--detached-bg)" : "#1c1c1c",
                            border: isOpen() ? "1px solid var(--open-border)" : "1px solid var(--border)",
                            "border-radius": "var(--radius-pill)",
                            padding: "4px 7px",
                            "text-transform": "uppercase",
                            "letter-spacing": "0.05em",
                          }}>
                            {isOpen() ? "Open" : shellStatusLabel(record.status)}
                          </span>
                          <Show when={record.persist_on_quit}>
                            <span style={{ "font-size": "10px", color: "var(--success-text)" }}>Persists on quit</span>
                          </Show>
                        </div>
                        <div style={{ "font-size": "11px", color: "var(--text-sublabel)", "line-height": "1.6" }}>
                          {record.last_known_cwd || "No working directory captured"}
                        </div>
                        <div style={{ "font-size": "10px", color: "var(--text-faint)", "margin-top": "4px" }}>
                          Last attached {formatShellTime(record.last_attached_at)}
                        </div>
                      </button>

                      <button
                        class="btn btn-pill"
                        onClick={() => void props.onTogglePersist(record.id, !record.persist_on_quit)}
                        style={{
                          background: record.persist_on_quit ? "var(--queued-bg)" : "#1d1d1d",
                          color: record.persist_on_quit ? "var(--queued-text)" : "#9aa3b2",
                          border: record.persist_on_quit ? "1px solid var(--queued-border)" : "1px solid var(--border)",
                          "flex-shrink": "0",
                        }}
                      >
                        {record.persist_on_quit ? "Persisting" : "No Persist"}
                      </button>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
    </div>
  );
};
