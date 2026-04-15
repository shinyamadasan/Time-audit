// ══════════════════════════════════════════════════════
// insights.js — Insight generation and awareness engine
//
// Depends on globals defined in index.html:
//   settings, entries, _feedbackTimer
//   getTodayEntries(), getEntriesForWeekKey(), toDateKey(),
//   getWeekKey(), fmtDur(), getTodayEntries(),
//   triggerPenaltyMode(), showToast(), persist()
// ══════════════════════════════════════════════════════

// ── Per-entry feedback flash (called after each log) ──

function analyzeBehavior(entry, todayE) {
  const tone = settings.coachTone || 'analyst';
  const T = (a, c, m) => ({ analyst: a, coach: c, mirror: m })[tone] || a;

  const real = todayE;
  const deepEntries = real.filter(e => e.energy === 'deep');
  const distEntries = real.filter(e => e.energy === 'waste');
  const deepMin  = deepEntries.reduce((s, e) => s + (e.blockIntervalMin || 0), 0);
  const distMin  = distEntries.reduce((s, e) => s + (e.blockIntervalMin || 0), 0);
  const totalMin = real.reduce((s, e) => s + (e.blockIntervalMin || 0), 0);
  const deepPct  = totalMin > 0 ? Math.round(deepMin / totalMin * 100) : 0;
  const distPct  = totalMin > 0 ? Math.round(distMin / totalMin * 100) : 0;
  const hour     = tzHour(Date.now());

  // ── How many consecutive entries from the top (most recent) are waste? ──
  let distStreak = 0;
  for (const e of real) {
    if (e.energy === 'waste') distStreak++; else break;
  }

  // ── How many times has this exact activity been logged as distraction today? ──
  const activityName = entry.activity.split(' (Output:')[0];
  const sameActivityDist = distEntries.filter(e =>
    e.activity.split(' (Output:')[0].toLowerCase() === activityName.toLowerCase()
  ).length;

  // ── Minutes since last deep work ──
  const lastDeep = deepEntries[0]; // entries sorted newest-first
  const minsSinceDeep = lastDeep ? Math.round((Date.now() - lastDeep.ts) / 60000) : null;

  // === WASTE entries ===
  if (entry.energy === 'waste') {
    const wastedStr = distMin >= 60 ? `${(distMin/60).toFixed(1)}h` : `${distMin}m`;

    if (sameActivityDist >= 3) {
      return { type: 'bad', eyebrow: 'Habit detected',
        message: T(
          `"${activityName}" has appeared ${sameActivityDist}× today.`,
          `"${activityName}" again. That's ${sameActivityDist} times today. Call it what it is.`,
          `${sameActivityDist}× on "${activityName}". That's not accidental — that's a default.`
        ),
        sub: T(`${wastedStr} lost to distractions total.`,
              `${wastedStr} gone. Each time you open it you choose it.`,
              `${wastedStr} of your life. You know this.`) };
    }

    if (distStreak >= 3) {
      return { type: 'bad', eyebrow: `${distStreak} distractions in a row`,
        message: T(
          `Three consecutive distraction blocks logged.`,
          `${distStreak} distractions in a row. You've lost the session. Reset now.`,
          `${distStreak} in a row. You're not working — you're avoiding something.`
        ),
        sub: T(`Consider resetting with a focused sprint.`,
              `Start a 25-min sprint. Right now.`,
              `What are you running from?`) };
    }

    if (distStreak === 2) {
      return { type: 'bad', eyebrow: 'Pattern forming',
        message: T(
          `Two distraction blocks back to back.`,
          `Two in a row. This is where it snowballs — stop it here.`,
          `Twice in a row. You're in a drift. The next block decides the day.`
        ),
        sub: T(`${wastedStr} lost to distractions today.`,
              `${wastedStr} wasted. Make the next one count.`,
              `${wastedStr} gone. The trend is yours to reverse.`) };
    }

    // First or single distraction
    if (hour >= 14 && deepMin < 60) {
      return { type: 'bad', eyebrow: 'Distraction logged',
        message: T(
          `Distraction logged. ${deepMin}m of deep work so far — and it's past 2pm.`,
          `Past 2pm. ${deepMin < 30 ? 'Almost no' : 'Only ' + deepMin + 'm of'} deep work. This distraction just made that worse.`,
          `It's ${hour}:00. You've done ${deepMin < 30 ? 'almost nothing deep' : `${deepMin}m of deep work`}. And you just chose this.`
        ),
        sub: `${wastedStr} lost to distractions today.` };
    }

    return { type: 'bad', eyebrow: 'Distraction logged',
      message: T(
        `Distraction logged. ${distEntries.length === 1 ? 'First one today.' : `${distEntries.length} today.`}`,
        `Logged. Now refocus. Don't let it become two.`,
        `You know it was a waste. The next block is the test.`
      ),
      sub: `${wastedStr} lost to distractions today.` };
  }

  // === DEEP WORK entries ===
  if (entry.energy === 'deep') {
    const blockDur = entry.blockIntervalMin || 0;
    const deepHrsStr = deepMin >= 60 ? `${(deepMin/60).toFixed(1)}h` : `${deepMin}m`;

    // Just recovered from a distraction streak
    if (real[1] && real[1].energy === 'waste') {
      return { type: 'deep', eyebrow: 'Recovery block',
        message: T(
          `Back to deep work. ${deepHrsStr} total today.`,
          `Good. You broke the drift. Now chain another one.`,
          `You came back. That matters. Don't let it be the only one.`
        ),
        sub: distPct > 0 ? `${distPct}% wasted today.` : '' };
    }

    // Milestones
    if (deepEntries.length === 5) {
      return { type: 'deep', eyebrow: '5 deep blocks',
        message: T(
          `Five deep work blocks today. That's a strong output day.`,
          `5 deep blocks. This is what a real workday looks like.`,
          `5 deep blocks. Most people never get there. Keep going.`
        ),
        sub: `${deepHrsStr} of deep work logged today.` };
    }
    if (deepEntries.length === 3) {
      return { type: 'deep', eyebrow: '3 deep blocks',
        message: T(
          `Three deep blocks in. Consistent output today.`,
          `Three deep blocks. You're building real momentum.`,
          `Three in. Now the question is: can you push it to five?`
        ),
        sub: `${deepHrsStr} total · ${distPct > 0 ? `${distPct}% waste` : 'no waste logged'}` };
    }
    if (deepPct >= 60 && deepEntries.length >= 2) {
      return { type: 'deep', eyebrow: 'Deep work majority',
        message: T(
          `Deep work is now ${deepPct}% of your tracked time.`,
          `${deepPct}% deep. This is what a high-leverage day looks like.`,
          `${deepPct}% deep. You're proving something to yourself today.`
        ),
        sub: `${deepHrsStr} locked in.` };
    }
    if (deepEntries.length === 1) {
      return { type: 'deep', eyebrow: 'First deep block',
        message: T(
          `First deep block of the day logged. ${blockDur}m.`,
          `First deep block in. Now build on it.`,
          `Finally. Now don't stop.`
        ),
        sub: hour >= 14
          ? T(`It\'s past 2pm — make every remaining block count.`,
              `Late start. Fewer hours left. Make each one count.`,
              `You started late. That\'s already a cost. Minimize the rest.`)
          : `Build a chain from here.` };
    }

    return { type: 'deep', eyebrow: 'Deep work logged',
      message: T(
        `Deep block logged. ${deepHrsStr} total today.`,
        `${deepHrsStr} of deep work. Keep the chain alive.`,
        `${deepHrsStr} in. The day is being built. Don\'t break it now.`
      ),
      sub: '' };
  }

  // === SHALLOW / 9-5 — only fire when patterns warrant ===
  if (entry.energy === 'shallow' || entry.energy === 'nine5') {
    // Long run without deep work during prime hours
    if (hour >= 10 && hour <= 16 && minsSinceDeep !== null && minsSinceDeep > 120 && deepMin > 0) {
      const gapStr = minsSinceDeep >= 120 ? `${Math.round(minsSinceDeep/60)}h` : `${minsSinceDeep}m`;
      return { type: 'warn', eyebrow: 'Deep work gap',
        message: T(
          `No deep work in the last ${gapStr}. Shallow blocks are accumulating.`,
          `${gapStr} since your last deep block. You\'re in reactive mode.`,
          `${gapStr} without real work. You\'re busy — but on what?`
        ),
        sub: `${deepMin}m deep so far today.` };
    }
    // No deep work at all late in day
    if (hour >= 15 && deepMin === 0) {
      return { type: 'warn', eyebrow: 'No deep work yet',
        message: T(
          `No deep work logged today and it\'s ${hour}:00.`,
          `${hour}:00 and zero deep work. The window is closing.`,
          `It\'s ${hour}:00. You haven\'t done a single deep block. Why?`
        ),
        sub: 'The last few hours of the day are still yours.' };
    }
  }

  return null; // No feedback for unremarkable entries
}

