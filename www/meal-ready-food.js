// Read-only extraction from Meal Prep Our Life build e678141, app.js:
// daysLeftFrom, cookedShelfLife, portionCountOrNull, cookedMealTracksPortions,
// readyFoodBucket and getReadyFoodSuggestions. Same filtering and ranking;
// the source's calendar date is injected rather than using this device's date.
// No Meal records are edited or persisted here.
(() => {
  function project(cookedMeals, today) {
    const PORTION_COUNT_MAX = 99;
    const FRESHNESS_WARN_DAYS = 2;
    const AppState = { cookedMeals };
    const todayISO = () => today;
    function daysLeftFrom(startDateStr, shelfLifeDays) {
      if (!startDateStr || shelfLifeDays == null || isNaN(shelfLifeDays)) return null;
      var start = new Date(startDateStr + 'T00:00:00');
      if (isNaN(start.getTime())) return null;
      var expiry = start.getTime() + Number(shelfLifeDays) * 86400000;
      var today = new Date(todayISO() + 'T00:00:00').getTime();
      return Math.round((expiry - today) / 86400000);
    }
    function cookedShelfLife(m) {
      var days = m.storage === 'freezer' ? m.freezerLife : m.fridgeLife;
      return days == null ? null : days;
    }
    function portionCountOrNull(value, min) {
      if (value == null || value === '') return null;
      var n = Number(value);
      if (!Number.isFinite(n)) return null;
      n = Math.floor(n);
      if (n < min) return null;
      if (n > PORTION_COUNT_MAX) return PORTION_COUNT_MAX;
      return n;
    }
    function cookedMealTracksPortions(meal) {
      return !!meal && portionCountOrNull(meal.portionsRemaining, 0) != null;
    }
    function readyFoodBucket(meal) {
      var isFreezer = (meal.storage || 'fridge') === 'freezer';
      if (isFreezer) return 2;
      var daysLeft = daysLeftFrom(meal.cookedDate, cookedShelfLife(meal));
      if (daysLeft != null && daysLeft <= FRESHNESS_WARN_DAYS) return 0;
      return 1;
    }
    function getReadyFoodSuggestions(limit) {
      var meals = (AppState.cookedMeals || []).filter(function(m) {
        if (!m || !m.name) return false;
        if (cookedMealTracksPortions(m) && m.portionsRemaining <= 0) return false;
        var daysLeft = daysLeftFrom(m.cookedDate, cookedShelfLife(m));
        if (daysLeft != null && daysLeft < 0) return false;
        return true;
      });
      meals.sort(function(a, b) {
        var bucketDiff = readyFoodBucket(a) - readyFoodBucket(b);
        if (bucketDiff) return bucketDiff;
        var da = daysLeftFrom(a.cookedDate, cookedShelfLife(a));
        var db = daysLeftFrom(b.cookedDate, cookedShelfLife(b));
        if (da == null && db != null) return 1;
        if (db == null && da != null) return -1;
        if (da != null && db != null && da !== db) return da - db;
        var pa = cookedMealTracksPortions(a) ? a.portionsRemaining : Infinity;
        var pb = cookedMealTracksPortions(b) ? b.portionsRemaining : Infinity;
        if (pa !== pb) return pa - pb;
        return String(a.name).localeCompare(String(b.name));
      });
      return limit ? meals.slice(0, limit) : meals;
    }
    return getReadyFoodSuggestions().map(meal => ({
      name: meal.name, storage: meal.storage || 'fridge',
      portions: cookedMealTracksPortions(meal) ? meal.portionsRemaining : null,
      daysLeft: daysLeftFrom(meal.cookedDate, cookedShelfLife(meal))
    }));
  }
  globalThis.MealReadyFood = Object.freeze({ project });
})();
