## session-summary-20260721T103707Z
2026-07-21T10:37:07.9115533-07:00

Session summary (2026-07-21):

Ported an automation fix from the sibling Meal Prep app: a rework retry could silently flip a task's status without changing any code, and a crashed review could leave a task permanently stuck. Fixed here as TASK-001 -- now merged.

Found two new bugs live, here first: your morning digest can silently fail to send once too many proposals pile up (Telegram's 4096-char limit), and a hung automation run held the lock for 48+ minutes today with no visible sign anything was wrong until manually checked (Task Manager, CPU/child-process inspection). Both fixed as TASK-002 -- digest now truncates gracefully with a "+N more" note, stale locks self-clear within 45 min (was 2 hours) with a Telegram notice, and /status now shows how long a lock has actually been held.

Waiting on you:
- /merge TASK-002 then /merge TASK-002 yes
