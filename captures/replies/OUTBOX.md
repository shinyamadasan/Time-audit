## 20260721T1743Z-100-command
2026-07-21T11:04:47.4200352-07:00

TASK-002 is 'status: done' -- /merge only lands HELD red-zone tasks ('status: approved').

  approved = approved but red-zone -> held for you (this is what /merge is for)
  done     = approved and reversible -> already auto-merged, nothing to do
  review   = still waiting on Claude's verdict -- send /review
  codex    = needs rework -- send /go