function renderFeedbackFlash(fb) {
  const el = document.getElementById('feedback-flash');
  if (!el) return;

  clearTimeout(_feedbackTimer);
  el.className = `feedback-flash type-${fb.type} entering`;
  el.style.display = 'block';
  el.innerHTML = `
    <div class="fb-eyebrow">${fb.eyebrow}</div>
    <div class="fb-message">${fb.message}</div>
    ${fb.sub ? `<div class="fb-sub">${fb.sub}</div>` : ''}
    <button class="fb-dismiss" onclick="dismissFeedbackFlash()">✕</button>`;

  _feedbackTimer = setTimeout(() => dismissFeedbackFlash(), 8000);
}

function dismissFeedbackFlash() {
  const el = document.getElementById('feedback-flash');
  if (!el || el.style.display === 'none') return;
  el.classList.remove('entering');
  el.classList.add('leaving');
  setTimeout(() => { el.style.display = 'none'; el.className = 'feedback-flash'; }, 360);
}

function checkEscalation() {
  const todayE = getTodayEntries();
  const missedToday = todayE.filter(e => e.missed).length;
  let dStreak = 0;
  for (const e of todayE) {
    if (e.energy === 'waste' || e.missed) dStreak++;
    else break;
  }
  if (dStreak >= 5) {
    settings.exitDelay = 60;
    persist();
    showToast('Focus lock active — exit delay set to 60s');
  }
  // Only trigger penalty after 5 in a row, not 2
  if (dStreak >= 5) triggerPenaltyMode();
}

