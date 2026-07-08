// Focus Wallet scoring rules.
// Pure helpers only: points are computed from entries, while reward spends are stored separately.
(function initFocusWallet(root) {
  'use strict';

  const DEFAULT_FOCUS_WALLET_SETTINGS = Object.freeze({
    deepPointMinutes: 5,
    deepPointsPerUnit: 1,
    retroMultiplier: 0.5,
    liveFocusBonusMin: 60,
    liveFocusBonus: 5,
    dailyGoalMin: 0,
    dailyGoalBonus: 10,
    wastePenaltyMinutes: 10,
    wastePenaltyPoints: 1,
    wastePenaltyDailyCap: 20,
    sportsFreeSessions: 3,
    sportsSessionFourCost: 10,
    sportsExtraSessionCost: 25,
    sportsLongSessionMin: 120,
    sportsLongSessionExtraHourCost: 10,
    sportsActivities: [
      'pickleball', 'pickle ball', 'basketball', 'basket ball', 'tennis',
      'soccer', 'football', 'volleyball', 'baseball', 'softball', 'golf',
      'badminton', 'squash', 'racquetball', 'sport'
    ]
  });

  function roundPoints(value) {
    const rounded = Math.round(value * 10) / 10;
    return Math.abs(rounded - Math.round(rounded)) < 0.001 ? Math.round(rounded) : rounded;
  }

  function getFocusWalletSettings(appSettings) {
    const custom = (appSettings && appSettings.focusWallet) || {};
    return {
      ...DEFAULT_FOCUS_WALLET_SETTINGS,
      ...custom,
      sportsActivities: custom.sportsActivities || DEFAULT_FOCUS_WALLET_SETTINGS.sportsActivities
    };
  }

  function getFocusWalletWeekKey(dateInput) {
    const raw = dateInput instanceof Date ? dateInput : new Date(dateInput || Date.now());
    const d = new Date(Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate(), 12, 0, 0));
    const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4, 12, 0, 0));
    const startOfW1 = new Date(jan4);
    startOfW1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
    const weekNum = Math.floor((d - startOfW1) / 604800000) + 1;
    return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  }

  function getFocusWalletEntryDurationMin(entry, fallbackMin) {
    if (!entry) return fallbackMin || 30;
    const start = Number(entry.tsStart || 0);
    const end = Number(entry.ts || 0);
    if (start > 0 && end > start) return Math.max(1, Math.round((end - start) / 60000));
    if (Array.isArray(entry.segments) && entry.segments.length) {
      const seconds = entry.segments.reduce((sum, seg) => sum + (Number(seg.duration) || 0), 0);
      if (seconds > 0) return Math.max(1, Math.round(seconds / 60));
    }
    const stored = Number(entry.blockIntervalMin);
    if (Number.isFinite(stored) && stored > 0) return Math.max(1, Math.round(stored));
    return fallbackMin || 30;
  }

  function entryStartTs(entry, fallbackMin) {
    if (!entry) return 0;
    if (entry.tsStart) return entry.tsStart;
    if (entry.ts) return entry.ts - getFocusWalletEntryDurationMin(entry, fallbackMin) * 60000;
    return 0;
  }

  function getEntryWeekKey(entry, weekKeyForTs, fallbackMin) {
    if (entry.weekKey) return entry.weekKey;
    const ts = entryStartTs(entry, fallbackMin) || entry.ts || Date.now();
    return weekKeyForTs ? weekKeyForTs(ts) : getFocusWalletWeekKey(ts);
  }

  function getEntryDateKey(entry, dateKeyForTs, fallbackMin) {
    const ts = entryStartTs(entry, fallbackMin) || entry.ts || Date.now();
    if (dateKeyForTs) return dateKeyForTs(ts);
    return new Date(ts).toISOString().slice(0, 10);
  }

  function isFocusWalletSportsEntry(entry, cfg) {
    if (!entry || !entry.activity) return false;
    const label = String(entry.activity).toLowerCase();
    return cfg.sportsActivities.some(term => label.includes(String(term).toLowerCase()));
  }

  function getDailyGoalMin(appSettings, cfg) {
    const direct = Number(cfg.dailyGoalMin);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const weeklyGoalHrs = Number(appSettings && appSettings.deepGoal);
    return Number.isFinite(weeklyGoalHrs) && weeklyGoalHrs > 0 ? Math.round((weeklyGoalHrs * 60) / 5) : 0;
  }

  function addBreakdown(breakdown, type, label, points, meta) {
    if (!points) return;
    breakdown.push({ type, label, points: roundPoints(points), ...(meta || {}) });
  }

  function computeFocusWallet(entries, redemptions, appSettings, targetWeekKey, options) {
    const cfg = getFocusWalletSettings(appSettings);
    const fallbackMin = (appSettings && appSettings.intervalMin) || 30;
    const weekKey = targetWeekKey || getFocusWalletWeekKey(Date.now());
    const weekKeyForTs = options && options.weekKeyForTs;
    const dateKeyForTs = options && options.dateKeyForTs;
    const dailyGoalMin = getDailyGoalMin(appSettings, cfg);

    let earned = 0;
    let autoCosts = 0;
    let redeemed = 0;
    const breakdown = [];
    const deepMinutesByDay = {};
    const wasteCostByDay = {};
    const sportsSessions = [];

    (entries || []).forEach(entry => {
      if (!entry || entry.deleted || entry.missed) return;
      if (getEntryWeekKey(entry, weekKeyForTs, fallbackMin) !== weekKey) return;

      const durationMin = getFocusWalletEntryDurationMin(entry, fallbackMin);
      const dateKey = getEntryDateKey(entry, dateKeyForTs, fallbackMin);

      if (entry.energy === 'deep') {
        const multiplier = entry.retro ? cfg.retroMultiplier : 1;
        const base = Math.floor(durationMin / cfg.deepPointMinutes) * cfg.deepPointsPerUnit * multiplier;
        earned += base;
        addBreakdown(breakdown, 'earn', entry.retro ? 'Retro deep work' : 'Deep work', base, { entryId: entry.id });

        if (!entry.retro && durationMin >= cfg.liveFocusBonusMin) {
          earned += cfg.liveFocusBonus;
          addBreakdown(breakdown, 'bonus', 'Live focus bonus', cfg.liveFocusBonus, { entryId: entry.id });
        }
        deepMinutesByDay[dateKey] = (deepMinutesByDay[dateKey] || 0) + durationMin;
      }

      if (entry.energy === 'waste' || entry.energy === 'distraction') {
        const rawCost = Math.floor(durationMin / cfg.wastePenaltyMinutes) * cfg.wastePenaltyPoints;
        wasteCostByDay[dateKey] = (wasteCostByDay[dateKey] || 0) + rawCost;
      }

      if (isFocusWalletSportsEntry(entry, cfg)) {
        sportsSessions.push({
          entry,
          durationMin,
          ts: entryStartTs(entry, fallbackMin) || entry.ts || 0
        });
      }
    });

    Object.entries(deepMinutesByDay).forEach(([dateKey, minutes]) => {
      if (dailyGoalMin > 0 && minutes >= dailyGoalMin) {
        earned += cfg.dailyGoalBonus;
        addBreakdown(breakdown, 'bonus', 'Daily deep goal bonus', cfg.dailyGoalBonus, { dateKey });
      }
    });

    Object.entries(wasteCostByDay).forEach(([dateKey, rawCost]) => {
      const cost = Math.min(rawCost, cfg.wastePenaltyDailyCap);
      autoCosts += cost;
      addBreakdown(breakdown, 'cost', 'Waste time cost', -cost, { dateKey });
    });

    sportsSessions.sort((a, b) => a.ts - b.ts);
    sportsSessions.forEach((session, idx) => {
      const sessionNum = idx + 1;
      let cost = 0;
      if (sessionNum > cfg.sportsFreeSessions) {
        cost += sessionNum === cfg.sportsFreeSessions + 1
          ? cfg.sportsSessionFourCost
          : cfg.sportsExtraSessionCost;
      }
      if (session.durationMin > cfg.sportsLongSessionMin) {
        cost += Math.ceil((session.durationMin - cfg.sportsLongSessionMin) / 60) * cfg.sportsLongSessionExtraHourCost;
      }
      autoCosts += cost;
      addBreakdown(breakdown, 'cost', `Sports session ${sessionNum}`, -cost, { entryId: session.entry.id });
    });

    (redemptions || []).forEach(item => {
      if (!item || item.deleted) return;
      const itemWeekKey = item.weekKey || getFocusWalletWeekKey(item.createdAt || item.ts || Date.now());
      if (itemWeekKey !== weekKey) return;
      const points = Math.max(0, Number(item.points || item.cost || 0));
      redeemed += points;
      addBreakdown(breakdown, 'spend', item.label || 'Reward', -points, { redemptionId: item.id });
    });

    const totalCosts = autoCosts + redeemed;
    return {
      weekKey,
      earned: roundPoints(earned),
      autoCosts: roundPoints(autoCosts),
      redeemed: roundPoints(redeemed),
      spent: roundPoints(totalCosts),
      balance: roundPoints(earned - totalCosts),
      sportsSessions: sportsSessions.length,
      breakdown
    };
  }

  root.DEFAULT_FOCUS_WALLET_SETTINGS = DEFAULT_FOCUS_WALLET_SETTINGS;
  root.getFocusWalletSettings = getFocusWalletSettings;
  root.getFocusWalletWeekKey = getFocusWalletWeekKey;
  root.getFocusWalletEntryDurationMin = getFocusWalletEntryDurationMin;
  root.isFocusWalletSportsEntry = isFocusWalletSportsEntry;
  root.computeFocusWallet = computeFocusWallet;
})(typeof globalThis !== 'undefined' ? globalThis : window);
