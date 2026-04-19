# Lifecycle Behavior QA Checklist (Phase 1.3)

Written 2026-04-19.

Manual verification of process lifecycle behavior per the lifecycle contract
defined in `terminal-trust-hardening-roadmap.md` Phase 1.1.

---

## Lifecycle Contract (reference)

1. **Pane close** — SIGHUP → SIGCONT → SIGTERM the process group, wait 60ms, SIGKILL survivors. Pane removed from UI.
2. **Tab close** — Close all panes in the tab (same per-pane sequence).
3. **App quit** — Shell registry updated, then all PTYs terminated by Rust `RunEvent::Exit` handler. No processes survive.
4. **Background jobs** — Terminated with the shell. Not detached or preserved.
5. **Shell exits on its own** — "[Process exited]" shown in pane. Pane stays open until user closes it.

---

## Test 1: Foreground shell on pane close

**Steps:**
1. Open a single terminal pane
2. Verify shell prompt is visible
3. Close the pane (Cmd+W or UI close)

**Expected:**
- Shell process is terminated (verify: no orphan shell in `ps aux | grep zsh`)
- Pane is removed from the UI
- No error messages in the app

**Result:** [pass]

---

## Test 2: Long-running child process on pane close

**Steps:**
1. Open a terminal pane
2. Run `sleep 300` (or `yes > /dev/null`)
3. Close the pane

**Expected:**
- The `sleep` (or `yes`) process is killed — does not survive in `ps aux`
- Shell process is also killed
- Pane removed cleanly

**Result:** [pass]

---

## Test 3: Vim on pane close

**Steps:**
1. Open a terminal pane
2. Run `vim` (or `nvim`)
3. Close the pane without quitting vim

**Expected:**
- Vim receives SIGHUP and exits (vim handles SIGHUP by saving swap + exiting)
- No orphan vim process in `ps aux`
- No leftover `.swp` file beyond what vim's normal SIGHUP handler creates

**Result:** [pass]

---

## Test 4: Less / man on pane close

**Steps:**
1. Open a terminal pane
2. Run `man ls` or `less /etc/hosts`
3. Close the pane

**Expected:**
- `less` (or `man`) is terminated
- No orphan process

**Result:** [pass]

---

## Test 5: tmux on pane close

**Steps:**
1. Open a terminal pane
2. Run `tmux` (creates a new tmux session)
3. Close the pane

**Expected:**
- The tmux client process is killed (it received SIGHUP)
- The tmux server may remain running (this is expected — tmux detaches sessions on client hangup)
- Verify with `tmux ls` — the session should still exist but be detached
- This matches iTerm2/Terminal.app behavior

**Result:** [pass]

---

## Test 6: Agent CLI on pane close

**Steps:**
1. Open a terminal pane
2. Run `claude` (Claude Code) or another agent CLI
3. Close the pane while the agent is active

**Expected:**
- Agent process receives SIGHUP and exits
- No orphan `claude` or `node` processes from that session
- Verify with `ps aux | grep claude`

**Result:** [pass]

---

## Test 7: Tab close with multiple panes

**Steps:**
1. Open a tab with 2-3 split panes
2. Run a different long-running command in each (`sleep 300`, `vim`, `less /etc/hosts`)
3. Close the tab

**Expected:**
- All pane processes are killed
- All panes removed from UI
- No orphan processes from any of the panes

**Result:** [fail — TerminalView unmounted during split, losing screen state. Fixed: added TerminalHost cache with detach/reattach. Re-test needed.]

---

## Test 8: App quit with running processes

**Steps:**
1. Open multiple tabs with running processes
2. Quit the app (Cmd+Q)

**Expected:**
- All PTY processes terminated by `RunEvent::Exit` handler
- No orphan shells, child processes, or agent CLIs survive
- Verify with `ps aux | grep -E "sleep|vim|less"` after quit
- App exits cleanly

**Result:** [skipped — user decided app quit behavior is handled by RunEvent::Exit; no additional verification needed]

---

## Test 9: Shell exits on its own

**Steps:**
1. Open a terminal pane
2. Type `exit` and press Enter

**Expected:**
- Shell exits naturally
- Pane shows "[Process exited]"
- Pane remains visible and open in the UI
- User can close the pane manually afterward

**Result:** [pass]

---

## Test 10: Background job behavior

**Steps:**
1. Open a terminal pane
2. Run `sleep 300 &` to start a background job
3. Verify with `jobs` that it's running
4. Close the pane

**Expected:**
- Background `sleep` process is killed along with the shell
- Not detached or preserved
- Verify with `ps aux | grep sleep`

**Result:** [  17996   0.0  0.0 67775000    804 s006  SN+   1:37PM   0:00.00 grep sleep ]

---

## Test 11: Rapid open/close (race condition check)

**Steps:**
1. Open a terminal pane
2. Run `yes` (produces rapid output)
3. Immediately close the pane within ~1 second

**Expected:**
- No crash or error
- `yes` process is killed
- No lingering output events or console errors
- Pane removed cleanly

**Result:** [fail — crashed the app. Post-dispose guards added (2026-04-19). Re-test needed.]

---

## Test 12: Close pane during shell startup

**Steps:**
1. Open a new tab (spawns shell)
2. Close it immediately before the prompt fully appears

**Expected:**
- No crash
- Shell process killed even though it may not have finished initialization
- Pane removed cleanly

**Result:** [ ]

---

## Notes

- After each test, run `ps aux | grep -E "sleep|vim|less|tmux|claude|yes"` to verify no orphans
- Check the Rust log output for `close_pane` / `close_all` / `terminate_process_group` messages
- If any test fails, note the orphan PIDs and which signal sequence failed to terminate them
