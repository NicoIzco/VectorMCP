---
name: agent-loop-design
description: Guide for designing agent loops - triggers, stop conditions, verification, loop types (turn-based, goal-based, time-based, proactive) and token management
category: engineering
version: 1.0.0
---

# Agent Loop Design Guide

An agent loop is a repeated cycle of work that continues until a stop condition is met. Instead of prompting once and hoping for the best, you design who triggers each cycle, who decides when to stop, and how work is verified.

> Source: adapted from [Getting started with loops](https://claude.com/blog/getting-started-with-loops) by Delba de Oliveira and Michael Segner (Anthropic Claude Code team).

Not every task needs a complex loop. Start with the simplest pattern that fits, then add structure only when the work justifies it.

## Loop types at a glance

| Loop | You hand off | Use it when | Reach for |
| --- | --- | --- | --- |
| Turn-based | The check (verification) | You are exploring or deciding | Custom verification skills |
| Goal-based | The stop condition | You know what done looks like | `/goal` |
| Time-based | The trigger (interval) | Work happens outside your project on a schedule | `/loop`, `/schedule` |
| Proactive | The prompt (routine definition) | Work is recurring and well-defined | Skills + goals + dynamic workflows |

## Turn-based loops

**Trigger:** A user prompt.

**Stop criteria:** The agent judges the task is complete or needs more context from you.

**Best for:** Shorter tasks that are not part of a regular process or schedule.

**How to manage:** Write specific prompts and encode verification steps in skills so the agent can check its own work and reduce unnecessary turns.

Every prompt you send starts a manual loop where you direct each turn. The agent gathers context, takes action, checks its work, repeats if needed, and responds.

**Example:** Ask an agent to add a like button. It reads your code, makes the edit, runs tests, and hands back something it believes works. You manually review and write the next prompt.

Improve verification by encoding your manual review steps in a `SKILL.md`:

```md
---
name: verify-frontend-change
description: Verify any UI change end-to-end before declaring it done.
---

# Verifying frontend changes

Never report a UI change as complete based on a successful edit alone.

1. Start the dev server and open the edited page in the browser.
2. Interact with the change directly — click controls, confirm state changes, screenshot before/after.
3. Check the browser console: zero new errors or warnings.
4. Run a performance trace and audit Core Web Vitals.

If any step fails, fix the issue and rerun from step 1.
```

The more quantitative your checks, the easier it is for the agent to self-verify.

## Goal-based loops (`/goal`)

**Trigger:** A manual prompt in real time.

**Stop criteria:** Goal achieved **or** maximum number of turns reached.

**Best for:** Tasks with verifiable exit criteria.

**How to manage:** Set explicit completion criteria and turn caps (e.g. "stop after 5 tries").

When you define success criteria upfront, the agent does not have to guess what "good enough" means. Each time it tries to stop, an evaluator checks your condition and sends it back to work until the goal is met or the turn budget expires.

Deterministic criteria work best: tests passed, Lighthouse score threshold, empty queue, clean git status.

**Example:**

```
/goal get the homepage Lighthouse score to 90 or above, stop after 5 tries.
```

## Time-based loops (`/loop` and `/schedule`)

**Trigger:** A specified time interval.

**Stop criteria:** You cancel it, or the work completes (PR merges, queue is empty).

**Best for:** Recurring work or interfacing with external systems.

**How to manage:** Set longer intervals or react to events rather than polling constantly.

Some agentic work is recurring — the task stays the same and only the inputs change (e.g. summarizing messages every morning). Other work depends on external systems where checking on an interval and reacting to changes is simpler than event wiring.

**Example:**

```
/loop 5m check my PR, address review comments, and fix failing CI
```

`/loop` runs locally — if your machine is off, it stops. Move durable routines to the cloud with `/schedule`.

## Proactive loops

**Trigger:** An event or schedule, with no human in real time.

**Stop criteria:** Each task exits when its goal is met. The routine itself runs until you turn it off.

**Best for:** Recurring streams of well-defined work: bug reports, issue triage, migrations, dependency upgrades.

**How to manage:** Route routine steps to smaller, faster models; reserve the most capable model for judgment calls.

Compose primitives for long-running work:

1. `/schedule` to run a routine on a cadence
2. `/goal` to define what done looks like
3. Skills to document how to verify results
4. Dynamic workflows to orchestrate parallel agents
5. Auto mode so the routine runs without stopping for permission on every step

**Example:**

```
/schedule every hour: check #project-feedback for bug reports.
/goal: don't stop until every report found this run is triaged, actioned, and responded to.
When fixing a bug, use a workflow to explore three solutions in parallel and have a judge review them.
```

## Maintaining code quality in loops

Loop output quality depends on the system around it:

- **Keep the codebase clean** — agents follow existing patterns and conventions.
- **Give agents a way to verify their own work** — encode what "good" looks like in skills.
- **Make docs easy to reach** — framework and library docs with current best practices.
- **Use a second agent for code review** — fresh context reduces bias from the main agent's reasoning.

When an individual result does not meet the standard, do not just fix that instance — encode the lesson so future iterations improve.

## Token management checklist

Loops should have clear boundaries to control cost:

- [ ] Choose the right primitive and model for the job — smaller tasks do not need multi-agent loops.
- [ ] Define clear success and stop criteria so the agent converges without over-iterating.
- [ ] Pilot on a small slice before a large run — dynamic workflows can spawn many agents.
- [ ] Use scripts for deterministic work — running a script is cheaper than re-deriving steps each time.
- [ ] Match polling intervals to how often the watched thing actually changes.
- [ ] Review usage regularly — track turns, token spend, and per-agent costs; stop agents that are not converging.

## Getting started

Look at work where you are the bottleneck. Ask which piece you could hand off:

1. Can you write the verification check? → Turn-based + verification skill
2. Is the goal clear enough to measure? → Goal-based loop
3. Does the work arrive on a schedule? → Time-based loop
4. Is it recurring and well-defined? → Proactive routine

Run the loop, observe where it stalls or over-reaches, and iterate on the design.
