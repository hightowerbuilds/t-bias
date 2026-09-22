# 3. Where does a program keep its work?

**Lesson ID:** `memory` · **Time:** 10 minutes · **Prerequisite:** [Processes](01-processes.md)

After this lesson, you can describe resident memory, avoid double-counting shared memory, and distinguish the current graph from memory pressure.

## Addresses and physical memory

A process works with a **virtual address space**: addresses for its code and data. The operating system and hardware translate addresses to physical memory. The address space is an abstraction, not a promise that every possible address has a private piece of RAM behind it. [OSTEP: Address Spaces](https://pages.cs.wisc.edu/~remzi/OSTEP/vm-intro.pdf).

For this monitor's first version, the process column answers a narrower question: how many **resident bytes** does the OS report for this process? That value is RSS, resident set size. It is displayed in MiB or GiB: one MiB is 1,048,576 bytes; one GiB is 1,073,741,824 bytes. The [native collector](../../app/src/activity/macos.rs) obtains RSS from `pti_resident_size`; it is not collecting all of the process's virtual addresses or Apple's physical-footprint accounting.

## Shared pages break simple addition

**Example:** Imagine process A has 20 MiB of private resident pages and process B has 30 MiB. Both also map the same 10 MiB of resident pages. A could report 30 MiB RSS and B 40 MiB. Adding those rows gives 70 MiB, while the distinct pages in this simplified example occupy 60 MiB. The shared 10 MiB was counted twice.

This is why the app must label any future subtree RSS total as a sum of process RSS, not exclusive RAM used by the job. The example illustrates accounting; real memory reporting has additional categories and details.

## The graph is wired RAM

The current summary graph plots **wired RAM / physical RAM**. Wired memory must stay in RAM; it is only one part of memory accounting. Apple describes **memory pressure** as a broader assessment using factors including free memory, swap activity, wired memory, and file caching. Our wired graph is not Apple's pressure graph. Compressed memory and free memory are also distinct values. [Apple's memory guide](https://support.apple.com/guide/activity-monitor/view-memory-usage-actmntr1004/mac).

Low free RAM by itself does not establish a problem. A single large RSS value does not establish a leak. A leak is a claim about unwanted retained memory and behavior over time; sorting a snapshot cannot prove that claim.

## Observe memory without allocating anything

1. Open Activity and sort **Resident Memory** from largest to smallest. Select a process with an available value. Note its PID and RSS.
2. Watch several refreshes. Record whether its displayed RSS grows, shrinks, or stays unchanged. All three outcomes are valid.
3. Find the system wired-memory label. Compare what it measures with the selected process's RSS. Do not subtract one from the other as though they partition the same total.
4. Change the scope from **All Processes** to **My Processes**. The row set changes; physical RAM capacity does not. Do not add the displayed rows and call that total system usage.
5. Write one observation and one question. Example: “The selected process reports 340 MiB RSS. I do not know how much is shared.” This statement separates a measurement from missing evidence.

If your process has **—**, choose another or report unavailable data. No live memory growth is required to finish the lesson.

## Check your understanding

1. Two processes each report 100 MiB RSS. Must their distinct physical pages total 200 MiB?
2. Does a wired-memory graph at 25% mean 75% of RAM is free?
3. A process's RSS increases across three samples. Have you proved a leak?
4. A metric is **—**. Should a bar display it as zero?

**Answers:** (1) No; the processes may share pages. (2) No; other memory categories exist. (3) No; the process may be doing useful work or caching. You need a longer, controlled investigation. (4) No; unavailable data needs its own state.

**Your takeaway:** “Name the memory metric before interpreting its size.” Continue with the planned threads, scheduling, and virtual-memory modules in the [curriculum](README.md).
