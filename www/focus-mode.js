// ══════════════════════════════════════════════════════
// FOCUS MODE — pomodoro, music, blocker, suggestions
// Depends on globals from index.html:
//   entries, settings, reviews, running, ticker, blockStartTime,
//   currentTask, intention, lastTaskForRepeat, timerStartedAt,
//   totalSecs, remaining, dailyCommitment,
//   persist(), syncEntries(), showToast(), resetTimer(),
//   getTodayEntries(), getActivityColor(), toDateKey(), fmtDur(),
//   getBucket(), renderToday(), updateRing(), doPing(),
//   buildHeroSuggestions(), buildSugItem(), syncTimerState(),
//   canonicalizeActivityInput(), _startHeartbeat(), _stopHeartbeat()
// ══════════════════════════════════════════════════════

// ── State ──
let focusModeOn = false;
let focusBlockCountdown = null;

// ── Pomodoro state ──
let pomodoroPhase = 'idle'; // 'idle' | 'work' | 'break'
let pomodoroTimer = null;
let pomodoroRemaining = 0;
let pomodoroWorkMin = 25;
let pomodoroBreakMin = 5;
let pomodoroCount = 0;
let focusStartTime = null;
let pomodoroPhaseStartedAt = null;
let pomodoroWasPaused = false;
let activeFocusLearningPlan = null;
let activeFocusContext = '';
let activeFocusPlanItemId = null; // Plan Linkage V1 — mirrors activeFocusLearningPlan's lifecycle
let activeFocusDailyRoutine = null;
let pendingFocusLearningPlan = null;
let pendingFocusContext = '';
let pendingFocusPlanItemId = null;
let _pomodoroAutoStart = localStorage.getItem('ta3-pomo-auto') === '1';
let _lastFocusSyncAt = 0;
const FOCUS_SYNC_REFRESH_MS = 15000;
let _hudFocusLinkType = 'none'; // Phase 6B.1: 'daily-routine' | 'learning-plan' | 'none' — truthful source, never fabricated
let _focusProducer = null;
let _focusProducerTicker = null;
const _focusCaptureFailures = new Map();

// ── Music state ──
let _focusMusicVolume = parseFloat(localStorage.getItem('ta3-focus-vol') || '0.3');
let _lofiTrackIdx = 0;
let _shuffleMode = localStorage.getItem('ta3-focus-shuffle') === '1';
let _shuffleQueue = [];
let _inBreakMode = false;
let _outroActive = false;

function canonicalFocusActivity(task) {
  const fn = globalThis.canonicalizeActivityInput;
  return typeof fn === 'function' ? fn(task) : String(task || '').trim();
}

function cloneFocusLearningPlanMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const required = ['planId', 'phaseId', 'lessonId', 'stepId'];
  if (required.some(key => typeof value[key] !== 'string' || !value[key].trim())) return null;
  return {
    planId: value.planId,
    phaseId: value.phaseId,
    lessonId: value.lessonId,
    stepId: value.stepId,
    planTitle: String(value.planTitle || ''),
    phaseTitle: String(value.phaseTitle || ''),
    lessonTitle: String(value.lessonTitle || ''),
    stepTitle: String(value.stepTitle || '')
  };
}

function getFocusLearningPlanMetadata() {
  return cloneFocusLearningPlanMetadata(activeFocusLearningPlan);
}

function clearFocusLearningPlanContext() {
  activeFocusLearningPlan = null;
  activeFocusContext = '';
  activeFocusPlanItemId = null;
  activeFocusDailyRoutine = null;
  pendingFocusLearningPlan = null;
  pendingFocusContext = '';
  pendingFocusPlanItemId = null;
  _hudFocusLinkType = 'none';
}

function isFocusSessionRunning() {
  return pomodoroPhase !== 'idle';
}

// ══════════════════════════════════════════════════════
// RELOAD RECOVERY — persist/restore the active Focus session across a
// browser reload. storage.js's persist()/load() already restore a generic
// "ta3-timer" (the away/ping block timer, gated on the `running` flag),
// but Focus/Pomodoro state never sets `running` and was never written
// anywhere — so a reload silently dropped it. This mirrors that same
// pattern, scoped to Focus. Elapsed/remaining is always re-derived from the
// stored absolute pomodoroPhaseStartedAt vs the current wall clock on
// restore — never a second timer.
// ══════════════════════════════════════════════════════
const FOCUS_TIMER_STORAGE_KEY = 'ta3-focus-timer';
const _retainedUnprovenFocusCaches = new Map();
function retainUnprovenFocusCache(raw) {
  _retainedUnprovenFocusCaches.set(accountingIdentity().owner, raw);
}
function renderFocusRecoveryStatus() {
  const panel = document.getElementById('focus-recovery-status'), context = accountingIdentity();
  if (!panel) return;
  const retained = context && _retainedUnprovenFocusCaches.has(context.owner);
  const provisional = context && _focusProducer && TimeAckCore.same(_focusProducer.context, context)
    && !TimeAckCore.same(_focusProducer.frame.focus, captureFocusAccountingFrame());
  panel.hidden = !context || !retained && !provisional && pomodoroPhase === 'idle';
  panel.textContent = (provisional ? 'Provisional Focus — captured on this device, awaiting confirmation.'
    : pomodoroPhase !== 'idle' ? 'Confirmed Focus — restored from authoritative accounting.' : '')
    + (retained ? ' Retained-unproven Focus data remains unchanged. It has not been activated.' : '');
}


// Theoretical max pomodoros achievable in a single day even at the Focus
// settings UI's own minimum work(1min)+break(1min) cycle — index.html
// #pomo-work-min/#pomo-break-min both have min="1". Defensive clamp only:
// no legitimate session ever approaches this; it exists to stop a corrupted
// persisted count from making renderPomoDots() build an unbounded DOM list.
const FOCUS_MAX_POMODORO_COUNT = 720;

// Clock-skew tolerance for a restored pomodoroPhaseStartedAt: a legitimate
// value is never meaningfully in the future, but minor cross-device clock
// drift is real. Anything further ahead than this is treated as corrupt.
const FOCUS_MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

// Set by restoreFocusSession() only; in-memory only, NEVER persisted to
// localStorage (must not survive a reload itself). While true, storage.js's
// applyRemoteTimerState() treats this device's restored ownership claim as
// provisional for exactly one incoming remote timer snapshot instead of
// letting it permanently outrank a takeover that legitimately completed
// while this device was away. A freshly-started (non-restored) Focus
// session never sets this, so its ownership behavior is completely
// unchanged. See applyRemoteTimerState() in storage.js.
let restoredFocusAwaitingSyncReconciliation = false;
// The local timer-sync recency stamp (storage.js's TIMER_SYNC_STAMP_KEY) as
// it stood immediately before restoreFocusSession() made its own outbound
// syncFocusTimerState() push — captured so the one-time reconciliation
// check isn't comparing a remote snapshot against a stamp that restore's
// own push just bumped to "now".
let restoredFocusBaselineSyncStamp = 0;

function captureFocusAccountingFrame() {
  return pomodoroPhase === 'idle' ? null : cloneUndoValue({ v: 1, pomodoroPhase, pomodoroPhaseStartedAt,
    pomodoroWorkMin, pomodoroBreakMin, pomodoroCount, focusStartTime, activeFocusLearningPlan,
    activeFocusContext, activeFocusPlanItemId, activeFocusDailyRoutine, hudFocusLinkType: _hudFocusLinkType });
}

function validateFocusAccountingFrame(focus) {
  if (focus == null) return;
  if (focus.v !== 1 || !['work', 'break'].includes(focus.pomodoroPhase)
    || !Number.isFinite(focus.pomodoroPhaseStartedAt) || focus.pomodoroPhaseStartedAt <= 0
    || !Number.isFinite(focus.pomodoroWorkMin) || focus.pomodoroWorkMin <= 0
    || !Number.isFinite(focus.pomodoroBreakMin) || focus.pomodoroBreakMin <= 0
    || !Number.isSafeInteger(focus.pomodoroCount) || focus.pomodoroCount < 0 || focus.pomodoroCount > FOCUS_MAX_POMODORO_COUNT
    || focus.focusStartTime !== (focus.pomodoroPhase === 'work' ? focus.pomodoroPhaseStartedAt : null)
    || typeof focus.activeFocusContext !== 'string' || !['none', 'daily-routine', 'learning-plan'].includes(focus.hudFocusLinkType)) {
    throw Error('Unreadable Focus accounting checkpoint');
  }
}

