# Alma Time-Driven Deep Dive -> Maka Plan Reminder PR

Date: 2026-05-29
Owner: kenji
Source project: `/Users/jakevin/alma-re`

## Read Scope

- `docs/19-time-driven.md`: Cron, Heartbeat, Fatigue, Missions, CloudSync, watchdogs, daily reports.
- `readable/main.js`: verified anchors for `croner`, cron storage, service startup, and delivery callbacks.
- Related prior Alma notes in `docs/16-bots.md`, `docs/57-telegram-deep.md`, and existing Maka plan-reminder implementation.

## Alma Details Worth Copying

Alma's scheduler is broader than a reminder feature:

- `jobs.json` stores scheduled jobs, `runs.json` stores run history capped at 100 per job.
- Schedule shape supports `at`, `every`, and `cron`.
- `every` and `cron` have overlap protection: interval jobs skip while already running, cron uses `croner` with `protect: true`.
- Each tick can create a normal AI turn (`source: "cron"`) so scheduled work and external chat messages share the same delivery path.
- Delivery to Telegram/Discord is platform-aware, with a skip filter for "nothing to report".
- Stuck-generation cleanup runs every 60 seconds and force-clears cron threads after timeout.

## Maka Delta

Before this PR, Maka plan reminders were local one-shot reminders only:

- schedule kind was only `{ kind: "once", runAt }`
- after triggering, all reminders became `completed`
- UI had no repeat control

This PR copies the lowest-risk part of Alma first: recurring schedule semantics and run preservation. It intentionally does not copy AI auto-execution or platform delivery yet.

## Implemented In This PR

- Core schedule union:
  - `once`
  - `recurring` with `daily | weekly | monthly`
- Closed recurrence enum and normalizers.
- Next-run calculation:
  - daily and weekly use fixed ms increments
  - monthly clamps impossible dates, e.g. Jan 31 -> Feb 28
- Store behavior:
  - recurring reminders stay `scheduled` after trigger
  - one-shot reminders still complete
  - pause/resume computes the next future occurrence
  - old one-shot persisted reminders remain valid
- UI:
  - new recurrence select: 不重复 / 每天 / 每周 / 每月
  - cards show repeat status
  - empty state no longer says only one-shot explicit time
- Contract tests lock recurrence in the plan UI and IPC/global types.

## Still Deferred

These are useful Alma ideas, but should be separate PRs:

- `PR-PLAN-DELIVERY-0`: deliver reminders to Telegram/Discord after BotPlatformAdapter normalization lands.
- `PR-AUTOMATION-EXECUTOR-0`: AI auto-execution / cron agent turns. Needs permission gate, audit log, incognito block, model readiness, retry policy, and "nothing to report" delivery filters.
- `PR-CRON-SYNTAX-0`: full cron expression and timezone support.
- `PR-RUN-HISTORY-0`: separate run history list capped per reminder instead of only `lastRun`.
- `PR-STUCK-AUTOMATION-WATCHDOG-0`: overlap protection and stuck run cleanup once execution becomes long-running.

