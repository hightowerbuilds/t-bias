# t-bias Terminal Trust Hardening Roadmap

Written 2026-04-16.

## Goal

Close the gap between “impressive custom terminal project” and “terminal a senior developer would trust as a daily driver.”

This roadmap is intentionally biased toward trust, determinism, and product-level reliability over new surface-area features.

## Status Update

Progress already landed in code:

- explicit pane-close termination path for PTY children
- session snapshots now persist terminal cwd and file-explorer root paths
- session autosave is debounced instead of writing on every interaction
- before-unload and explicit session save paths now flush immediately
- terminal input now has a real text-input sink with composition handling
- session serialization / restore now has direct round-trip tests

This roadmap is still active. The early foundations moved forward, but the manual verification, product-contract, and broader app-level coverage work are still open.

---

## Phase 1 — Process and Lifecycle Integrity

Make pane, tab, and app close behavior explicit and deterministic.

### 1.1 Define lifecycle rules

- [x] Decide and document what happens when a pane closes
- [x] Decide and document what happens when a tab closes
- [x] Decide and document what happens when the app quits with running processes
- [x] Decide whether background jobs are explicitly supported, detached, or terminated
- [x] Add product copy or confirmation flows where behavior is destructive or surprising

**Lifecycle contract (decided 2026-04-19):**

1. **Pane close** — SIGHUP → SIGCONT → SIGTERM the process group, wait 60ms, SIGKILL survivors. Pane removed from UI.
2. **Tab close** — Close all panes in the tab (same per-pane sequence).
3. **App quit** — Shell registry is updated (via Tauri `onCloseRequested`), then all PTYs are terminated by the Rust `RunEvent::Exit` handler. No processes survive the app.
4. **Background jobs** — Terminated with the shell. Not detached or preserved. Matches iTerm2/Terminal.app behavior.
5. **Shell exits on its own** — "[Process exited]" shown in pane. Pane stays open until user closes it.

### 1.2 Fix backend ownership of child processes

- [x] Keep a real child/process handle in pane state instead of only a PID
- [x] Add an explicit kill/terminate path for pane close
- [x] Distinguish between graceful PTY hangup and forced termination
- [x] Ensure child cleanup does not rely on implicit drop semantics
- [ ] Handle races between pane close, child exit, and late PTY output events

Note: PaneState stores a real `ChildKiller` handle (not just a PID). The termination path sends SIGHUP (graceful hangup) first, then SIGTERM, then SIGKILL (forced). `RunEvent::Exit` guarantees cleanup on app quit via `PtyState::close_all()`.

### 1.3 Verify lifecycle behavior

- [ ] Test foreground shells on close
- [ ] Test long-running child processes on close
- [ ] Test nested tools like `tmux`, `vim`, `less`, and agent CLIs
- [ ] Test tab close vs pane close vs app quit behavior
- [ ] Add clear manual QA notes for expected outcomes

**Exit criteria:** a user can predict exactly what happens to their process tree when UI surfaces close.

---

## Phase 2 — Session Fidelity

Turn session restore from layout restore into real workspace restore.

### 2.1 Expand the session model

- [x] Persist terminal cwd for each restorable terminal pane
- [x] Persist file explorer root path
- [ ] Persist editor file identity and reopen location where feasible
- [ ] Persist active tab and active pane in a way that survives structural changes
- [ ] Remove or migrate legacy Prompt Stacker pane compatibility once obsolete

### 2.2 Clarify session semantics

- [ ] Separate “layout restore” from “workspace restore” in naming if needed
- [ ] Ensure session landing UI reflects what is actually restored
- [ ] Avoid silently changing saved pane types during restore without surfacing that behavior

### 2.3 Harden restore behavior

- [x] Handle missing paths gracefully
- [ ] Handle deleted files and moved directories gracefully
- [x] Handle shells that fail to spawn at the saved cwd
- [ ] Add migration rules for older session file formats

**Exit criteria:** reopening a saved session gets the user meaningfully back to where they were working, not just back to a similar shape.

---

## Phase 3 — Persistence Architecture

Make auto-save durable without tying it directly to every interaction path.

### 3.1 Move away from eager write-on-every-action behavior

