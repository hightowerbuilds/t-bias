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

- [ ] Let users remove a queued prompt directly from the footer
- [ ] Add a "clear queue" action
- [ ] Add drag-to-reorder or explicit move-left / move-right controls
- [ ] Add stronger visual feedback for copied items
- [ ] Add queue-empty state styling so the footer transition feels intentional
- [ ] Add optional collapse / expand behavior for the footer
- [ ] Add keyboard navigation for queued items
- [ ] Make it obvious when a prompt is already queued while browsing saved prompts

**Exit criteria:** users can manage the queue from either surface without friction.

---

## Phase 3 — Shell Workflow Integration

Reduce the gap between “copied to clipboard” and “used in the terminal.”

- [ ] Decide whether click should only copy or optionally paste into the active terminal
- [ ] Add a secondary action for "send to shell" if direct injection is supported
- [ ] Add a "copy next" / "advance queue" workflow for stepwise prompt execution
- [ ] Add queue shortcuts from the shell view
- [ ] Decide whether queue state is global across tabs or scoped per workspace/session
- [ ] Make queue behavior explicit when the active tab is not a terminal

**Exit criteria:** the queue supports an actual repeated shell workflow, not just storage plus copy.

---

## Phase 4 — Prompt Library Management

Make saved prompts maintainable as the library grows.

- [ ] Edit an existing saved prompt
- [ ] Delete saved prompts
- [ ] Duplicate prompts
- [ ] Add search/filter for large prompt libraries
- [ ] Consider tags, folders, or lightweight categories
- [ ] Add import/export for prompt libraries
- [ ] Decide how deleting a queued prompt updates the queue

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
