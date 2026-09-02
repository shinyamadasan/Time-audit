// Minimal ESLint config — no build step, runs via: npm run lint.
// Targets the extracted .js files only (not index.html which requires an HTML plugin).
export default [
  {
    files: ['life-ledger-core.js', 'chronasense-life-ledger-adapter.js', 'workout-life-ledger-adapter.js', 'meal-life-ledger-adapter.js', 'life-ledger-runtime.js', 'life-ledger-transport.js', 'life-ledger-export-ui.js', 'life-feed-model.js', 'life-feed-ui.js', 'life-character-sheet-model.js', 'life-character-sheet-ui.js', 'cross-domain-intelligence-model.js', 'cross-domain-intelligence-ui.js', 'obsidian-life-ledger-renderer.js', 'obsidian-life-ledger-writer.js', 'learning-plan-model.js', 'learning-plan-repository.js', 'learning-plan-import.js', 'learning-plan-next-action.js', 'learning-plan-ui.js', 'capability-career-model.js', 'capability-career-repository.js', 'capability-career-import.js', 'capability-career-analytics.js', 'capability-career-ui.js', 'fixtures/resolve-fixture.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Intl: 'readonly',
        Date: 'readonly',
        Math: 'readonly',
        Set: 'readonly',
        Map: 'readonly',
        JSON: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { vars: 'local', args: 'none' }],
      'no-undef': 'warn',
      'no-duplicate-case': 'error',
      'no-unreachable': 'warn',
      'eqeqeq': ['warn', 'smart'],
    }
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { vars: 'local', args: 'none' }],
      'no-undef': 'warn',
      'no-duplicate-case': 'error',
      'no-unreachable': 'warn',
      'eqeqeq': ['warn', 'smart'],
    }
  },
  {
    files: ['*.js'],
    ignores: ['www/**', 'node_modules/**', 'life-ledger-core.js', 'chronasense-life-ledger-adapter.js', 'workout-life-ledger-adapter.js', 'meal-life-ledger-adapter.js', 'life-ledger-runtime.js', 'life-ledger-transport.js', 'life-ledger-export-ui.js', 'life-feed-model.js', 'life-feed-ui.js', 'life-character-sheet-model.js', 'life-character-sheet-ui.js', 'cross-domain-intelligence-model.js', 'cross-domain-intelligence-ui.js', 'obsidian-life-ledger-renderer.js', 'obsidian-life-ledger-writer.js', 'learning-plan-model.js', 'learning-plan-repository.js', 'learning-plan-import.js', 'learning-plan-next-action.js', 'learning-plan-ui.js', 'capability-career-model.js', 'capability-career-repository.js', 'capability-career-import.js', 'capability-career-analytics.js', 'capability-career-ui.js', 'fixtures/resolve-fixture.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script', // classic <script> tags — not ES modules
      globals: {
        // Browser globals
        window: 'readonly', document: 'readonly', console: 'readonly',
        localStorage: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly', Date: 'readonly',
        Math: 'readonly', JSON: 'readonly', Promise: 'readonly', Map: 'readonly',
        Set: 'readonly', Array: 'readonly', Object: 'readonly', parseInt: 'readonly',
        parseFloat: 'readonly', isNaN: 'readonly', Intl: 'readonly', URL: 'readonly',
        fetch: 'readonly', navigator: 'readonly', location: 'readonly',
        // Firebase (CDN global)
        firebase: 'readonly',
        // Capacitor (native bridge global)
        Capacitor: 'readonly',
        // App globals defined in index.html — consumed by storage.js, focus-mode.js, insights.js
        entries: 'writable', settings: 'writable', reviews: 'writable',
        weeklyReviews: 'writable', focusRedemptions: 'writable',
        intention: 'writable', dailyCommitment: 'writable', plans: 'writable',
        snoozesUsedToday: 'writable', running: 'writable', timerStartedAt: 'writable',
        totalSecs: 'writable', remaining: 'writable', lastTaskForRepeat: 'writable',
        fbApp: 'writable', fbDb: 'writable', fbRoomRef: 'writable',
        roomCode: 'writable', timerOwnerDeviceId: 'writable', syncedFocusTimer: 'writable', ticker: 'writable',
        taskStartTime: 'writable', currentTask: 'writable', breakActive: 'writable',
        breakEndsAt: 'writable', breakTicker: 'writable', breakStartTs: 'writable',
        partnerData: 'writable', syncedDeviceId: 'writable', connectedDevices: 'writable',
        viewingDateKey: 'writable',
        // Functions defined in index.html, called from .js files
        renderToday: 'readonly', renderWeek: 'readonly', showToast: 'readonly',
        updateRing: 'readonly', updateLiveCost: 'readonly', doPing: 'readonly',
        _updateBreakDisplay: 'readonly', endBreak: 'readonly', renderPartnerCard: 'readonly',
        renderPartnerSettings: 'readonly', computeStreak: 'readonly',
        getBucket: 'readonly', toDateKey: 'readonly', tzTime: 'readonly', tzHour: 'readonly',
        tzParseTime: 'readonly', getDateInTZ: 'readonly', validateEntry: 'readonly',
        getDailyGoalHrs: 'readonly', getDailyGoalMins: 'readonly',
        getWeeklyGoalMins: 'readonly', getWorkDayStartTs: 'readonly',
        getTodayEntries: 'readonly', getEntriesForWeekKey: 'readonly',
        sumEntryMinutes: 'readonly', sumEnergyMinutes: 'readonly',
        persist: 'readonly', syncEntries: 'readonly',
        fmtDur: 'readonly', getActivityColor: 'readonly', resetTimer: 'readonly',
        _startHeartbeat: 'readonly', _stopHeartbeat: 'readonly',
        syncTimerState: 'readonly', syncFocusTimerState: 'readonly',
        syncFocusOverlayFromRemote: 'readonly', clearSyncedFocusOverlay: 'readonly',
        pomodoroPhase: 'readonly',
        buildHeroSuggestions: 'readonly', buildSugItem: 'readonly',
        triggerPenaltyMode: 'readonly', renderSettings: 'readonly',
        showHeroState: 'readonly', confirm: 'readonly',
        syncCommitmentFromPlan: 'readonly',
        requestAnimationFrame: 'readonly',
        // App globals — timer / state vars defined in index.html
        blockStartTime: 'writable', awayActive: 'writable', awayStartTime: 'writable',
        awayLabel: 'writable', awayElapsedTicker: 'writable',
        currentUser: 'writable', fbTimerReceived: 'writable',
        _feedbackTimer: 'writable',
        // Constants from storage.js
        SEAM_TOLERANCE_MS: 'readonly', MAX_GAP_MS: 'readonly', MIN_GAP_MIN: 'readonly',
        WORK_DAYS_PER_WEEK: 'readonly', NUDGE_MAX_AGE_MS: 'readonly',
      }
    },
    rules: {
      'no-unused-vars': ['warn', { vars: 'local', args: 'none' }],
      'no-undef': 'warn',
      'no-duplicate-case': 'error',
      'no-unreachable': 'warn',
      'eqeqeq': ['warn', 'smart'],
    }
  }
];