function applyFocusAccountingFrame(focus) {
  validateFocusAccountingFrame(focus);
  const samePhase = focus && focus.pomodoroPhase === pomodoroPhase && focus.pomodoroPhaseStartedAt === pomodoroPhaseStartedAt;
  const previousRemaining = pomodoroRemaining;
  if (!focus) {
    const wasActive = pomodoroPhase !== 'idle';
    pomodoroPhase = 'idle'; pomodoroPhaseStartedAt = null; focusStartTime = null; pomodoroRemaining = 0;
    if (wasActive) clearFocusLearningPlanContext();
    return;
  }
  ({ pomodoroPhase, pomodoroPhaseStartedAt, pomodoroWorkMin, pomodoroBreakMin, pomodoroCount,
    focusStartTime, activeFocusLearningPlan, activeFocusContext, activeFocusPlanItemId, activeFocusDailyRoutine } = cloneUndoValue(focus));
  _hudFocusLinkType = focus.hudFocusLinkType;
  pomodoroRemaining = _focusProducer && focusPhaseKey(_focusProducer.frame) === `${currentTask}:${pomodoroPhase}:${pomodoroPhaseStartedAt}`
    ? _focusProducer.remaining : samePhase ? previousRemaining
      : Math.max(0, (pomodoroPhase === 'break' ? pomodoroBreakMin : pomodoroWorkMin) * 60 - Math.floor((Date.now() - pomodoroPhaseStartedAt) / 1000));
}

function focusCompatibilityCache(frame) {
  const f = frame.focus;
  return f ? { pomodoroPhase: f.pomodoroPhase, pomodoroPhaseStartedAt: f.pomodoroPhaseStartedAt,
    pomodoroWorkMin: f.pomodoroWorkMin, pomodoroBreakMin: f.pomodoroBreakMin, pomodoroCount: f.pomodoroCount,
    task: frame.currentTask, learningPlan: f.activeFocusLearningPlan, context: f.activeFocusContext,
    planItemId: f.activeFocusPlanItemId, dailyRoutine: f.activeFocusDailyRoutine,
    hudFocusLinkType: f.hudFocusLinkType, ownerDeviceId: frame.timerOwnerDeviceId || null } : null;
}

function hydrateFocusAccountingFrame(raw, frame, owner) {
  const timer = raw.timer, phase = timer.focusPhase;
  if (!['work', 'break'].includes(phase) || !Number.isFinite(timer.startedAt) || timer.startedAt <= 0
    || !Number.isFinite(timer.intervalSecs) || timer.intervalSecs <= 0 || !timer.ownerDeviceId
    || timer.taskStartTime !== timer.startedAt || timer.blockStartTime !== timer.startedAt) throw Error('focus-source-unproven');
  const known = frame.focus?.pomodoroPhase === phase && frame.focus.pomodoroPhaseStartedAt === timer.startedAt
    && frame.currentTask === timer.lastTask ? frame.focus : null;
  const focus = known || { v: 1, pomodoroPhase: phase, pomodoroPhaseStartedAt: timer.startedAt,
    pomodoroWorkMin: 25, pomodoroBreakMin: 5, pomodoroCount: 0, focusStartTime: phase === 'work' ? timer.startedAt : null,
    activeFocusLearningPlan: null, activeFocusContext: '', activeFocusPlanItemId: null, activeFocusDailyRoutine: null, hudFocusLinkType: 'none' };
  focus[phase === 'work' ? 'pomodoroWorkMin' : 'pomodoroBreakMin'] = timer.intervalSecs / 60;
  frame.focus = focus; frame.running = false; frame._timerStateOwner = owner;
  frame.timerOwnerDeviceId = timer.ownerDeviceId; frame.currentTask = timer.lastTask || 'Focus session';
  frame.lastTaskForRepeat = frame.currentTask; frame.taskStartTime = timer.startedAt; frame.blockStartTime = timer.startedAt;
  frame.timerStartedAt = timer.startedAt; frame.trackingStartedAt = null;
  frame.awayActive = false; frame._awayStateOwner = null; frame.breakActive = false; frame._breakStateOwner = null;
  frame.physicalEntries = cloneUndoValue(raw.entries || {}); frame.serverTimer = cloneUndoValue(timer);
  frame.serverAway = cloneUndoValue(raw.awayState || null); frame.serverBreak = cloneUndoValue(raw.breakState || null);
  return frame;
}

function draftFocusStart(draft, facts, at) {
  draftStoppedTimer(draft, draft.intervalMin);
  draft._timerStateOwner = facts.owner; draft.timerOwnerDeviceId = facts.device;
  draft.currentTask = facts.task; draft.lastTaskForRepeat = facts.task;
  draft.taskStartTime = at; draft.blockStartTime = at; draft.timerStartedAt = at;
  draft.focus = { v: 1, pomodoroPhase: 'work', pomodoroPhaseStartedAt: at, focusStartTime: at,
    pomodoroWorkMin: facts.workMin, pomodoroBreakMin: facts.breakMin, pomodoroCount: facts.count,
    activeFocusLearningPlan: facts.learningPlan || null, activeFocusContext: facts.context || '',
    activeFocusPlanItemId: facts.planItemId || null, activeFocusDailyRoutine: facts.dailyRoutine || null,
    hudFocusLinkType: facts.dailyRoutine ? 'daily-routine' : facts.learningPlan ? 'learning-plan' : 'none' };
}

function focusEntry(tsStart, tsEnd, frame = captureAccountingFrame()) {
  const dur = Math.round((tsEnd - tsStart) / 60000);
  if (dur < 1) return null;
  const entry = { id: tsEnd, ts: tsEnd, tsStart, blockIntervalMin: dur, date: toDateKey(new Date(tsEnd)),
    activity: canonicalFocusActivity(frame.currentTask || 'Deep work'), energy: 'deep', onPlan: true, retro: false };
  if (frame.focus?.activeFocusPlanItemId) entry.planItemId = frame.focus.activeFocusPlanItemId;
  entry.category = getBucket(entry); entry.originalLabel = entry.energy;
  return entry;
}

function draftFocusEntry(draft, entry) {
  if (!entry) return;
  const existing = draft.entries.find(item => item.id === entry.id);
  if (existing && !TimeAckCore.same(EntryPhysicalKeys.content(existing), entry)) throw Error('focus-entry-conflict');
  if (!existing) draft.entries.unshift(cloneUndoValue(entry));
  draft.lastTaskForRepeat = entry.activity;
}

function focusCompletionEffects(focus, entry, full) {
  if (!entry) return [];
  const effects = [];
  if (full && focus.activeFocusDailyRoutine) effects.push({ kind: 'focus-completed', link: focus.activeFocusDailyRoutine, entry });
  const outcome = learningPlanFocusSessionOutcome(focus.activeFocusLearningPlan, entry, entry.tsStart, entry.ts);
  if (outcome) effects.push({ kind: 'focus-learning-outcome', outcome, phaseStartedAt: entry.ts });
  return effects;
}

function draftFocusWorkEnd(after, facts) {
  draftFocusEntry(after, facts.entry);
  after.focus.pomodoroCount++; after.focus.pomodoroPhase = 'break'; after.focus.pomodoroPhaseStartedAt = facts.endedAt;
  after.focus.focusStartTime = null; after.focus.activeFocusLearningPlan = null;
  after.focus.activeFocusContext = ''; after.focus.activeFocusPlanItemId = null; after.focus.activeFocusDailyRoutine = null;
  after.focus.hudFocusLinkType = 'none'; after.taskStartTime = facts.endedAt; after.blockStartTime = facts.endedAt; after.timerStartedAt = facts.endedAt;
}

function focusPhaseKey(frame) {
  return frame.focus ? `${frame.currentTask}:${frame.focus.pomodoroPhase}:${frame.focus.pomodoroPhaseStartedAt}` : null;
}

function stopFocusProducer() {
  clearInterval(_focusProducerTicker);
  _focusProducerTicker = null; _focusProducer = null;
}

function focusCaptureKey(context = accountingIdentity()) {
  return context ? `${context.owner}:${context.device}` : null;
}

function focusCaptureIsPaused() {
  return _focusCaptureFailures.has(focusCaptureKey());
}

function sendFocusCapture(job) {
  const current = accountingIdentity();
  if (!current || !['owner', 'uid', 'device'].every(field => current[field] === job.context[field])) return Promise.resolve(false);
  const pause = error => {
    job.failed = true; job.error = error.message; _focusCaptureFailures.set(focusCaptureKey(job.context), job);
    if (_focusProducer?.context.owner === job.context.owner) {
      _focusProducer.capturePaused = true;
      clearInterval(_focusProducerTicker); _focusProducerTicker = null;
    }
  };
  return stageAccountingObservation(job.name, job.facts, { ...job.options, onCaptureFailure: pause,
    onCaptured(operation, receipt = {}) {
      if (operation.owner !== job.context.owner || operation.device !== job.context.device || job.failed && (operation.at !== job.options.at
        || !TimeAckCore.same(operation.input.observation?.facts, job.facts))) {
        pause(Error('Original Focus event needs resolution')); return;
      }
      job.options.onCaptured?.(operation);
      _focusCaptureFailures.delete(focusCaptureKey(job.context));
      if (receipt.settled) {
        const committed = accountingCoordinator().snapshot().committed;
        if (committed && focusPhaseKey(committed.value) !== focusPhaseKey(_focusProducer?.frame || {})) {
          adoptFocusProducer(committed.value, { restoreAt: Date.now(), parentId: committed.operationId });
        }
      }
    } });
}

