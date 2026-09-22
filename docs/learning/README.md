# Inside Your Computer

An introductory computer science course taught through t-bias's Activity Monitor and explorable computer prototype. Started 2026-09-20. This is original course material, not an affiliation with or reproduction of another CS course.

**Delivery status:** the first three lessons are embedded in a native reader, reachable through Learn and process/CPU/memory header help. A native flyable 3D teaching model and 2D alternative connect CPU and RAM to live samples and their lessons. Synthetic controller routing and the native GUI smoke pass; physical-controller flight and accessibility validation remain pending. Progress tracking, contextual sample cards, teaching simulations, and the remaining seven lessons are future work. The [integration plan](integration-plan.md) describes the broader targets.

The learner needs no programming background. Each lesson takes roughly 8–12 minutes: explain one concept, observe it in the monitor, make a prediction, and check an answer. All first-module exercises are read-only. No commands, downloads, account access, or process termination are required. A changing number is something to interpret, not a score to maximize or minimize.

## Learning outcomes

Learners should be able to distinguish a program from a process, explain CPU percentages and sampling, interpret memory without double-counting, follow a terminal job's descendants, and say when a monitor lacks enough evidence to diagnose a slowdown. Later modules connect those observations to scheduling, virtual memory, storage, networks, and energy.

## Curriculum

| Module | Driving question | Observation or exercise | Delivery |
| --- | --- | --- | --- |
| 1. [Processes](01-processes.md) | What is actually running? | Inspect one row; compare My Processes and Active Pane | Complete lesson draft; current monitor |
| 2. [CPU and time](02-cpu-and-time.md) | What does 100% mean? | Watch two samples; calculate a percentage; pause/resume | Complete lesson draft; current monitor |
| 3. [Memory](03-memory.md) | Where does a program keep its work? | Compare resident memory and wired RAM; identify missing evidence | Complete lesson draft; current monitor |
| 4. Threads and scheduling | How can hundreds of tasks share a few cores? | Step through a fictional ready/running/waiting scheduler; compare thread count and CPU | Outline; needs deterministic teaching simulation |
| 5. Families of work | Which processes belong to my terminal job? | Expand a process tree; explain ancestry, reparenting, and uncertain associations | Outline; monitor hierarchy is now available |
| 6. Virtual memory and caches | Why isn't memory a set of exclusive boxes? | Map fictional virtual pages to physical frames; share one frame; explain a page fault | Outline; needs teaching simulation |
| 7. Files and storage | Why can a program be busy while CPU usage is low? | Follow a fictional read through cache and storage; distinguish bytes, bytes/s, latency | Outline; live overlay waits for validated disk collector |
| 8. Networks | What happens when a program waits for a reply? | Trace a fictional request; separate latency, throughput, and connection count | Outline; live overlay waits for validated network collector |
| 9. Responsiveness and energy | Is the busiest process the problem? | Compare fictional bursty and sustained workloads; list evidence before diagnosing | Outline; do not invent Apple's Energy Impact |
| 10. Investigate, then act | What can we conclude and what should we do next? | Write a short evidence report from a provided snapshot; distinguish observation from hypothesis | Outline; read-only capstone; process control taught only after action feature ships |

## Course conventions

- **Live:** a value from the current collector, with its sampling time and unit.
- **Example:** a fixed, invented number used for arithmetic or a thought experiment.
- **Simulation:** an explicitly fictional system the learner can step or reset.
- **Unavailable:** the collector cannot provide a metric; it must not be replaced with a plausible animation.

Lessons stay usable when the machine is quiet, a process disappears, or access is denied. An exercise succeeds when the learner explains what happened; it does not require a particular PID or CPU value. Store only lesson completion and optional answers locally when persistence is implemented. Do not persist process names, paths, or snapshots as a side effect of learning progress.

The 3D computer is an educational map. Its geometry does not reproduce the user's motherboard, and it will not execute a guest operating system. Learners can choose a labeled 2D map and the same lessons without flying. See [world and input design](integration-plan.md#the-explorable-computer).

## Editorial and implementation review

Before embedding a lesson, check its labels and actions against the shipped monitor, test the observational exercise on an idle machine, and review every counter's unit and missing-data behavior. Keep the full lesson and any short contextual card consistent. A contextual card should link to its lesson rather than accumulate a second explanation with different assumptions.

Primary references are linked beside the relevant explanations. Further reading: the authors' freely available [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/) organizes operating systems around virtualization, concurrency, and persistence. Link to those chapters; do not bundle copies of the book.