// ══════════════════════════════════════════════════════
// INSIGHT GENERATION
// generateInsights({ deep, shallow, nine5, errands, learning, exercise, social, recovery, waste, total })
// Returns an array of 3–4 plain-language insight strings.
// ══════════════════════════════════════════════════════
function generateInsights(data) {
  const { deep = 0, shallow = 0, nine5 = 0, errands = 0, learning = 0, exercise = 0, social = 0, recovery = 0, waste = 0, total = 0 } = data;
  if (total <= 0) return [];

  const pct = v => Math.round(v / total * 100);
  const fmt = h => h === Math.floor(h) ? `${h}h` : `${h.toFixed(1)}h`;

  const insights = [];

  // 1. Composition summary
  const parts = [
    deep     > 0 ? `deep work (${fmt(deep)})`       : null,
    shallow  > 0 ? `shallow work (${fmt(shallow)})`  : null,
    nine5    > 0 ? `scheduled (${fmt(nine5)})`        : null,
    errands  > 0 ? `errands (${fmt(errands)})`        : null,
    learning > 0 ? `learning (${fmt(learning)})`      : null,
    exercise > 0 ? `exercise (${fmt(exercise)})`      : null,
    social   > 0 ? `social (${fmt(social)})`          : null,
    recovery > 0 ? `recovery (${fmt(recovery)})`      : null,
    waste    > 0 ? `waste (${fmt(waste)})`            : null,
  ].filter(Boolean);
  insights.push(`You tracked ${fmt(total)} — ${parts.join(', ')}.`);

  // 2. Dominant category
  const cats = {
    'Deep work': deep, 'Shallow work': shallow, 'Scheduled work': nine5,
    Errands: errands, Learning: learning, Exercise: exercise,
    Social: social, Recovery: recovery, Waste: waste
  };
  const dominant = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
  if (dominant[1] > 0) {
    insights.push(`${dominant[0]} was your dominant category at ${pct(dominant[1])}% of tracked time.`);
  }

  // 3. Waste alert
  if (waste > 2 || pct(waste) >= 25) {
    insights.push(pct(waste) >= 40
      ? `Waste was ${pct(waste)}% of your day (${fmt(waste)}). That's a significant leak.`
      : `Waste was ${pct(waste)}% of your day (${fmt(waste)}) — above the 25% threshold. Worth examining.`);
  }

  // 4. Deep work reinforcement
  if (deep >= 4) {
    insights.push(`${fmt(deep)} of deep work is an excellent result. That kind of sustained focus is rare.`);
  } else if (deep >= 2) {
    insights.push(`${fmt(deep)} of deep work is a solid result. That kind of focus compounds.`);
  } else if (deep > 0 && deep < 1) {
    insights.push(`Less than an hour of deep work. Even one focused block tomorrow changes the trajectory.`);
  }

  return insights;
}

