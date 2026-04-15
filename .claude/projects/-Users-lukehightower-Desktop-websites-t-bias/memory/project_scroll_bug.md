---
name: Duplicate lines on scroll
description: Primary bug — scrolling text output produces duplicate lines in the terminal renderer
type: project
---

Scrolling text creates duplicate lines in the terminal display. This is the primary open issue as of 2026-04-15.

**Why:** The rendering or screen state management is producing repeated lines when content scrolls. Likely in the VirtualCanvas, Screen scroll logic, or the Renderer's dirty-region tracking.

**How to apply:** When investigating, focus on the scroll path: `Screen` line-feed / scroll-up handling, `VirtualCanvas` row management during scrolls, and the `Renderer`/`TerminalHost` draw cycle to see if stale rows are being painted or rows are being double-copied.
