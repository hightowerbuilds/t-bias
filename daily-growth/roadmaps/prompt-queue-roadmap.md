# t-bias Prompt Queue Roadmap

Written 2026-04-16.

## Goal

Turn Prompt Stacker from a saved-prompt list into a usable shell-side prompt queue:

- users save prompts inside the app
- users choose which saved prompts belong in a queue
- queued prompts are available from the shell workspace in a footer bar
- clicking a queued prompt copies it immediately for paste into the active workflow

This roadmap starts from the first working slice that already landed today.

---

## Phase 1 — Foundation

Ship the minimum viable queue with persistent state and shell access.

- [x] Persist Prompt Stacker state on disk instead of keeping only an in-memory draft
- [x] Migrate legacy prompt-only JSON into a richer prompt-stacker state shape
- [x] Add queue membership state alongside saved prompts
- [x] Expose queue state through the shared frontend store
- [x] Let users add/remove saved prompts from the queue inside Prompt Stacker
- [x] Show queue count in the Prompt Stacker header
- [x] Render the queue in a footer-style shell bar
- [x] Copy a queued prompt to the clipboard when clicked

**Exit criteria:** queue state survives restart and is reachable from the shell without reopening Prompt Stacker.

---

## Phase 2 — Queue Ergonomics

Make the queue pleasant to manage instead of merely functional.

- [x] Let users remove a queued prompt directly from the footer
- [x] Add a "clear queue" action
- [x] Add drag-to-reorder or explicit move-left / move-right controls
- [x] Add stronger visual feedback for copied items
- [x] Add queue-empty state styling so the footer transition feels intentional
- [x] Add optional collapse / expand behavior for the footer
- [x] Add keyboard navigation for queued items
- [x] Make it obvious when a prompt is already queued while browsing saved prompts

Note (2026-04-19): Footer pills now have inline × remove buttons, ◂/▸ reorder arrows, and a Clear button. Collapse/expand toggle on footer label. Arrow keys + Enter/Space/Delete for keyboard nav. Focused item gets accent border. Saved prompts list shows queued items with left accent border and `#N` badge. Store expanded with `removeFromQueue`, `clearQueue`, `moveInQueue`. 5 new tests (96 total).

**Exit criteria:** users can manage the queue from either surface without friction.

---

## Phase 3 — Shell Workflow Integration

Reduce the gap between “copied to clipboard” and “used in the terminal.”

- [x] Decide whether click should only copy or optionally paste into the active terminal
- [x] Add a secondary action for “send to shell” if direct injection is supported
- [x] Add a “copy next” / “advance queue” workflow for stepwise prompt execution
- [x] Add queue shortcuts from the shell view
- [x] Decide whether queue state is global across tabs or scoped per workspace/session
- [x] Make queue behavior explicit when the active tab is not a terminal

Note (2026-04-19): Click copies to clipboard; Shift+click sends directly to the active terminal's PTY via write_to_pty. Cmd+Shift+Q advances the queue (pops first item, sends to shell or copies if not in a terminal). Queue is global across tabs. Footer shows “Click to copy, Shift+click to send to shell” tooltip when a terminal is active. “Sent” feedback (blue) is distinct from “Copied” feedback (green). Store gained `advanceQueue()`. 98 tests passing.

**Exit criteria:** the queue supports an actual repeated shell workflow, not just storage plus copy.

---

## Phase 4 — Prompt Library Management

Make saved prompts maintainable as the library grows.

- [x] Edit an existing saved prompt
- [x] Delete saved prompts
- [x] Duplicate prompts
- [x] Add search/filter for large prompt libraries
- [ ] Consider tags, folders, or lightweight categories
- [ ] Add import/export for prompt libraries
- [x] Decide how deleting a queued prompt updates the queue

Note (2026-04-19): Rust backend gained `edit_prompt`, `delete_prompt`, `duplicate_prompt` commands. Store expanded with `editPrompt`, `deletePrompt`, `duplicatePrompt`, `searchFilter`, `filteredPrompts`. PromptStacker UI: each prompt card has Edit/Dup/Del buttons, inline edit mode with Cmd+Enter/Escape, search bar appears when >5 prompts. Deleting a prompt auto-cleans the queue (via `normalize_state`). 98 tests.

**Exit criteria:** users can keep a long-lived prompt library clean without leaving stale queue entries behind.

---

## Phase 5 — Reliability and Product Contract

Harden the queue so it feels like a real app feature rather than a convenience layer.

- [ ] Add frontend tests for queue add/remove/reorder flows
- [ ] Add backend tests for prompt-stacker file migration and queue persistence
- [ ] Test clipboard failure behavior and fallback handling
- [ ] Verify queue state survives app restart and session restore
- [ ] Document queue behavior in the README once stable
- [ ] Keep naming consistent: Prompt Stacker, queue, footer bar, shell actions

**Exit criteria:** queue behavior is stable, testable, and accurately described in product docs.

---

## Recommended Order

1. Queue ergonomics
2. Shell workflow integration
3. Prompt library management
4. Reliability and product contract

That order matters. The footer queue already exists; the next win is making it easy to manage before expanding its power.

## Definition of Success

Prompt Queue is done when a user can say:

- "I can save prompts once and keep the good ones handy."
- "I can build a queue without fighting the UI."
- "The queue is always available from the shell."
- "Clicking a queued prompt reliably gets it into my workflow."
- "My prompt library and queue survive restart without surprises."
