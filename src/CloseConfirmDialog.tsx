import { Show, type Component } from "solid-js";

export interface PendingClose {
  processNames: string[];
  onConfirm: () => void;
}

export const CloseConfirmDialog: Component<{
  pending: PendingClose | null;
  onDismiss: () => void;
}> = (props) => {
  return (
    <Show when={props.pending}>
      {(close) => (
        <div
          class="modal-backdrop"
          style={{ background: "rgba(0,0,0,0.6)", "z-index": "var(--z-close-dialog)" }}
          onClick={() => props.onDismiss()}
        >
          <div
            class="modal-card"
            style={{ padding: "22px 26px", "max-width": "420px", width: "100%" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ "font-size": "14px", "margin-bottom": "10px", color: "var(--text-bright)" }}>
              Close with running {close().processNames.length === 1 ? "process" : "processes"}?
            </div>
            <div style={{ "font-size": "12px", color: "var(--text-muted)", "line-height": "1.6", "margin-bottom": "18px" }}>
              {close().processNames.join(", ")} {close().processNames.length === 1 ? "is" : "are"} still running.
              Closing will terminate {close().processNames.length === 1 ? "it" : "them"}.
            </div>
            <div style={{ display: "flex", gap: "10px", "justify-content": "flex-end" }}>
              <button class="btn btn-secondary" onClick={() => props.onDismiss()}>Cancel</button>
              <button
                class="btn btn-destructive"
                onClick={() => {
                  const confirm = close().onConfirm;
                  props.onDismiss();
                  confirm();
                }}
              >Close</button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};