// ══════════════════════════════════════════════════════
// AWARENESS ENGINE
// ══════════════════════════════════════════════════════
function renderAwarenessSignal() {
  const el = document.getElementById('awareness-signal');
  if (!el) return;

  const todayE = getTodayEntries().filter(e => !e.missed);
  const tone   = settings.coachTone || 'analyst';
  const hour   = tzHour(Date.now());

  if (!todayE.length && hour < 10) { el.style.display = 'none'; return; }

  const real     = todayE;
  const totalMin = real.reduce((s, e) => s + (e.blockIntervalMin || 0), 0);
  const deepMin  = real.filter(e => e.energy === 'deep').reduce((s, e) => s + (e.blockIntervalMin || 0), 0);
  const distMin  = real.filter(e => e.energy === 'waste').reduce((s, e) => s + (e.blockIntervalMin || 0), 0);
  const recovMin = real.filter(e => e.energy === 'recovery').reduce((s, e) => s + (e.blockIntervalMin || 0), 0);
  const deepPct  = totalMin > 0 ? Math.round(deepMin / totalMin * 100) : 0;
  const distPct  = totalMin > 0 ? Math.round(distMin / totalMin * 100) : 0;
  const deepHrs  = (deepMin / 60).toFixed(1);

  // Peak focus hour
  const hourBuckets = {};
  real.filter(e => e.energy === 'deep' && e.tsStart).forEach(e => {
    const h = tzHour(e.tsStart);
    hourBuckets[h] = (hourBuckets[h] || 0) + (e.blockIntervalMin || 0);
  });
  let peakHour = null, peakHourMin = 0;
  Object.entries(hourBuckets).forEach(([h, m]) => { if (m > peakHourMin) { peakHourMin = m; peakHour = Number(h); } });
  const peakLabel = peakHour !== null ? `${peakHour % 12 || 12}${peakHour < 12 ? 'am' : 'pm'}` : null;

  // Repeated waste activities: map activity → total minutes
  const distActivityMap = {};
  real.filter(e => e.energy === 'waste').forEach(e => {
    const k = e.activity.split(' (Output:')[0];
    distActivityMap[k] = (distActivityMap[k] || 0) + (e.blockIntervalMin || 0);
  });
  const worstWaste = Object.entries(distActivityMap).sort((a, b) => b[1] - a[1])[0];

  // Last deep block — how long ago?
  const lastDeep = real.filter(e => e.energy === 'deep')[0];
  const minsSinceDeep = lastDeep ? Math.round((Date.now() - lastDeep.ts) / 60000) : null;

  // Waste run at top of entry list
  let distStreak = 0;
  for (const e of real) { if (e.energy === 'waste') distStreak++; else break; }

  const T = (a, c, m) => ({ analyst: a, coach: c, mirror: m })[tone] || a;
  const signals = [];

  // ── No entries yet ──
  if (!real.length && hour >= 10) {
    signals.push({ color: 'var(--muted)', severity: 'warn', label: 'Nothing logged',
      text: T('No entries logged yet today.',
              'Nothing logged. What are you actually doing right now?',
              "The timer doesn't lie. You haven't started.") });
  }

  // ── Distraction streak ──
  if (distStreak >= 2) {
    signals.push({ color: 'var(--distraction)', severity: 'bad', label: `${distStreak} distractions in a row`,
      text: T(`${distStreak} consecutive distraction blocks.`,
              `${distStreak} in a row. You need to stop the slide — now.`,
              `${distStreak} distractions back to back. You're not working, you're hiding.`) });
  }

  // ── Named waste: same distraction activity ≥ 2 times ──
  if (worstWaste && distActivityMap[worstWaste[0]] >= 30) {
    const [activity, mins] = worstWaste;
    const count = real.filter(e => e.energy === 'waste' && e.activity.split(' (Output:')[0] === activity).length;
    if (count >= 2) {
      const wStr = mins >= 60 ? `${(mins/60).toFixed(1)}h` : `${mins}m`;
      signals.push({ color: 'var(--distraction)', severity: 'bad', label: 'Repeat offender',
        text: T(`"${activity}" logged ${count}× today — ${wStr} total.`,
                `"${activity}" ${count} times. ${wStr} gone. You know this isn't working.`,
                `${wStr} on "${activity}". ${count} separate choices to waste time. Own it.`) });
    }
  }

  // ── Long gap without deep work (during work hours) ──
  if (minsSinceDeep !== null && minsSinceDeep > 90 && hour >= 10 && hour <= 17) {
    const gapStr = minsSinceDeep >= 120 ? `${Math.round(minsSinceDeep / 60)}h` : `${minsSinceDeep}m`;
    signals.push({ color: 'var(--admin)', severity: 'warn', label: `${gapStr} since last deep work`,
      text: T(`No deep work for ${gapStr}. You're in reactive mode.`,
              `${gapStr} without deep work. Reactive mode is a trap — break out.`,
              `${gapStr} without doing anything that matters. What are you busy with?`) });
  }

  // ── No deep work at all, late in day ──
  if (hour >= 14 && deepMin === 0 && real.length > 0) {
    signals.push({ color: 'var(--distraction)', severity: 'bad', label: 'No deep work today',
      text: T(`${hour}:00 — no deep work logged yet today.`,
              `Past ${hour}:00 with zero deep work. The window is closing fast.`,
              `It's ${hour}:00. Nothing deep. You chose everything else over your real work.`) });
  }

  // ── Deep work: strong day ──
  if (deepPct >= 50 && deepMin >= 90 && distStreak === 0) {
    signals.push({ color: 'var(--deep)', severity: 'good', label: 'Strong focus day',
      text: T(`Deep work is ${deepPct}% of today — ${deepHrs}h. Above average.`,
              `${deepPct}% deep, ${deepHrs}h in. This is the standard.`,
              `${deepPct}% deep. Rare. Don't let tomorrow undo it.`) });
  }
  // ── Deep work: decent, but with distraction ──
  else if (deepMin >= 60 && distPct >= 20) {
    signals.push({ color: 'var(--shallow)', severity: 'warn', label: 'Mixed session',
      text: T(`${deepHrs}h deep work, but ${distPct}% wasted.`,
              `${deepHrs}h of good work, but ${distPct}% wasted. Protect the next block.`,
              `${deepHrs}h real work. ${distPct}% wasted. Those two numbers tell your whole story.`) });
  }
  // ── Deep work: consistently low after 2pm ──
  else if (hour >= 14 && deepMin > 0 && deepMin < 90) {
    signals.push({ color: 'var(--shallow)', severity: 'warn', label: 'Low deep output',
      text: T(`Only ${deepHrs}h of deep work. The focus window is narrowing.`,
              `${deepHrs}h deep — not enough. You have hours left. Use them.`,
              `${deepHrs}h of real work by ${hour}:00. You know that's not enough.`) });
  }

  // ── Peak focus hour (positive, only when day is going well) ──
  if (peakLabel && peakHourMin >= 45 && deepPct >= 40) {
    signals.push({ color: 'var(--deep)', severity: 'good', label: `Peak hour: ${peakLabel}`,
      text: T(`Your focus peaked at ${peakLabel} today — ${peakHourMin}m of deep work that hour.`,
              `${peakLabel} is your zone. ${peakHourMin}m deep. Protect that window every day.`,
              `${peakLabel} — ${peakHourMin}m deep. That's your real capacity. Stop wasting it.`) });
  }

  // ── Recovery time exceeds deep work ──
  if (recovMin > 120 && recovMin > deepMin && totalMin > 0) {
    const recovHrsStr = (recovMin / 60).toFixed(1);
    signals.push({ color: 'var(--break)', severity: 'warn', label: 'Recovery > deep work',
      text: T(`${recovHrsStr}h in recovery — more than ${deepHrs}h of deep work.`,
              `${recovHrsStr}h resting, ${deepHrs}h deep. Watch that ratio.`,
              `You spent more time recovering (${recovHrsStr}h) than working deeply (${deepHrs}h). Intentional?`) });
  }

  // ── End-of-day verdict ──
  if (hour >= 18 && totalMin > 0) {
    const verdict = deepPct >= 50
      ? { severity: 'good', text: T(`Day done. ${deepHrs}h deep work — ${deepPct}% of your day. Strong.`,
                                     `Day closed. ${deepHrs}h deep. This is the result of discipline.`,
                                     `${deepPct}% deep. You earned today.`) }
      : distPct >= 30
      ? { severity: 'bad', text: T(`Day done. ${distPct}% waste. Examine why.`,
                                    `Day closed. ${distPct}% waste. What will you change tomorrow?`,
                                    `${distPct}% wasted. You'll remember tomorrow's version of this choice.`) }
      : { severity: 'warn', text: T(`Day done. ${deepHrs}h deep work, ${distPct}% waste.`,
                                     `Day closed. ${deepHrs}h deep. Push for more tomorrow.`,
                                     `${deepHrs}h real work. You can do better. You know it.`) };
    signals.push({ color: verdict.severity === 'good' ? 'var(--deep)' : verdict.severity === 'bad' ? 'var(--distraction)' : 'var(--admin)',
      severity: verdict.severity, label: 'Day closed', text: verdict.text });
  }

  // Deduplicate by severity priority, keep top 3
  const order = { bad: 0, warn: 1, good: 2 };
  const top = signals.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 3);

  if (!top.length) { el.style.display = 'none'; return; }

  el.style.display = 'block';
  el.innerHTML = `<div class="signal-card">
    <div class="signal-header">
      <span class="signal-header-title">Today's Signal</span>
      ${top[0].severity === 'good' ? '<span class="signal-badge good">On track</span>' :
        top[0].severity === 'bad'  ? '<span class="signal-badge bad">Needs attention</span>' :
                                      '<span class="signal-badge warn">Watch this</span>'}
    </div>
    ${top.map(s => `
      <div class="signal-item">
        <div class="signal-dot" style="background:${s.color}"></div>
        <div class="signal-item-body">
          <div class="signal-item-label">${s.label}</div>
          <div>${s.text}</div>
        </div>
      </div>`).join('')}
  </div>`;
}