function captureFocusObservation(name, facts, options) {
  if (focusCaptureIsPaused()) return Promise.resolve(false);
  return sendFocusCapture({ name, facts: cloneUndoValue(facts), context: cloneUndoValue(accountingIdentity()),
    options: { ...options, producerFrame: cloneUndoValue(options.producerFrame) } });
}

function retryFocusCapture() {
  const job = _focusCaptureFailures.get(focusCaptureKey());
  return job ? sendFocusCapture(job) : Promise.resolve(false);
}

// A captured intent can continue producing only while the confirmed timer is still one of
// its original causal images. A foreign Stop/takeover is evidence to retain, never a new lease.
function focusSourceLease(parentId, frame) {
  const coordinator = accountingCoordinator(), state = coordinator?.snapshot();
  if (!state?.committed) return true;
  const current = state.committed.value;
  if (!parentId || parentId === state.committed.operationId) return !!current.focus
    && current.timerOwnerDeviceId === syncedDeviceId && TimeAckCore.same(frame.focus, current.focus);
  const operations = [...state.queue, ...state.history, ...coordinator.captures(roomCode).map(item => item.captured),
    ...coordinator.failedCaptures(roomCode)];
  const seen = new Set(), images = [];
  while (parentId) {
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    const operation = operations.find(item => item.id === parentId);
    if (!operation || operation.uid !== currentUser.uid || operation.device !== syncedDeviceId) return false;
    if (operation.aliasOf) { parentId = operation.aliasOf; continue; }
    if (operation.input.name !== 'hydrate-accounting' && operation.phase !== 'fenced-reconciled') {
      if (Object.hasOwn(operation.input, 'timerBefore')) images.push(operation.input.timerBefore);
      if (operation.input.observation?.source) images.push(operation.input.observation.source.timer);
      const post = operation.proposal?.patch?.timer;
      if (post?.mode === 'focus' && post.running === true && post.ownerRoom === operation.owner
        && post.ownerDeviceId === operation.device) images.push(post);
    }
    parentId = operation.dependsOn;
  }
  return images.some(timer => TimeAckCore.same(current.serverTimer || null, timer || null));
}

// This private source cursor captures callback facts; it never projects a phase, entry or cache.
// A continuation is installed only after its predecessor fact's synchronous durable readback.
function adoptFocusProducer(frame, { remaining = null, restoreAt = null, continuation = false, parentId = null } = {}) {
  const context = accountingIdentity();
  try { validateAccountingFrame(frame, context?.owner); }
  catch { stopFocusProducer(); return; }
  if (!frame.focus || frame.timerOwnerDeviceId !== syncedDeviceId || !accountingIdentity()
    || !focusSourceLease(parentId, frame)) { stopFocusProducer(); return; }
  const phases = continuation && _focusProducer ? new Set(_focusProducer.phases) : new Set();
  phases.add(focusPhaseKey(frame));
  const focus = frame.focus, duration = (focus.pomodoroPhase === 'break' ? focus.pomodoroBreakMin : focus.pomodoroWorkMin) * 60;
  _focusProducer = { context: cloneUndoValue(accountingIdentity()), frame: cloneUndoValue(frame), phases,
    remaining: remaining ?? (restoreAt == null ? duration : Math.max(0, duration - Math.floor((restoreAt - focus.pomodoroPhaseStartedAt) / 1000))),
    waitingLearning: false, restoreAt, parentId };
  if (!_focusProducerTicker) {
    _focusProducerTicker = setInterval(tickPomodoro, 1000);
  }
}

function tickFocusProducer() {
  const producer = _focusProducer;
  if (!producer || !TimeAckCore.same(producer.context, accountingIdentity())
    || !focusSourceLease(producer.parentId, producer.frame)) { stopFocusProducer(); return; }
  if (window._accountingLegacyLoadError || focusCaptureIsPaused() || producer.waitingLearning || accountingPendingStop()) return;
  producer.remaining = Math.max(0, producer.remaining - 1);
  if (focusPhaseKey(producer.frame) === `${currentTask}:${pomodoroPhase}:${pomodoroPhaseStartedAt}`) pomodoroRemaining = producer.remaining;
  if (producer.remaining <= 0) {
    if (producer.frame.focus.pomodoroPhase === 'work') endWorkSession({ producer });
    else endPomodoroBreak({ producer });
  }
}

function capturedFocusFrame(operation, base) {
  const input = operation.input, result = cloneUndoValue(base);
  if (input.name.startsWith('focus-') && input.after) return focusSourceLease(operation.id, { ...result, ...input.after })
    ? { ...result, ...cloneUndoValue(input.after) } : result;
  const facts = input.observation?.facts;
  if (!facts || !result.focus || result.focus.pomodoroPhase !== facts.phase
    || result.focus.pomodoroPhaseStartedAt !== facts.phaseStartedAt) return result;
  if (input.name === 'focus-end-work') draftFocusWorkEnd(result, facts);
  else if (input.name === 'focus-end-break' && facts.next) draftFocusStart(result, facts.next, operation.at);
  else if (['focus-end-break', 'focus-learning-finish'].includes(input.name)) { result.focus = null; draftStoppedTimer(result, result.intervalMin); }
  return result;
}

function restoreFocusProducer(state, coordinator, at) {
  let frame = cloneUndoValue(state.committed.value);
  let parentId = state.committed.operationId;
  const operations = [...state.queue, ...coordinator.captures(roomCode).map(item => item.captured)]
    .filter(operation => operation.input.name !== 'hydrate-accounting');
  const resolved = new Set(state.history.map(operation => operation.id)), pending = [...operations];
  while (pending.length) {
    const index = pending.findIndex(operation => !operation.dependsOn || resolved.has(operation.dependsOn));
    if (index < 0) { stopFocusProducer(); return; }
    const operation = pending.splice(index, 1)[0];
    if (operation.uid !== currentUser.uid || operation.device !== syncedDeviceId || operation.phase === 'cancelling') { stopFocusProducer(); return; }
    frame = capturedFocusFrame(operation, frame); resolved.add(operation.id); parentId = operation.id;
  }
  adoptFocusProducer(frame, { restoreAt: at, parentId });
  const producer = _focusProducer;
  if (producer && state.effects?.some(effect => effect.kind === 'focus-learning-outcome'
    && effect.phaseStartedAt === producer.frame.focus.pomodoroPhaseStartedAt)) producer.waitingLearning = true;
  if (!producer || producer.remaining > 0) return;
  if (producer.waitingLearning) return;
  if (producer.frame.focus.pomodoroPhase === 'work') endWorkSession({ producer, at, restoring: true });
  // Original restore completes both already elapsed phases at this same invocation, never at ACK.
  const next = _focusProducer;
  if (next && !next.waitingLearning && next.frame.focus.pomodoroPhase === 'break') {
    const duration = next.frame.focus.pomodoroBreakMin * 60;
    next.remaining = Math.max(0, duration - Math.floor((at - next.frame.focus.pomodoroPhaseStartedAt) / 1000));
    if (next.remaining <= 0) endPomodoroBreak({ producer: next, at });
  }
}

function prepareFocusAccountingObservation(operation, raw, before) {
  const facts = operation.input.observation.facts, focus = before.focus;
  if (!focus || raw.timer?.ownerDeviceId !== operation.device || raw.timer?.ownerRoom !== operation.owner
    || focus.pomodoroPhase !== facts.phase || focus.pomodoroPhaseStartedAt !== facts.phaseStartedAt) {
    return { status: 'conflict', reason: 'focus-session-changed' };
  }
  const after = cloneUndoValue(before);
  let effects = [];
  if (operation.input.name === 'focus-end-work') {
    effects = focusCompletionEffects(focus, facts.entry, true);
    draftFocusWorkEnd(after, facts);
  } else if (operation.input.name === 'focus-end-break' && facts.next) draftFocusStart(after, facts.next, operation.at);
  else if (['focus-end-break', 'focus-learning-finish'].includes(operation.input.name)) {
    after.focus = null; draftStoppedTimer(after, after.intervalMin);
  } else return { status: 'conflict', reason: 'unsupported-focus-observation' };
  return buildAccountingInput(operation.input.name, before, after, { timer: true, at: operation.at, effects,
    extra: after.focus ? {} : { stopped: true, mode: 'focus', lastTask: null } });
}

