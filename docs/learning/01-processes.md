# 1. What is actually running?

**Lesson ID:** `processes` · **Time:** 8 minutes · **Prerequisites:** none

After this lesson, you can explain a process row, distinguish processes from threads, and describe what the monitor's scope filters tell you.

## A program becomes work

A program is stored instructions. A **process** is a running instance with state: memory, execution progress, and resources managed by the operating system. One installed application can involve several processes. A process can also work in the background without a window. The operating system shares CPU time among work that is ready to run; a process can spend time waiting instead of executing. [Further explanation from the OSTEP authors](https://pages.cs.wisc.edu/~remzi/OSTEP/cpu-intro.pdf).

A **thread** is an execution stream inside a process. Threads in one process share its address space, although each has its own execution state and stack. Multiple threads can help work overlap, but a thread count is not a count of cores currently occupied. [OSTEP: Concurrency and Threads](https://pages.cs.wisc.edu/~remzi/OSTEP/threads-intro.pdf).

## Read one row

Open **Activity** or press **⌘⇧A**. In this app:

| Field | What it tells you | What it does not establish |
| --- | --- | --- |
| Process | Reported name | Whether you recognize or trust the program |
| PID | Process identifier in this snapshot | A permanent identity across exits and restarts |
| User | Account owning the process | Who is currently looking at its window |
| CPU % | CPU time used across a sample interval | Whether the process is useful or faulty |
| Resident Memory | Reported resident bytes, formatted in MiB/GiB | Exclusive ownership of that much physical RAM |
| Threads | Reported thread count | How many threads are executing now |
| State | Reported process state | A complete history of its threads |

These descriptions match the [monitor model](../../app/src/activity/model.rs). The app tracks process identity with PID and start time so a later process reusing a PID does not silently inherit the earlier selection's identity.

## Observe without changing anything

1. Choose **My Processes**. Select a row you recognize, or choose any row if none is familiar. Write down its name, PID, and one available metric.
2. Press **⌘F**, search part of that name, and look for multiple matching rows. One match is also a valid result. A name match alone does not prove the rows belong to the same job.
3. Clear the search and choose **Active Pane**. This scope follows the app's association with the active shell and its descendants. An idle pane may contain only a shell. No matching rows can mean the association is unavailable.
4. Select an associated row. If **Show in Terminal** is offered, use it; then reopen Activity. The monitor has returned you to the associated terminal, not restarted or stopped that job.

If your selected process disappears, record “exited or no longer visible.” Do not substitute a different process with the same name and call it continuous observation.

## Avoid these traps

“All Processes” means the inventory available to the app. Some rows have partial data; **—** means unavailable, not zero. Apple likewise distinguishes process groups such as the current user's processes and hierarchical relationships in its [Activity Monitor process guide](https://support.apple.com/guide/activity-monitor/view-information-about-processes-actmntr1001/mac).

“This Workspace” is narrower than “everything related to my project.” The app follows visible ancestry. Detached jobs, shared tmux servers, and work on a remote machine may not map cleanly to one pane. An absent association is uncertainty, not proof of absence.

## Check your understanding

1. Two rows share a name but have different PIDs. Must one be an error?
2. A process has 20 threads and 0.0% CPU. Is that contradictory?
3. You reopen the app tomorrow and see the same PID. Can you assume it is the same process?

**Answers:** (1) No. Separate running instances or helpers can share names. (2) No. Threads may be waiting, and the displayed CPU is sampled and rounded. (3) No. PIDs can be reused; start identity matters.

**Your takeaway:** “A row describes a running instance observed at a particular time.” Next: [CPU and time](02-cpu-and-time.md).