// ── Daily summary (Today's pulse card) ──

function getDailySummaryInsight(s) {
  const tone = settings.coachTone || 'analyst';
  const { deepPct, wastePct, productivePct, peakHourLabel, deepMin, focusScore } = s;
  const dh = (deepMin / 60).toFixed(1);
  const ph = peakHourLabel ? ` Peak: ${peakHourLabel}.` : '';

  if (focusScore >= 80) {
    return {
      analyst: `${deepPct}% deep work today — strong signal.${ph}`,
      coach:   `${dh}h of deep work. Execution on point.${ph}`,
      mirror:  `${deepPct}% deep. Keep this standard or explain why you didn't.`
    }[tone];
  }
  if (deepMin < 30) {
    return {
      analyst: `No significant deep work logged. Examine what fragmented the day.`,
      coach:   `Zero deep work. That's the thing you need to change tomorrow.`,
      mirror:  `You avoided the hard work today. Own it and fix it.`
    }[tone];
  }
  if (wastePct >= 30) {
    return {
      analyst: `${wastePct}% lost to waste. ${productivePct}% productive.${ph}`,
      coach:   `${wastePct}% waste is eating your output. Protect your blocks.`,
      mirror:  `${wastePct}% of today was wasted. You know what you chose over your work.`
    }[tone];
  }
  return {
    analyst: `${productivePct}% productive · ${deepPct}% deep work.${ph}`,
    coach:   `Decent day. ${dh}h deep work. Push for more tomorrow.`,
    mirror:  `${productivePct}% productive. Good, not great. You can do better.`
  }[tone];
}