let _focusEffectDelivery = null;
function runFocusAccountingEffects() {
  if (_focusEffectDelivery) return _focusEffectDelivery;
  const coordinator = accountingCoordinator();
  if (!coordinator || !coordinator.snapshot().effects?.length) return Promise.resolve(true);
  const source = cloneUndoValue(accountingIdentity());
  _focusEffectDelivery = coordinator.runEffects((effect, committed) => {
    if (effect.kind === 'focus-started') {
      if (committed.focus?.pomodoroPhaseStartedAt !== effect.startedAt) return { superseded: true };
      if (typeof globalThis.onDailyRoutineFocusStarted !== 'function') return false;
      return globalThis.onDailyRoutineFocusStarted(effect.link, effect.startedAt);
    }
    if (effect.kind === 'focus-completed') {
      if (typeof globalThis.onDailyRoutineFocusCompleted !== 'function') return false;
      return globalThis.onDailyRoutineFocusCompleted(effect.entry, effect.entry.tsStart, effect.entry.ts, effect.link);
    }
    if (effect.kind === 'focus-learning-outcome') {
      if (typeof globalThis.onLearningPlanFocusSessionEnded !== 'function') return false;
      const handled = globalThis.onLearningPlanFocusSessionEnded(effect.outcome) !== false;
      if (!TimeAckCore.same(source, accountingIdentity())) return false;
      if (handled && committed.focus?.pomodoroPhase === 'break'
        && committed.focus.pomodoroPhaseStartedAt === effect.phaseStartedAt) {
        // Capture synchronously while delivering the effect; do not await the account lock recursively.
        const eventKey = `focus-learning-finish:${effect.operationId}`;
        let captured = [...coordinator.snapshot().history, ...coordinator.snapshot().queue, ...coordinator.captures(source.owner).map(item => item.captured)]
          .some(operation => operation.eventKey === eventKey);
        stageAccountingObservation('focus-learning-finish', { phase: 'break', phaseStartedAt: effect.phaseStartedAt,
          completionEffect: effect.id, handled: true }, { at: effect.at, eventKey, predecessor: effect.operationId,
          onCaptured() { captured = true; stopFocusProducer(); } });
        if (!captured) return false;
      }
      return { handled };
    }
    return false;
  }).then(result => {
    if (!TimeAckCore.same(source, accountingIdentity())) return false;
    const state = coordinator.snapshot(), producer = _focusProducer;
    if (producer?.waitingLearning) {
      const receipt = Object.values(state.effectReceipts || {}).find(item => item.outcome?.handled === false
        && state.history.find(operation => operation.id === item.operationId)?.proposal?.effects?.some(effect =>
          effect.kind === 'focus-learning-outcome' && effect.phaseStartedAt === producer.frame.focus.pomodoroPhaseStartedAt));
      if (receipt) {
        producer.waitingLearning = false;
        if (producer.restoreAt != null) {
          producer.remaining = Math.max(0, producer.frame.focus.pomodoroBreakMin * 60
            - Math.floor((producer.restoreAt - producer.frame.focus.pomodoroPhaseStartedAt) / 1000));
          if (producer.remaining <= 0) endPomodoroBreak({ producer, at: producer.restoreAt });
        }
      }
    }
    if (!result.retained) requestAccountingRefresh();
    return !result.retained;
  }).catch(error => {
    console.warn('[accounting] Focus effect retained', error.message); return false;
  }).finally(() => { _focusEffectDelivery = null; renderTimeAckStatus(); });
  return _focusEffectDelivery;
}

function materializeFocusAccountingFrame(focus, previous, receipt) {
  if (!focus) {
    if (_focusProducer && !focusSourceLease(_focusProducer.parentId, _focusProducer.frame)) stopFocusProducer();
    if (previous) {
      stopFocusProducer(); clearInterval(pomodoroTimer); pomodoroTimer = null;
      _stopHeartbeat(); pushHudFocusEnded();
      if (receipt?.effectName === 'focus-end-break') {
        _exitBreakMusic(); playAlertSound();
        document.getElementById('focus-phase-label').textContent = 'BREAK DONE';
        document.getElementById('focus-phase-sub').textContent = 'ready for the next one?';
        document.getElementById('focus-settings-row').style.display = 'flex';
        document.getElementById('focus-task-input').style.display = 'block';
        document.getElementById('focus-intention-text').style.display = 'none';
        const button = document.getElementById('focus-start-btn');
        button.textContent = 'Start next session'; button.onclick = startPomodoro; button.style.display = 'block';
        setPomodoroCountdown(pomodoroWorkMin * 60);
      } else {
        stopFocusMusic(); focusModeOn = false;
        document.getElementById('focus-overlay')?.classList.remove('open');
      }
    }
    persistFocusSession(); queueMicrotask(runFocusAccountingEffects); return false;
  }
  const frame = captureAccountingFrame();
  if (timerOwnerDeviceId === syncedDeviceId) {
    if (accountingPendingStop()) stopFocusProducer();
    else if (!_focusProducer || !TimeAckCore.same(_focusProducer.context, accountingIdentity()) || !_focusProducer.phases.has(focusPhaseKey(frame))) {
      adoptFocusProducer(frame, { restoreAt: Date.now() });
    }
  } else {
    stopFocusProducer();
    pomodoroRemaining = Math.max(0, (focus.pomodoroPhase === 'break' ? focus.pomodoroBreakMin : focus.pomodoroWorkMin) * 60
      - Math.floor((Date.now() - focus.pomodoroPhaseStartedAt) / 1000));
  }
  focusModeOn = true;
  document.getElementById('focus-overlay')?.classList.add('open');
  const input = document.getElementById('focus-task-input'); input.value = currentTask; input.style.display = 'none';
  const intentionEl = document.getElementById('focus-intention-text'); intentionEl.textContent = currentTask; intentionEl.style.display = 'block';
  document.getElementById('focus-settings-row').style.display = 'none';
  document.getElementById('focus-phase-label').textContent = focus.pomodoroPhase === 'work' ? 'FOCUS' : 'BREAK ☕';
  document.getElementById('focus-phase-sub').textContent = focus.pomodoroPhase === 'work'
    ? focusPhaseSubText(pomodoroWorkMin) : `take a breather · ${pomodoroBreakMin} min`;
  const button = document.getElementById('focus-start-btn');
  button.textContent = 'Skip break'; button.onclick = skipBreak;
  button.style.display = focus.pomodoroPhase === 'break' && timerOwnerDeviceId === syncedDeviceId ? 'block' : 'none';
  if (receipt?.effectName === 'focus-end-work') { _enterBreakMusic(); playAlertSound(); }
  renderPomoDots(); updateFocusDeepBar(); setPomodoroCountdown(pomodoroRemaining); pushHudFocusState();
  persistFocusSession(); queueMicrotask(runFocusAccountingEffects);
  clearInterval(pomodoroTimer); pomodoroTimer = setInterval(renderFocusCountdown, 1000);
  return true;
}

function persistFocusSession() {
  if (window._accountingLegacyLoadError || !accountingIdentity()) return false;
  const frame = accountingCoordinator()?.snapshot().committed?.value;
  if (!frame || !TimeAckCore.same(frame.focus, captureFocusAccountingFrame())) return false;
  if (_retainedUnprovenFocusCaches.has(accountingIdentity().owner)) return false;
  const saved = focusCompatibilityCache(frame);
  if (saved) setAccountLocal(FOCUS_TIMER_STORAGE_KEY, JSON.stringify(saved));
  else removeAccountLocal(FOCUS_TIMER_STORAGE_KEY);
  return true;
}

function clearPersistedFocusSession() {
  if (!persistFocusSession()) return false;
  restoredFocusAwaitingSyncReconciliation = false;
  restoredFocusBaselineSyncStamp = 0;
  return true;
}

/** Account detach changes runtime only; the original owner's envelope/cache remains intact. */

function detachFocusSessionForAccountSwitch() {
  stopFocusProducer();
  if (pomodoroPhase === 'idle' && !focusModeOn) return;
  clearInterval(pomodoroTimer);
  pomodoroTimer = null;
  pomodoroPhase = 'idle';
  pomodoroPhaseStartedAt = null;
  pomodoroRemaining = 0;
  pomodoroWasPaused = false;
  restoredFocusAwaitingSyncReconciliation = false;
  restoredFocusBaselineSyncStamp = 0;
  stopFocusMusic();
  focusModeOn = false;
  document.getElementById('focus-overlay')?.classList.remove('open');
  clearFocusLearningPlanContext();
  pushHudFocusEnded();
}

// Reconstructs an active Focus session from persisted state after a reload.
// Never fabricates a session: a missing/corrupt/incomplete record, or a
// session already active in memory, leaves Focus untouched — it restores
// identity, it never starts a new one. When the persisted phase's planned
// duration already elapsed while the app was closed, it calls the exact
// same endWorkSession()/endPomodoroBreak() the running tab would have
// called, once, instead of inventing a parallel recovery path.
function restoreFocusSession() {
  const at = Date.now();
  const coordinator = accountingCoordinator(), committed = coordinator?.snapshot().committed;
  if (committed) {
    try { retainUnconfirmedCompatibilityCaches(coordinator); validateFocusAccountingFrame(committed.value.focus); }
    catch (error) {
      stopFocusProducer();
      if (!error.accountingStorageRead) window._accountingLegacyLoadError = 'focus-cache-unreadable';
      console.warn('[accounting] Focus cache retained', error.message); return false;
    }
    applyFocusAccountingFrame(committed.value.focus);
    restoreFocusProducer(coordinator.snapshot(), coordinator, at);
    materializeFocusAccountingFrame(committed.value.focus, null, { ...committed, effectName: 'focus-restored' });
    requestAccountingRefresh();
    return !!committed.value.focus;
  }
  // A legacy per-key Focus cache is evidence, not independent publication authority.
  requestAccountingRefresh();
  return false;
}

