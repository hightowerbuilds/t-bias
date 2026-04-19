# t-bias Roadmap Priority Order

Written 2026-04-16.

## Goal

Choose a single smart order for the active roadmaps so work compounds instead of fragmenting.

## Active Roadmaps

1. `terminal-trust-hardening-roadmap.md`
2. `prompt-queue-roadmap.md`
3. `feature-roadmap.md`

`old-maps/` should be treated as archive/reference, not active planning.

---

## Recommended Priority

### 1. Terminal Trust Hardening

**Why first**

- it removes the biggest daily-driver objections
- it reduces the risk of every other roadmap
- it improves predictability around process lifecycle, session behavior, and input
- it turns t-bias from "interesting" into "trustworthy"

**Why this is the smartest route**

Prompt Queue and future terminal features both sit on top of shell/session behavior. If close semantics, restore behavior, and app-level confidence stay fuzzy, every new feature inherits that fragility.

**Immediate next focus inside this roadmap**

- define and document close semantics clearly
- manually verify process lifecycle behavior with real tools
- harden restore behavior for missing paths / failed cwd restores
- expand app-level workflow coverage beyond serializer tests

---

### 2. Prompt Queue

**Why second**

- the foundation is already live
- the next steps are product-visible and relatively contained
- this is a good near-term UX win once the trust baseline is stronger

**How to work it**

Treat Prompt Queue as a parallel product track only after trust-hardening work is not actively destabilizing shell/session behavior. The best next slice here is queue ergonomics, not deeper shell automation yet.

**Immediate next focus inside this roadmap**

- remove queued items directly from the footer
- add clear queue
- add reorder controls
- add queue tests and persistence verification

---

### 3. Feature Roadmap

**Why third**

- it is the broadest and least bounded roadmap
- several items are large terminal-emulator projects on their own
- it mixes true blockers with aspirational scope
- it should be fed by trust and testing improvements, not compete with them

**How to use it**

Treat `feature-roadmap.md` as the long-range backlog. Pull from it only when a specific item becomes the highest-value next terminal capability and does not undermine ongoing hardening work.

---

## Practical Rule

When choosing the next sprint, ask:

1. Does this make the terminal more trustworthy?
2. Does this unblock real daily use?
3. Does this reduce risk for later features?
4. Is this a contained UX win on top of stable foundations?

If the answer is mostly `1-3`, pull from Terminal Trust Hardening.
If the answer is mostly `4`, pull from Prompt Queue.
If the work is ambitious but not urgent, leave it in Feature Roadmap.

## Recommended Next Move

Finish the next meaningful slice of **Terminal Trust Hardening** before pushing deeper into Prompt Queue or the broad feature backlog.

That is the highest-leverage route:

- fewer hidden regressions
- better daily-driver credibility
- safer foundation for Prompt Queue and later terminal features