function buildDailySummaryHTML(s) {
  if (!s) return `<div style="color:var(--muted);font-size:13px;padding:4px 0">No entries logged yet today.</div>`;

  const scorePillClass = s.focusScore >= 70 ? '' : s.focusScore >= 40 ? ' mid' : ' low';
  const deepValClass   = s.deepPct >= 40 ? 'good' : s.deepPct >= 20 ? 'warn' : '';
  const wasteValClass  = s.wastePct >= 30 ? 'bad' : s.wastePct >= 15 ? 'warn' : '';
  const prodValClass   = s.productivePct >= 70 ? 'good' : s.productivePct >= 50 ? 'warn' : '';

  const peakHtml = s.peakHourLabel
    ? `<div class="ds-peak">
        <span style="font-size:11px;color:var(--muted)">Peak focus hour</span>
        <span class="ds-peak-badge">${s.peakHourLabel}</span>
        <span style="font-size:11px;color:var(--muted);font-family:var(--mono)">${s.peakHourMin}m deep in that hour</span>
       </div>`
    : '';

  // Split bar — all 9 categories
  const segs = [
    { cls: 'deep',     label: 'Deep',           pct: s.deepPct,     min: s.deepMin },
    { cls: 'shallow',  label: 'Shallow',         pct: s.shallowPct,  min: s.shallowMin },
    { cls: 'nine5',    label: 'Scheduled work',  pct: s.nine5Pct,    min: s.nine5Min },
    { cls: 'errands',  label: 'Errands',         pct: s.errandsPct,  min: s.errandsMin },
    { cls: 'learning', label: 'Learning',        pct: s.learningPct, min: s.learningMin },
    { cls: 'exercise', label: 'Exercise',        pct: s.exercisePct, min: s.exerciseMin },
    { cls: 'social',   label: 'Social',          pct: s.socialPct,   min: s.socialMin },
    { cls: 'recovery', label: 'Recovery',        pct: s.recoveryPct, min: s.recoveryMin },
    { cls: 'waste',    label: 'Waste',           pct: s.wastePct,    min: s.wasteMin },
  ].filter(seg => seg.pct > 0);

  const splitBar = segs.map(seg =>
    `<div class="ds-split-seg ${seg.cls}" style="width:${seg.pct}%" title="${seg.label}: ${fmtDur(seg.min)} (${seg.pct}%)"></div>`
  ).join('');

  const legend = segs.map(seg =>
    `<div class="ds-legend-item">
      <span class="ds-legend-dot ${seg.cls}"></span>
      <span class="ds-legend-name">${seg.label}</span>
      <span class="ds-legend-time">${fmtDur(seg.min)}</span>
      <span class="ds-legend-pct">${seg.pct}%</span>
    </div>`
  ).join('');

  const insight = getDailySummaryInsight(s);

  return `
    <div class="ds-header">
      <span class="ds-title">Today's pulse</span>
      <span class="ds-score-pill${scorePillClass}">Score ${s.focusScore}</span>
    </div>
    <div class="ds-metrics">
      <div class="ds-metric">
        <div class="ds-metric-val ${deepValClass}">${s.deepHrs}h</div>
        <div class="ds-metric-label">Deep work</div>
      </div>
      <div class="ds-metric">
        <div class="ds-metric-val ${prodValClass}">${s.productivePct}%</div>
        <div class="ds-metric-label">Productive</div>
      </div>
      <div class="ds-metric">
        <div class="ds-metric-val ${wasteValClass}">${s.wastePct}%</div>
        <div class="ds-metric-label">Waste</div>
      </div>
    </div>
    <div class="ds-breakdown-header">
      <span class="ds-breakdown-title">Time breakdown</span>
      <span class="ds-breakdown-total">${fmtDur(s.totalMin)} tracked</span>
    </div>
    <div class="ds-split-bar">${splitBar}</div>
    <div class="ds-legend">${legend}</div>
    ${peakHtml}
    <div class="ds-insight">${insight}</div>`;
}