function focusContextText(metadata) {
  return [metadata?.planTitle, metadata?.phaseTitle, metadata?.lessonTitle]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' · ');
}

function focusPhaseSubText(workMin) {
  return activeFocusContext
    ? `${activeFocusContext} · ${workMin} min`
    : `work session · ${workMin} min`;
}

function learningPlanFocusSessionOutcome(metadata, entry, tsStart, tsEnd) {
  if (!metadata || !entry) return null;
  return {
    ...cloneFocusLearningPlanMetadata(metadata),
    focusEntryId: entry.id,
    focusActivity: entry.activity,
    focusStartedAt: tsStart,
    focusEndedAt: tsEnd,
    focusDurationMin: entry.blockIntervalMin
  };
}

function notifyLearningPlanFocusSessionEnded(entry, tsStart, tsEnd) {
  const metadata = cloneFocusLearningPlanMetadata(activeFocusLearningPlan);
  const outcome = learningPlanFocusSessionOutcome(metadata, entry, tsStart, tsEnd);
  if (!outcome || typeof globalThis.onLearningPlanFocusSessionEnded !== 'function') return false;
  try {
    return globalThis.onLearningPlanFocusSessionEnded(outcome) !== false;
  } catch (err) {
    showToast(`Learning Plan outcome unavailable: ${err.message || err}`);
    return false;
  }
}

function finishLearningPlanFocusSession() {
  if (pomodoroPhase !== 'break' || timerOwnerDeviceId !== syncedDeviceId) return Promise.resolve(false);
  return stageAccountingObservation('focus-learning-finish', { phase: 'break', phaseStartedAt: pomodoroPhaseStartedAt },
    { eventKey: `focus-learning-finish:${timerStateOwnerRoom()}:${pomodoroPhaseStartedAt}`, onCaptured: stopFocusProducer });
}

// Audio served from GitHub Pages — not bundled in APK (keeps APK ~12MB)
const _AUDIO_BASE = 'https://shinyamadasan.github.io/Time-audit/Sounds/';
const _BREAK_TRANSITION = _AUDIO_BASE + 'natureseye-trapped-introoutro-144328.mp3';
const _BREAK_LOOP       = _AUDIO_BASE + 'nickpanekaiassets-atom-bomb-jig-energetic-big-band-swing-instrumental-318351.mp3';
const _OUTRO_LEAD_SEC   = 19;

// ── Suggestions state ──
let _focusSugIndex = -1;

// ── Lo-fi track list ──
const _LOFI_TRACKS = [
  'focus.mp3',
  'pulsebox-lofi-melody-522894.mp3',
  'pulsebox-lofi-production-522875.mp3',
  'the_mountain-lofi-lofi-music-496553.mp3',
  'pulsebox-lofi-vlog-522887.mp3',
  'pulsebox-lofi-slow-522877.mp3',
  'pulsebox-lofi-drums-522891.mp3',
  'watermello-lofi-lofi-girl-lofi-chill-484610.mp3',
  'pulsebox-lofi-blog-522886.mp3',
  'pulsebox-lofi-cinematic-522892.mp3',
  'watermello-lofi-chill-lofi-girl-lofi-488388.mp3',
  'mondamusic-lofi-lofi-girl-lofi-chill-512853.mp3',
  'pulsebox-lofi-study-522878.mp3',
  'pulsebox-lofi-night-522890.mp3',
  'pulsebox-lofi-smooth-522876.mp3',
  'pulsebox-lofi-retro-522893.mp3',
  'fassounds-lofi-study-calm-peaceful-chill-hop-112191.mp3',
  'fassounds-good-night-lofi-cozy-chill-music-160166.mp3',
  'pulsebox-lofi-ambient-522898.mp3',
  'pulsebox-lofi-video-522883.mp3',
  'pulsebox-lofi-chill-522885.mp3',
  'lemonmusiclab-lofi-lofi-music-499264.mp3',
  'leberch-lofi-hip-hop-519408.mp3',
  'pulsebox-lofi-mellow-522897.mp3',
  'pulsebox-lofi-vinyl-522882.mp3',
  'pulsebox-lofi-instrumental-522889.mp3',
  'monume-lofi-lofi-girl-lofi-chill-509453.mp3',
  'mondamusic-lofi-beats-499181.mp3',
  'monume-lofi-lofi-girl-lofi-chill-519232.mp3',
  'leberch-lofi-516620.mp3',
  'pulsebox-lofi-atmosphere-522881.mp3',
  'pulsebox-lofi-cozy-522874.mp3',
  'pulsebox-lofi-walking-522873.mp3',
  'pulsebox-lofi-hip-hop-522884.mp3',
  'pulsebox-lofi-calm-522888.mp3',
  'atlasaudio-sad-lofi-516966.mp3',
  'mondamusic-lofi-chill-lofi-girl-491690.mp3',
  'freemusicforvideo-lofi-chill-music-495628.mp3',
  'bfcmusic-lofi-lo-fi-511230.mp3',
  'playstarz_music-lofi-chill-lofi-girl-lofi-490880.mp3',
  'solarflex-lofi-lofi-girl-lofi-chill-515513.mp3',
  'mondamusic-lofi-chill-491719.mp3',
  'vibehorn-lofi-beat-lo-fi-music-512500.mp3',
  'vibehorn-lofi-chill-music-496931.mp3',
  'mondamusic-lofi-chill-chill-512854.mp3',
  'lofi_music_library-lofi-girl-chill-lofi-beats-lofi-ambient-461871.mp3',
  'paulyudin-lofi-lofi-chill-lofi-girl-482399.mp3',
  'sonican-lo-fi-music-loop-sentimental-jazzy-love-473154.mp3',
  'monume-lofi-chill-chill-509496.mp3',
  'mondamusic-lofi-chill-487321.mp3',
  'lofi_music_library-coffee-lofi-chill-lofi-ambient-458901.mp3',
  'lofi_music_library-coffee-lofi-lofi-music-chill-ambient-458900.mp3',
  'delosound-lofi-lofi-chill-lofi-girl-466467.mp3',
  'aventure-lofi-chill-nostalgic-469629.mp3',
].map(f => _AUDIO_BASE + f);

// ══════════════════════════════════════════════════════
// POMODORO CORE
// ══════════════════════════════════════════════════════

function updateFocusDeepBar() {
  const todayE = getTodayEntries().filter(e => !e.missed);
  const deepBlocks = todayE.filter(e => e.energy === 'deep').length;
  const goal = dailyCommitment || settings.deepGoal || 8;
  const pct = Math.min(100, Math.round((deepBlocks / goal) * 100));
  document.getElementById('focus-deep-label').textContent = `${deepBlocks} / ${goal} blocks`;
  document.getElementById('focus-deep-bar').style.width = pct + '%';
}

function renderPomoDots() {
  const container = document.getElementById('focus-pomo-dots');
  const total = Math.max(4, pomodoroCount + (4 - pomodoroCount % 4 === 4 ? 0 : 4 - pomodoroCount % 4));
  container.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const d = document.createElement('div');
    d.style.cssText = `width:9px;height:9px;border-radius:50%;background:${i < pomodoroCount ? 'var(--deep)' : 'var(--bg3)'};transition:background 0.3s`;
    container.appendChild(d);
  }
}

