# 2. What does 100% CPU mean?

**Lesson ID:** `cpu` · **Time:** 10 minutes · **Prerequisite:** [Processes](01-processes.md)

After this lesson, you can calculate this app's process CPU percentage and explain why it differs from the system graph.

## CPU use measures time

The monitor takes snapshots. A single accumulated CPU counter cannot tell us how busy a process was recently; we need the change between two samples and the time separating them.

This app defines:

`process CPU % = 100 × CPU seconds used / elapsed seconds`

The counter includes user and system CPU time for the process. The native backend converts its counter units before calculating the percentage. One logical CPU fully occupied across an interval corresponds to 100%. Threads working across logical CPUs can produce more than 100%. This is the app's [tested metric contract](../../app/src/activity/model.rs), not an error bar or a battery percentage.

**Example:** During two elapsed seconds, a process accumulates one CPU second: `100 × 1 / 2 = 50%`. During two elapsed seconds, a different process accumulates five CPU seconds across its threads: `100 × 5 / 2 = 250%`.

## The system graph uses a different denominator

The system graph reports busy CPU time as a share of total sampled CPU time across the machine. It stays on a 0–100% scale. As a simplified example, one fully busy logical CPU out of eight equally accounted logical CPUs would contribute about 12.5% overall, while its process could show about 100%.

Real per-process values need not sum neatly to the system graph: coverage and sampling intervals can differ, and their denominators differ. Neither number tells you which physical core executed an instruction. This monitor currently collects no per-core utilization. Apple's monitor offers separate overall and per-core views; that distinction is also useful here. [Apple's CPU activity guide](https://support.apple.com/guide/activity-monitor/view-cpu-activity-actmntr43452/mac).

## Observe an interval

1. Open Activity and keep the app active. Set the interval to **2s**. Wait for at least two samples; initial CPU values can be **—** while a baseline is established.
2. Click **CPU %** to put larger available values first. Select a process and note its PID so a moving sorted row does not trick you into observing another process.
3. Watch three refreshes. Write down the values, or record that the process disappeared. Zero or near-zero values are valid observations.
4. Press **Pause**. The values should stop updating. Processes keep running: you paused measurement, not the computer.
5. Resume and wait for a new baseline and subsequent sample. The app does not invent a CPU percentage for the missing interval. It also suspends collection when closed or inactive.

There is no requirement to generate CPU load. For a predictable arithmetic exercise, use the fixed examples above. Sampling at one second can show more short-term variation than five seconds; neither setting supplies an instruction-by-instruction trace.

## Avoid these traps

High usage can be useful work. A quiet CPU does not prove the computer is responsive: a program may be waiting on storage, a network response, or another thread. Those possibilities are hypotheses until you obtain more evidence. The current monitor cannot diagnose the reason from CPU % alone.

The number of threads is not a promised speedup. A process at 0.0% may have run briefly below display precision. A missing **—** value cannot be treated as 0.0%.

## Check your understanding

1. A process accumulates 0.6 CPU seconds in a 2-second interval. What should it show?
2. Can 180% be valid for a process?
3. Does Pause stop the process at the top of the table?
4. A process has low CPU and feels slow. Have you proved it needs more RAM?

**Answers:** (1) 30%. (2) Yes, if its work executes across multiple logical CPUs. (3) No; it freezes measurement. (4) No; more evidence is needed to distinguish causes.

**Your takeaway:** “Always ask which interval and which denominator a percentage uses.” Next: [Memory](03-memory.md).