// ── Weekly insights (Reflect tab) ──

function computeInsights(weekKey) {
  const we = getEntriesForWeekKey(weekKey).filter(e => !e.missed);
  if (!we.length) return null;

  const totalMin = we.reduce((s, e) => s + (e.blockIntervalMin || 0), 0);
  const minFor = key => we.filter(e => e.energy === key).reduce((s, e) => s + (e.blockIntervalMin || 0), 0);
  const deepMin     = minFor('deep');
  const shallowMin  = minFor('shallow');
  const nine5Min    = minFor('nine5');
  const errandsMin  = minFor('errands');
  const learningMin = minFor('learning');
  const exerciseMin = minFor('exercise');
  const socialMin   = minFor('social');
  const recoveryMin = minFor('recovery');
  const wasteMin    = minFor('waste');
  const productiveMin = nine5Min + deepMin + shallowMin + errandsMin + learningMin;
  const deepPct  = totalMin > 0 ? Math.round(deepMin / totalMin * 100) : 0;
  const wastePct = totalMin > 0 ? Math.round(wasteMin / totalMin * 100) : 0;
  const deepHrs  = (deepMin / 60).toFixed(1);

  // Top activity by time
  const actMap = {};
  we.filter(e => e.activity).forEach(e => {
    const k = e.activity.split(' (Output:')[0];
    actMap[k] = (actMap[k] || 0) + (e.blockIntervalMin || 0);
  });
  let topActivity = '—', topActivityMin = 0;
  Object.entries(actMap).forEach(([k, m]) => { if (m > topActivityMin) { topActivityMin = m; topActivity = k; } });

  // Worst waste activity by time
  const wasteMap = {};
  we.filter(e => e.energy === 'waste' && e.activity).forEach(e => {
    const k = e.activity.split(' (Output:')[0];
    wasteMap[k] = (wasteMap[k] || 0) + (e.blockIntervalMin || 0);
  });
  let worstDist = '—', worstDistMin = 0;
  Object.entries(wasteMap).forEach(([k, m]) => { if (m > worstDistMin) { worstDistMin = m; worstDist = k; } });

  // Peak focus hour
  const hourBuckets = {};
  we.filter(e => e.energy === 'deep' && e.tsStart).forEach(e => {
    const hr = tzHour(e.tsStart);
    hourBuckets[hr] = (hourBuckets[hr] || 0) + (e.blockIntervalMin || 0);
  });
  let peakHour = null, peakMin = 0;
  Object.entries(hourBuckets).forEach(([h, m]) => { if (m > peakMin) { peakMin = m; peakHour = Number(h); } });
  const peakHourLabel = peakHour !== null ? `${peakHour % 12 || 12}${peakHour < 12 ? 'am' : 'pm'}` : '—';

  // Best day (most deep work)
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dayBuckets = {};
  we.filter(e => e.energy === 'deep').forEach(e => {
    dayBuckets[e.date] = (dayBuckets[e.date] || 0) + (e.blockIntervalMin || 0);
  });
  let bestDay = '—', bestDayMin = 0;
  Object.entries(dayBuckets).forEach(([d, m]) => { if (m > bestDayMin) { bestDayMin = m; bestDay = dayNames[new Date(d+'T12:00:00').getDay()]; } });

  return { totalMin, deepMin, deepHrs, deepPct, shallowMin, nine5Min, errandsMin, learningMin, exerciseMin, socialMin, recoveryMin, wasteMin,
           productiveMin, wastePct,
           topActivity, topActivityMin, worstDist, worstDistMin,
           peakHourLabel, bestDay, bestDayMin };
}
