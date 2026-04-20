# Leftover Follow-up Items

Collected from the Terminal Trust Hardening Roadmap (2026-04-19). These are manual testing, documentation, and minor code items that remain after the main code work was completed across all 6 phases.

---

## Manual Testing

### Phase 1.3 — Lifecycle QA Re-tests
- [ ] Re-test Test 7: Tab close with multiple panes (fixed via TerminalHost cache)
- [ ] Re-test Test 11: Rapid `yes` + close (disposed guards added)
- [ ] Run Test 12: Close pane during shell startup

### Phase 3.3 — Persistence Stress Testing
- [ ] Open/close/switch tabs repeatedly and profile save frequency
- [ ] Split/close panes repeatedly and profile save frequency
- [ ] Verify autosave under heavy PTY activity
- [ ] Verify no corrupted session file on interrupted writes

### Phase 4.2 — IME Validation
- [ ] Test Japanese IME
- [ ] Test Chinese IME
- [ ] Test accented Latin composition
- [ ] Test mixed terminal/TUI scenarios

---

## Documentation

### Phase 4.3 — Input Limitations
- [ ] Document what input modes are supported
- [ ] Remove composition warning only once support is verified reliable

### Phase 6.2 — User-Facing Honesty
- [ ] Make sure README and product copy do not overstate session behavior
- [ ] Make sure close behavior is discoverable
- [ ] Make sure limitations are stated where they matter

---

## Minor Code Items

### Phase 2.2 — Session Landing UI
- [ ] Ensure session landing UI reflects what is actually restored (layout vs shell records)

### Phase 2.3 — Restore Edge Cases
- [ ] Handle deleted files and moved directories gracefully (editor panes with missing files)
- [ ] Add migration rules for older session file formats (version field in SessionData enables this)

### Phase 5.2 — Backend/PTY Test Coverage (needs Tauri runtime)
- [ ] Add tests for shell spawn failure and recovery
- [ ] Add tests for pane close cleanup behavior
- [ ] Add tests for cwd lookup behavior
- [ ] Add tests for foreground process title lookup behavior

### Phase 5.3 — End-to-End Smoke Coverage (needs E2E tooling)
- [ ] Launch app and open a shell
- [ ] Create a second tab at the same cwd
- [ ] Split panes and close one
- [ ] Save and restore a named session
- [ ] Open Prompt Stacker and save a prompt
- [ ] Flip to explorer and open a markdown file
