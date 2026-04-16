# Senior Developer Critical Review of t-bias

Written 2026-04-16.

## Executive Summary

t-bias is technically ambitious and clearly built by someone who cares about owning the whole terminal stack. That said, I would not adopt it as my daily terminal yet.

The main reason is trust. A terminal emulator does not get judged like a normal UI app. It gets judged on whether it behaves predictably under pressure, whether it preserves work, whether it kills or keeps processes exactly when expected, and whether it supports real-world input and workflow edges without surprises.

Right now, t-bias feels promising, but not trustworthy enough for primary use.

## Why I Would Not Use It Yet

### 1. Pane and process lifecycle are not explicit enough

If I close a pane, I need to know exactly what happens to the process behind it.

Right now, the PTY is dropped, but the product does not present a clear, deliberate process-lifecycle contract:

- Does pane close always kill the child process?
- Does it hang up the PTY and rely on the shell to exit?
- Can a long-running child keep going after the UI implies it is gone?

For a terminal, ambiguity here is unacceptable. This is one of the fastest ways to lose senior users.

### 2. Session restore does not restore enough real working context

The current session model is closer to layout restore than workspace restore.

That is not enough for serious use. If I come back to a session, I expect more than just a tab tree. I expect the app to reopen me near where I was working:

- terminal cwd
- explorer root
- meaningful pane context
- consistent tab identity

If sessions restore “shape” but not working context, they feel cosmetic rather than reliable.

### 3. Auto-save is too eager for an interaction-heavy terminal app

Session persistence currently happens across ordinary interaction paths like tab creation, tab switching, pane changes, and other UI actions.

That introduces the risk of unnecessary disk churn and UI coupling to persistence. In a terminal, the interaction surface is hot. Saving synchronously during those flows is the kind of architecture decision that starts small and becomes a performance and correctness liability later.

This is not the sort of thing a user notices as a feature, but they do notice when the app feels sticky, inconsistent, or fragile.

### 4. Input support is not complete enough for serious daily use

The current input model is fundamentally keyboard-event driven.

That is fine for the early version of a terminal, but not fine for a terminal that wants to compete for everyday use. Without proper composition and IME support, the app is effectively excluding a category of serious users outright.

This is not an optional polish item. It is a platform-level requirement.

### 5. The risky surfaces are the least tested surfaces

The terminal core has meaningful automated test coverage. That is good.

But the real user-facing workflows are not where they need to be:

- PTY lifecycle
- pane close behavior
- session persistence and restore
- file explorer coordination with terminals
- Prompt Stacker and session landing flows
- tab and split orchestration

That creates a dangerous mismatch: the code that feels most “advanced” is not necessarily the code most protected from regressions.

As a senior engineer, I would read that as “interesting project, not yet dependable product.”

## What I Would Say About the App

If I were reviewing this bluntly, I would say:

> This is a strong engineering prototype with real product potential, but it is not a terminal I would move my workflow into yet. The renderer and terminal core are impressive. The product-level contracts are not solid enough. I do not yet trust pane close semantics, session fidelity, input completeness, or the integration surface around tabs, panes, and auxiliary tools.

And I would add:

> The project needs to spend less time adding adjacent surfaces and more time making the terminal itself behave like something I can trust with long-running work.

## Most Important Problems to Solve

### A. Make process lifecycle explicit

Users need deterministic rules for:

- closing a pane
- closing a tab
- quitting the app
- backgrounding long-running jobs

The backend and UI should agree on those rules, and the product should communicate them clearly.

### B. Redefine sessions as real workspace restore

Sessions should restore working context, not just layout. If that is not possible yet, the product should be honest about the limitation and avoid overstating what “session restore” means.

### C. Decouple persistence from hot interaction paths

Persistence should be durable, but it should not sit directly on top of every interaction path in a way that invites performance drag or subtle state bugs.

### D. Add proper text input composition support

Without this, the terminal is effectively non-serious for part of the developer population.

### E. Shift testing upward into the actual product workflows

The terminal core is not the only thing that needs confidence. The app shell, PTY boundary, sessions, and file/explorer/editor coordination need automated coverage too.

## Bottom Line

t-bias is impressive enough that it deserves hard criticism.

That is the good news.

The bad news is that the remaining problems are not cosmetic. They sit in the exact places that decide whether a senior engineer will trust the app as infrastructure.

Until process lifecycle, session fidelity, input coverage, and integration testing are hardened, t-bias will read as a promising custom terminal project rather than a terminal I would bet my workday on.