- [x] Audit every place `saveSession()` is called
- [x] Introduce debounced auto-save for normal interaction paths
- [x] Keep immediate saves only for high-value transitions if necessary
- [x] Ensure before-unload and explicit save paths still flush immediately

### 3.2 Improve write strategy

- [ ] Consider writing compact JSON rather than pretty JSON for autosave
- [ ] Consider atomic write strategy: temp file + rename
- [ ] Handle failed writes without silently masking durable-state problems
- [ ] Add instrumentation or logs around session save failures

### 3.3 Stress the persistence model

- [ ] Open/close/switch tabs repeatedly and profile save frequency
- [ ] Split/close panes repeatedly and profile save frequency
- [ ] Verify autosave under heavy PTY activity
- [ ] Verify no corrupted session file on interrupted writes

**Exit criteria:** session persistence feels invisible, cheap, and trustworthy.

---

## Phase 4 — Real Input Support

Support serious text input, not just keydown-driven terminal usage.

### 4.1 Add composition support

- [x] Add composition event handling (`compositionstart`, `compositionupdate`, `compositionend`)
- [x] Add input-path handling where raw keyboard events are insufficient
- [ ] Verify the terminal focus target can participate in text composition correctly
- [x] Ensure composition text does not leak broken intermediate states into the PTY

### 4.2 Validate IME behavior

- [ ] Test Japanese IME
- [ ] Test Chinese IME
- [ ] Test accented Latin composition
- [ ] Test mixed terminal/TUI scenarios

### 4.3 Document known input limitations

- [ ] Be explicit in docs about what input modes are supported
- [ ] Remove that warning only once composition support is reliable

**Exit criteria:** the app no longer excludes whole classes of users because of missing input composition support.

---

## Phase 5 — Integration Test Coverage

Raise confidence from terminal-core correctness to actual product correctness.

Progress note:

- direct session serialization / restore tests now exist
- broader app workflow coverage is still missing

### 5.1 Add frontend integration coverage

Progress note:

- workspace lifecycle tests now cover last-tab replacement, active-tab close, and split-pane close behavior through the shared workspace state model

- [ ] Add tests for tab creation, switching, and close behavior
- [ ] Add tests for pane splitting and collapse behavior
- [ ] Add tests for session landing state transitions
- [ ] Add tests for Prompt Stacker open/close and persistence interactions
- [ ] Add tests for file explorer open-file workflows

### 5.2 Add backend/PTy workflow coverage

- [ ] Add tests for shell spawn failure and recovery
- [ ] Add tests for pane close cleanup behavior
- [ ] Add tests for cwd lookup behavior
- [ ] Add tests for foreground process title lookup behavior

### 5.3 Add end-to-end smoke coverage

- [ ] Launch app and open a shell
- [ ] Create a second tab at the same cwd
- [ ] Split panes and close one
- [ ] Save and restore a named session
- [ ] Open Prompt Stacker and save a prompt
- [ ] Flip to explorer and open a markdown file

**Exit criteria:** the risky app-level workflows are covered by more than manual confidence.

---

## Phase 6 — Product Contract Cleanup

Reduce product ambiguity and stop surprising users.

### 6.1 Tighten feature semantics

- [ ] Audit any feature whose implementation no longer matches its original model
- [ ] Remove stale state models and dead compatibility paths
- [ ] Keep session, shell, and Prompt Stacker terminology consistent

### 6.2 Improve user-facing honesty

- [ ] Make sure README and product copy do not overstate session behavior
- [ ] Make sure close behavior is discoverable
- [ ] Make sure limitations are stated where they matter

**Exit criteria:** the product says what it means and does what it says.

---

## Recommended Order

1. Process lifecycle integrity
2. Session fidelity
3. Persistence architecture
4. Input composition support
5. Integration test coverage
6. Product contract cleanup

That order matters. New features should not outrun trust hardening.

## Definition of Success

t-bias is ready for serious daily use when a senior engineer can say:

- “I know what happens when I close things.”
- “My sessions bring me back to real work context.”
- “The app does not feel fragile under normal interaction.”
- “Text input works for more than a narrow keyboard path.”
- “The risky app workflows are actually tested.”