function setPomodoroCountdown(secs) {
  const m = Math.floor(secs / 60), s = secs % 60;
  document.getElementById('focus-countdown').textContent =
    `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function syncFocusTimerState() {
  // Shared timer publication belongs to the phase command; refresh only reads confirmed state.
  return requestAccountingRefresh();
}

function refreshFocusTimerSync(force = false) {
  if (!force && Date.now() - _lastFocusSyncAt < FOCUS_SYNC_REFRESH_MS) return false;
  _lastFocusSyncAt = Date.now();
  requestAccountingRefresh(); runFocusAccountingEffects();
  return true;
}

// Phase 6B.1 — Windows Ambient Focus HUD projection. Purely additive: reflects
// whatever focus-mode.js already decided, creates no state of its own. A
// no-op if windows-hud-bridge.js hasn't loaded or no companion is running.
function pushHudFocusState(startedAtOverride) {
  const bridge = globalThis.chronaSenseHudBridge;
  if (!bridge || typeof bridge.pushActive !== 'function') return;
  const startedAt = startedAtOverride || pomodoroPhaseStartedAt || focusStartTime || Date.now();
  const intervalSecs = (pomodoroPhase === 'break' ? pomodoroBreakMin : pomodoroWorkMin) * 60;
  bridge.pushActive({
    title: getFocusTaskLabel(),
    phase: pomodoroPhase,
    startedAt,
    plannedEndAt: startedAt + intervalSecs * 1000,
    linkType: _hudFocusLinkType,
    deviceOwned: timerOwnerDeviceId === syncedDeviceId
  });
}

function pushHudFocusEnded() {
  const bridge = globalThis.chronaSenseHudBridge;
  if (bridge && typeof bridge.pushEnded === 'function') bridge.pushEnded();
}

function isSyncedFocusMirrorActive() {
  return !!(syncedFocusTimer
    && syncedFocusTimer.running
    && syncedFocusTimer.ownerDeviceId
    && syncedFocusTimer.ownerDeviceId !== syncedDeviceId);
}

function renderSyncedFocusOverlay() {
  if (!isSyncedFocusMirrorActive()) return false;
  const phase = syncedFocusTimer.focusPhase === 'break' ? 'break' : 'work';
  const intervalSecs = Math.max(1, Number(syncedFocusTimer.intervalSecs || totalSecs || 1500));
  const elapsed = Math.max(0, Math.floor((Date.now() - syncedFocusTimer.startedAt) / 1000));
  const remainingSecs = Math.max(0, intervalSecs - elapsed);

  pomodoroPhase = phase;
  pomodoroPhaseStartedAt = syncedFocusTimer.startedAt;
  pomodoroRemaining = remainingSecs;
  if (phase === 'break') pomodoroBreakMin = Math.max(1, Math.round(intervalSecs / 60));
  else pomodoroWorkMin = Math.max(1, Math.round(intervalSecs / 60));

  const taskInput = document.getElementById('focus-task-input');
  if (taskInput) taskInput.style.display = 'none';
  const intentionEl = document.getElementById('focus-intention-text');
  if (intentionEl) {
    intentionEl.textContent = syncedFocusTimer.task || currentTask || 'Focus session';
    intentionEl.style.display = 'block';
  }
  const labelEl = document.getElementById('focus-phase-label');
  if (labelEl) labelEl.textContent = phase === 'break' ? 'BREAK' : 'FOCUS';
  const subEl = document.getElementById('focus-phase-sub');
  if (subEl) subEl.textContent = `${syncedFocusTimer.deviceName || 'other device'} synced · ${phase} session`;
  const settingsRow = document.getElementById('focus-settings-row');
  if (settingsRow) settingsRow.style.display = 'none';
  const startBtn = document.getElementById('focus-start-btn');
  if (startBtn) startBtn.style.display = 'none';
  setPomodoroCountdown(remainingSecs);
  renderPomoDots();
  updateFocusDeepBar();
  return true;
}

function syncFocusOverlayFromRemote() {
  if (!renderSyncedFocusOverlay()) return false;
  if (document.getElementById('focus-overlay')?.classList.contains('open')) {
    clearInterval(pomodoroTimer);
    pomodoroTimer = setInterval(renderSyncedFocusOverlay, 1000);
  }
  return true;
}

function clearSyncedFocusOverlay() {
  if (!document.getElementById('focus-overlay')?.classList.contains('open')) return false;
  if (isSyncedFocusMirrorActive()) return false;
  clearInterval(pomodoroTimer);
  pomodoroTimer = null;
  pomodoroPhase = 'idle';
  pomodoroPhaseStartedAt = null;
  const taskInput = document.getElementById('focus-task-input');
  if (taskInput) {
    taskInput.value = '';
    taskInput.style.display = 'block';
  }
  document.getElementById('focus-intention-text').style.display = 'none';
  document.getElementById('focus-phase-label').textContent = 'POMODORO';
  document.getElementById('focus-phase-sub').textContent = 'set your timer and go';
  document.getElementById('focus-settings-row').style.display = 'flex';
  const startBtn = document.getElementById('focus-start-btn');
  startBtn.textContent = 'Start';
  startBtn.onclick = startPomodoro;
  startBtn.style.display = 'block';
  setPomodoroCountdown(pomodoroWorkMin * 60);
  return true;
}

async function takeOverSyncedFocusTimer() {
  if (!captureFocusAccountingFrame() || timeAckBlocks('Taking over Focus')) return false;
  return stageAccountingChange('focus-takeover', draft => {
    draft.timerOwnerDeviceId = syncedDeviceId;
  }, { timer: true, extra: { takeover: true }, onCaptured(operation) {
    adoptFocusProducer({ ...captureAccountingFrame(), ...operation.input.after }, { restoreAt: operation.at, parentId: operation.id });
  } });
}

async function startPomodoro(options = {}) {
  if (pomodoroPhase !== 'idle' || timeAckBlocks('Starting Focus')) return false;
  const owner = accountingIdentity();
  if (!owner) { showToast('Sign in before starting Focus'); return false; }
  const taskInput = document.getElementById('focus-task-input');
  const task = canonicalFocusActivity(options.task || taskInput.value.trim());
  if (!task) {
    taskInput.classList.add('focus-task-error'); taskInput.placeholder = 'Name your focus session first'; taskInput.focus();
    setTimeout(() => { taskInput.classList.remove('focus-task-error'); taskInput.placeholder = 'What are you focusing on?'; }, 2000);
    return false;
  }
  const learningPlan = cloneFocusLearningPlanMetadata(options.learningPlan || pendingFocusLearningPlan);
  const facts = { owner: owner.owner, device: owner.device, task, count: pomodoroCount,
    workMin: parseInt(document.getElementById('pomo-work-min').value) || 25,
    breakMin: parseInt(document.getElementById('pomo-break-min').value) || 5,
    learningPlan, context: String(options.context || pendingFocusContext || focusContextText(learningPlan) || '').trim(),
    planItemId: options.planItemId || pendingFocusPlanItemId || null, dailyRoutine: cloneUndoValue(options.dailyRoutine || null) };
  if (facts.workMin <= 0 || facts.breakMin <= 0) return false;
  const at = Date.now(), effects = facts.dailyRoutine ? [{ kind: 'focus-started', link: facts.dailyRoutine, startedAt: at }] : [];
  const accepted = await stageAccountingChange('focus-start', draft => {
    if (draft.running || draft.awayActive || draft.breakActive || draft.focus) return false;
    draftFocusStart(draft, facts, at);
  }, { timer: true, at, effects, onCaptured(operation) { adoptFocusProducer({ ...captureAccountingFrame(), ...operation.input.after }, { parentId: operation.id }); } });
  if (!accepted) return false;
  pendingFocusLearningPlan = null; pendingFocusContext = ''; pendingFocusPlanItemId = null;
  await runFocusAccountingEffects();
  return true;
}

function getFocusTaskLabel() {
  const label = document.getElementById('focus-intention-text')?.textContent?.trim();
  return (label && label !== '—') ? label : (currentTask || intention || 'Deep work');
}

function tickPomodoro() {
  tickFocusProducer();
  renderFocusCountdown();
}

function renderFocusCountdown() {
  if (pomodoroPhase === 'idle') return;
  if (_focusProducer && focusPhaseKey(_focusProducer.frame) === `${currentTask}:${pomodoroPhase}:${pomodoroPhaseStartedAt}`) pomodoroRemaining = _focusProducer.remaining;
  else if (timerOwnerDeviceId !== syncedDeviceId) pomodoroRemaining = Math.max(0,
    (pomodoroPhase === 'break' ? pomodoroBreakMin : pomodoroWorkMin) * 60 - Math.floor((Date.now() - pomodoroPhaseStartedAt) / 1000));
  setPomodoroCountdown(pomodoroRemaining); refreshFocusTimerSync();
  if (timerOwnerDeviceId === syncedDeviceId && pomodoroPhase === 'work' && pomodoroRemaining === _OUTRO_LEAD_SEC) _startWorkOutro();
}

function endWorkSession({ producer = _focusProducer, at = Date.now(), restoring = false } = {}) {
  const frame = producer?.frame || captureAccountingFrame(), focus = frame.focus;
  if (!focus || focus.pomodoroPhase !== 'work' || frame.timerOwnerDeviceId !== syncedDeviceId || accountingPendingStop()) return Promise.resolve(false);
  const tsStart = Number.isFinite(focus.focusStartTime) ? focus.focusStartTime : focus.pomodoroPhaseStartedAt;
  const endedAt = tsStart + focus.pomodoroWorkMin * 60000, entry = focusEntry(tsStart, endedAt, frame);
  const facts = { phase: 'work', phaseStartedAt: focus.pomodoroPhaseStartedAt, endedAt, entry };
  return captureFocusObservation('focus-end-work', facts, { at, producerFrame: frame, predecessor: producer?.parentId,
    eventKey: `focus-end-work:${frame._timerStateOwner}:${focus.pomodoroPhaseStartedAt}:${endedAt}`,
    onCaptured(operation) {
      const original = operation.input.observation;
      const next = { ...captureAccountingFrame(), ...cloneUndoValue(original.frame) };
      draftFocusWorkEnd(next, original.facts);
      adoptFocusProducer(next, { continuation: true, restoreAt: restoring ? at : null, parentId: operation.id });
      // Learning's existing completion hook chooses whether a Break exists. Keep that branch held.
      if (original.facts.entry && original.frame.focus.activeFocusLearningPlan && _focusProducer) _focusProducer.waitingLearning = true;
    } });
}

function endPomodoroBreak({ producer = _focusProducer, at = Date.now() } = {}) {
  const frame = producer?.frame || captureAccountingFrame(), focus = frame.focus;
  if (!focus || focus.pomodoroPhase !== 'break' || frame.timerOwnerDeviceId !== syncedDeviceId || accountingPendingStop()
    || producer?.waitingLearning) return Promise.resolve(false);
  const next = _pomodoroAutoStart ? { owner: frame._timerStateOwner, device: syncedDeviceId, task: frame.currentTask,
    workMin: parseInt(document.getElementById('pomo-work-min').value) || 25,
    breakMin: parseInt(document.getElementById('pomo-break-min').value) || 5, count: focus.pomodoroCount } : null;
  return captureFocusObservation('focus-end-break', { phase: 'break', phaseStartedAt: focus.pomodoroPhaseStartedAt, next },
    { at, producerFrame: frame, predecessor: producer?.parentId, eventKey: `focus-end-break:${frame._timerStateOwner}:${focus.pomodoroPhaseStartedAt}`,
      onCaptured(operation) {
        const original = operation.input.observation;
        if (original.facts.next) {
          const after = { ...captureAccountingFrame(), ...cloneUndoValue(original.frame) };
          draftFocusStart(after, original.facts.next, operation.at);
          adoptFocusProducer(after, { continuation: true, parentId: operation.id });
        }
        else stopFocusProducer();
      } });
}

async function skipBreak() {
  if (pomodoroPhase !== 'break' || timerOwnerDeviceId !== syncedDeviceId || timeAckBlocks('Skipping Focus break')) return false;
  const facts = { owner: timerStateOwnerRoom(), device: syncedDeviceId, task: currentTask, count: pomodoroCount,
    workMin: parseInt(document.getElementById('pomo-work-min').value) || 25,
    breakMin: parseInt(document.getElementById('pomo-break-min').value) || 5 };
  return stageAccountingChange('focus-skip-break', (draft, at) => draftFocusStart(draft, facts, at), { timer: true,
    onCaptured(operation) { adoptFocusProducer({ ...captureAccountingFrame(), ...operation.input.after }, { parentId: operation.id }); } });
}

function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 150, 300].forEach(delay => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; g.gain.value = 0.3;
      o.start(ctx.currentTime + delay/1000);
      o.stop(ctx.currentTime + delay/1000 + 0.15);
    });
  } catch(e) {}
}

function togglePomodoroAutoStart() {
  _pomodoroAutoStart = !_pomodoroAutoStart;
  localStorage.setItem('ta3-pomo-auto', _pomodoroAutoStart ? '1' : '0');
  document.getElementById('pomo-autostart-btn')?.classList.toggle('active', _pomodoroAutoStart);
}

// ══════════════════════════════════════════════════════
// FOCUS MUSIC
// ══════════════════════════════════════════════════════

function _nextTrackIdx() {
  if (_LOFI_TRACKS.length === 1) return 0;
  if (_shuffleMode) {
    if (!_shuffleQueue.length) {
      _shuffleQueue = [...Array(_LOFI_TRACKS.length).keys()].filter(i => i !== _lofiTrackIdx);
      for (let i = _shuffleQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [_shuffleQueue[i], _shuffleQueue[j]] = [_shuffleQueue[j], _shuffleQueue[i]];
      }
    }
    return _shuffleQueue.pop();
  }
  return (_lofiTrackIdx + 1) % _LOFI_TRACKS.length;
}

function _updateTrackLabel() {
  const el = document.getElementById('focus-playlist-label');
  if (!el) return;
  if (_LOFI_TRACKS.length <= 1) { el.textContent = _inBreakMode ? 'break ☕' : ''; return; }
  const mode = _inBreakMode ? 'break ☕' : (_shuffleMode ? 'shuffle' : 'order');
  el.textContent = `track ${_lofiTrackIdx + 1} / ${_LOFI_TRACKS.length} · ${mode}`;
}

function _startWorkOutro() {
  if (_outroActive) return;
  _outroActive = true;
  const mp3 = document.getElementById('focus-music');
  mp3.onended = null;
  mp3.loop = false;
  mp3.src = _BREAK_TRANSITION;
  mp3.volume = _focusMusicVolume;
  mp3.play().catch(() => {});
  _updateTrackLabel();
}

function _enterBreakMusic() {
  _inBreakMode = true;
  _outroActive = false;
  const mp3 = document.getElementById('focus-music');
  mp3.onended = null;
  mp3.loop = false;
  mp3.src = _BREAK_LOOP;
  mp3.volume = _focusMusicVolume;
  mp3.loop = true;
  mp3.play().catch(() => {});
  _updateTrackLabel();
}

function _exitBreakMusic() {
  _inBreakMode = false;
  _outroActive = false;
  const mp3 = document.getElementById('focus-music');
  mp3.onended = null;
  mp3.loop = false;
  mp3.src = _BREAK_TRANSITION;
  mp3.volume = _focusMusicVolume;
  mp3.onended = () => {
    _lofiTrackIdx = _nextTrackIdx();
    startFocusMusic();
  };
  mp3.play().catch(() => {});
  _updateTrackLabel();
}

function _skipBreakMusic() {
  _inBreakMode = false;
  _outroActive = false;
  const mp3 = document.getElementById('focus-music');
  mp3.onended = null;
  mp3.loop = false;
  _lofiTrackIdx = _nextTrackIdx();
  startFocusMusic();
}

function _effectiveVolume() {
  return _focusMusicVolume;
}

function startFocusMusic() {
  const mp3 = document.getElementById('focus-music');
  mp3.onended = null;
  mp3.onerror = null;
  mp3.loop = false;
  mp3.src = _LOFI_TRACKS[_lofiTrackIdx];
  mp3.volume = _effectiveVolume();
  mp3.onerror = () => {
    _lofiTrackIdx = _nextTrackIdx();
    startFocusMusic();
  };
  mp3.onended = () => {
    // If < 3 min left in session, loop current track until outro takes over
    if (pomodoroPhase === 'work' && pomodoroRemaining > 0 && pomodoroRemaining < 3 * 60) {
      mp3.currentTime = 0;
      mp3.play().catch(() => {});
      return;
    }
    _lofiTrackIdx = _nextTrackIdx();
    startFocusMusic();
  };
  mp3.play().catch(() => {});
  _updateTrackLabel();
}

function stopFocusMusic() {
  _inBreakMode = false;
  _outroActive = false;
  const mp3 = document.getElementById('focus-music');
  mp3.onended = null;
  mp3.onerror = null;
  mp3.loop = false;
  mp3.pause();
  mp3.currentTime = 0;
}

function setFocusMusicVolume(val) {
  _focusMusicVolume = parseFloat(val);
  localStorage.setItem('ta3-focus-vol', val);
  document.getElementById('focus-music').volume = _effectiveVolume();
}

function toggleFocusPlaylist() {
  _shuffleMode = !_shuffleMode;
  _shuffleQueue = [];
  localStorage.setItem('ta3-focus-shuffle', _shuffleMode ? '1' : '0');
  const btn = document.getElementById('focus-playlist-btn');
  if (btn) btn.classList.toggle('active', _shuffleMode);
  document.getElementById('focus-music-off-btn')?.classList.remove('active');
  const mp3 = document.getElementById('focus-music');
  if (mp3.paused) startFocusMusic();
  _updateTrackLabel();
}

function selectFocusMusicOff() {
  stopFocusMusic();
  const btn = document.getElementById('focus-music-off-btn');
  document.getElementById('focus-playlist-btn').classList.remove('active');
  if (btn) btn.classList.add('active');
}

function resumeFocusMusic() {
  const offBtn = document.getElementById('focus-music-off-btn');
  if (offBtn) offBtn.classList.remove('active');
  startFocusMusic();
}

// ══════════════════════════════════════════════════════
// ENTER / EXIT
// ══════════════════════════════════════════════════════

async function enterFocusMode(options = {}) {
  const launch = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  if (isFocusSessionRunning()) {
    focusModeOn = true;
    document.getElementById('focus-overlay')?.classList.add('open');
    return false;
  }
  if (timeAckBlocks('Starting Focus')) return false;
  if ((running || breakActive) && timerOwnerDeviceId && timerOwnerDeviceId !== syncedDeviceId) {
    showToast('Take over the active timer before starting Focus'); return false;
  }
  if (running || awayActive || breakActive) {
    const accepted = await stageAccountingChange('enter-focus', (draft, at) => {
      if (draft.awayActive) draftAwayEnd(draft, at);
      if (draft.breakActive) draftBreakEndEntry(draft, at);
      const start = draft.taskStartTime || draft.blockStartTime;
      if (draft.running && start) {
        const duration = Math.round((at - start) / 60000);
        if (duration >= 1) {
          const entry = { id: at, ts: at, tsStart: start, blockIntervalMin: duration, date: toDateKey(new Date(at)),
            activity: canonicalFocusActivity(draft.currentTask || intention || 'Work block'),
            energy: draft.entries.find(e => !e.missed && !e.break && !e.away)?.energy || 'deep', onPlan: true, retro: false };
          if (draft.currentTaskPlanItemId) entry.planItemId = draft.currentTaskPlanItemId;
          entry.category = getBucket(entry); entry.originalLabel = entry.energy || null;
          draft.entries.unshift(entry); draft.lastTaskForRepeat = entry.activity;
        }
      }
      draftStoppedTimer(draft, draft.intervalMin);
    }, { timer: true, extra: { stopped: true, lastTask: null } });
    if (!accepted) return false;
    _stopHeartbeat();
  }

  _focusMusicVolume = parseFloat(localStorage.getItem('ta3-focus-vol') || '0.3');
  _shuffleMode = localStorage.getItem('ta3-focus-shuffle') === '1';
  const volSlider = document.getElementById('focus-vol-slider');
  if (volSlider) volSlider.value = _focusMusicVolume;
  const pb = document.getElementById('focus-playlist-btn');
  if (pb) pb.classList.toggle('active', _shuffleMode);
  document.getElementById('focus-music-off-btn')?.classList.remove('active');
  _lofiTrackIdx = Math.floor(Math.random() * _LOFI_TRACKS.length);
  startFocusMusic();
  focusModeOn = true;
  clearInterval(pomodoroTimer);
  pomodoroTimer = null;
  pomodoroCount = 0;
  pomodoroPhase = 'idle';
  pomodoroWorkMin = parseInt(document.getElementById('pomo-work-min')?.value) || 25;
  pomodoroBreakMin = parseInt(document.getElementById('pomo-break-min')?.value) || 5;

  const taskInput = document.getElementById('focus-task-input');
  const launchTask = String(launch.task || '').trim();
  clearFocusLearningPlanContext();
  pendingFocusLearningPlan = cloneFocusLearningPlanMetadata(launch.learningPlan);
  pendingFocusContext = String(launch.context || focusContextText(pendingFocusLearningPlan) || '').trim();
  pendingFocusPlanItemId = typeof launch.planItemId === 'string' && launch.planItemId ? launch.planItemId : null;
  taskInput.value = launchTask;
  taskInput.style.display = 'block';
  if (!launch.autoStart) setTimeout(() => taskInput.focus(), 300);
  document.getElementById('focus-intention-text').style.display = 'none';

  document.getElementById('pomo-autostart-btn')?.classList.toggle('active', _pomodoroAutoStart);
  document.getElementById('focus-overlay').classList.add('open');
  document.getElementById('focus-phase-label').textContent = 'POMODORO';
  document.getElementById('focus-phase-sub').textContent = 'set your timer and go';
  document.getElementById('focus-settings-row').style.display = 'flex';
  document.getElementById('focus-start-btn').textContent = 'Start';
  document.getElementById('focus-start-btn').onclick = startPomodoro;
  document.getElementById('focus-start-btn').style.display = 'block';
  if (Number.isInteger(launch.workMinutes) && launch.workMinutes >= 1 && launch.workMinutes <= 240) {
    pomodoroWorkMin = launch.workMinutes;
    document.getElementById('pomo-work-min').value = launch.workMinutes;
  }
  setPomodoroCountdown(pomodoroWorkMin * 60);
  renderPomoDots();
  updateFocusDeepBar();
  syncFocusOverlayFromRemote();
  if (launch.autoStart) return startPomodoro({
    dailyRoutine: launch.dailyRoutine,
    task: launchTask,
    planItemId: pendingFocusPlanItemId,
    learningPlan: pendingFocusLearningPlan,
    context: pendingFocusContext
  });
  return true;
}

function tryExitFocusMode() {
  confirmExitFocus();
}

function exitFocusConfirm() {
  if (!confirm('Are you sure you want to be distracted?')) return;
  confirmExitFocus();
}

async function confirmExitFocus() {
  if (timeAckBlocks('Leaving Focus')) return false;
  if (timerOwnerDeviceId && timerOwnerDeviceId !== syncedDeviceId) {
    stopFocusMusic(); focusModeOn = false; document.getElementById('focus-overlay').classList.remove('open');
    return true;
  }
  const frame = captureAccountingFrame();
  if (!frame.focus) {
    stopFocusMusic(); focusModeOn = false; document.getElementById('focus-overlay').classList.remove('open'); return true;
  }
  const at = Date.now(), entry = frame.focus.pomodoroPhase === 'work' && frame.focus.focusStartTime
    ? focusEntry(frame.focus.focusStartTime, at, frame) : null;
  const effects = focusCompletionEffects(frame.focus, entry, false);
  const accepted = await stageAccountingChange('focus-exit', draft => {
    draftFocusEntry(draft, entry); draft.focus = null; draftStoppedTimer(draft, draft.intervalMin);
  }, { timer: true, at, effects, extra: { stopped: true, lastTask: null, mode: 'focus' }, onCaptured: stopFocusProducer });
  if (!accepted) return false;
  _stopHeartbeat(); await runFocusAccountingEffects();
  return true;
}

// Focus blocker and suggestions remain UI projections.

function showFocusBlocker(reason) {
  const fbo = document.getElementById('focus-block-overlay');
  document.getElementById('fbo-title').textContent = reason || "You left focus mode";
  document.getElementById('fbo-sub').textContent = "Stay on task. Your timer is still running.";
  document.getElementById('fbo-countdown').style.display = 'none';
  document.getElementById('fbo-cd-label').style.display = 'none';
  document.getElementById('fbo-progress-wrap').style.display = 'none';
  const cancelBtn = document.getElementById('fbo-cancel-btn');
  cancelBtn.disabled = true; cancelBtn.textContent = 'Exit focus';
  fbo.classList.add('show');
}

function requestExitFocus() {
  const delay = settings.exitDelay || 10;
  let cd = delay;
  const cancelBtn = document.getElementById('fbo-cancel-btn');
  const cdEl = document.getElementById('fbo-countdown');
  const cdLabel = document.getElementById('fbo-cd-label');
  const progressFill = document.getElementById('fbo-progress-fill');
  const progressWrap = document.getElementById('fbo-progress-wrap');
  cancelBtn.disabled = true;
  cdEl.style.display = 'block'; cdLabel.style.display = 'block'; progressWrap.style.display = 'block';
  cdEl.textContent = cd;
  progressFill.style.width = '100%';
  progressFill.style.transition = 'none';
  setTimeout(() => { progressFill.style.transition = `width ${delay}s linear`; progressFill.style.width = '0%'; }, 50);
  focusBlockCountdown = setInterval(() => {
    cd--;
    cdEl.textContent = cd;
    if (cd <= 0) {
      clearInterval(focusBlockCountdown);
      document.getElementById('focus-block-overlay').classList.remove('show');
      confirmExitFocus();
    }
  }, 1000);
}

function returnToFocus() {
  clearInterval(focusBlockCountdown);
  document.getElementById('focus-block-overlay').classList.remove('show');
}

// ══════════════════════════════════════════════════════
// FOCUS TASK SUGGESTIONS
// ══════════════════════════════════════════════════════

function showFocusSuggestions(filter) {
  const el = document.getElementById('focus-suggestions');
  if (!el) return;
  const { recent, presets } = buildHeroSuggestions(filter);
  if (!recent.length && !presets.length) { el.style.display = 'none'; return; }
  _focusSugIndex = -1;
  let html = '';
  if (recent.length) {
    if (!filter) html += `<div class="hero-sug-label">Recent</div>`;
    html += recent.map(t => buildSugItem(t, `selectFocusSuggestion(event,'${t.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')`) ).join('');
  }
  if (presets.length) {
    html += `<div class="hero-sug-label">Presets</div>`;
    html += presets.map(t => buildSugItem(t, `selectFocusSuggestion(event,'${t.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')`) ).join('');
  }
  el.innerHTML = html;
  el.style.display = 'block';
}

function hideFocusSuggestions() {
  const el = document.getElementById('focus-suggestions');
  if (el) el.style.display = 'none';
  _focusSugIndex = -1;
}

function selectFocusSuggestion(e, task) {
  e.preventDefault();
  document.getElementById('focus-task-input').value = task;
  hideFocusSuggestions();
}

function handleFocusKey(e) {
  const el = document.getElementById('focus-suggestions');
  const items = el ? el.querySelectorAll('.hero-sug-item') : [];
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _focusSugIndex = Math.min(_focusSugIndex + 1, items.length - 1);
    items.forEach((it, i) => it.style.background = i === _focusSugIndex ? 'var(--deep-dim)' : '');
    if (items[_focusSugIndex]) document.getElementById('focus-task-input').value = items[_focusSugIndex].querySelector('span')?.textContent||items[_focusSugIndex].textContent;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _focusSugIndex = Math.max(_focusSugIndex - 1, -1);
    items.forEach((it, i) => it.style.background = i === _focusSugIndex ? 'var(--deep-dim)' : '');
    if (_focusSugIndex >= 0 && items[_focusSugIndex]) document.getElementById('focus-task-input').value = items[_focusSugIndex].querySelector('span')?.textContent||items[_focusSugIndex].textContent;
  } else if (e.key === 'Escape') {
    hideFocusSuggestions();
  } else if (e.key === 'Enter') {
    hideFocusSuggestions();
    startPomodoro();
  }
}

// Account-scoped restore is initiated by storage.js only after auth binds the owning room and all
// deferred modules have initialized their Focus completion/HUD hooks.
