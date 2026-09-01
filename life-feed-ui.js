// Unified Life Feed — UI (Phase 6 V1).
//
// Renders the read-only cross-domain timeline into #view-life from the ChronaSense Life
// Ledger runtime store ONLY. It never queries Meal or Workout, never writes anything back,
// and never revises/tombstones a ledger event — it is a projection of
// buildLifeFeed(store.listEvents()).

import { createLocalLifeLedgerStore } from './life-ledger-runtime.js';
import { buildLifeFeed, filterLifeFeed, LIFE_FEED_FILTERS, LIFE_FEED_DOMAIN_LABELS } from './life-feed-model.js';

let activeDomain = 'all';
let cachedFeed = null;
let cachedSignature = '';
let initialized = false;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mount() {
  return document.getElementById('life-feed-root');
}

// Cheap change-detector so switching to the Life tab without any new ledger activity reuses
// the already-built feed instead of recomputing over the whole history.
function signatureFor(events) {
  let signature = `${events.length}`;
  for (const event of events) {
    signature += `|${event.eventId}:${event.revision}:${event.tombstone && event.tombstone.active ? 1 : 0}`;
  }
  return signature;
}

function loadFeed() {
  let events;
  try {
    events = createLocalLifeLedgerStore().listEvents();
  } catch (err) {
    return { error: err && err.message ? err.message : 'Life Ledger storage could not be read.' };
  }
  const signature = signatureFor(events);
  if (!cachedFeed || signature !== cachedSignature) {
    cachedFeed = buildLifeFeed(events, { now: new Date() });
    cachedSignature = signature;
  }
  return { feed: cachedFeed };
}

function filterChipsHtml(feed) {
  return LIFE_FEED_FILTERS.map(domain => {
    const label = domain === 'all' ? 'All' : LIFE_FEED_DOMAIN_LABELS[domain];
    const count = domain === 'all' ? feed.counts.all : feed.counts[domain];
    const pressed = domain === activeDomain;
    return `<button type="button" class="life-feed-chip" role="tab" aria-selected="${pressed}" `
      + `aria-pressed="${pressed}" data-life-feed-domain="${domain}">`
      + `${escapeHtml(label)} <span class="life-feed-chip-count">${count}</span></button>`;
  }).join('');
}

function itemHtml(item) {
  const timeText = item.displayTimeRange || item.displayTime || '';
  const timeHtml = timeText
    ? `<span class="life-feed-time">${escapeHtml(timeText)}</span>`
    : '<span class="life-feed-time life-feed-time-none" aria-hidden="true">·</span>';
  const detailHtml = item.detail
    ? `<div class="life-feed-detail">${escapeHtml(item.detail)}</div>`
    : '';
  return `<li class="life-feed-item life-feed-domain-${item.domain}">`
    + `<span class="life-feed-domain-tag">${escapeHtml(item.domainLabel)}</span>`
    + `<div class="life-feed-body">`
    + `<div class="life-feed-line">${timeHtml}<span class="life-feed-title">${escapeHtml(item.title)}</span></div>`
    + detailHtml
    + `</div></li>`;
}

function dayHtml(day) {
  return `<section class="life-feed-day" aria-label="${escapeHtml(day.label)}">`
    + `<h2 class="life-feed-day-header">${escapeHtml(day.label)}`
    + (day.isToday || day.isYesterday ? ` <span class="life-feed-day-date">${escapeHtml(day.absoluteDate)}</span>` : '')
    + `</h2>`
    + `<ol class="life-feed-list">${day.items.map(itemHtml).join('')}</ol>`
    + `</section>`;
}

function emptyStateHtml(view) {
  if (view.activeDomain && view.activeDomain !== 'all') {
    const label = LIFE_FEED_DOMAIN_LABELS[view.activeDomain];
    return `<p class="life-feed-empty">No ${escapeHtml(label)} events in your Life Ledger yet.</p>`;
  }
  return '<p class="life-feed-empty">Nothing recorded yet. As you log time, finish learning steps, '
    + 'work out, or prep and eat meals, your life timeline builds here.</p>';
}

function render() {
  const root = mount();
  if (!root) return;
  const result = loadFeed();

  if (result.error) {
    root.innerHTML = `<p class="life-feed-error" role="alert">Could not load your Life Ledger: ${escapeHtml(result.error)}</p>`;
    return;
  }

  const feed = result.feed;
  const view = filterLifeFeed(feed, activeDomain);
  const parts = [`<div class="life-feed-filters" role="tablist" aria-label="Filter life feed by area">${filterChipsHtml(feed)}</div>`];

  if (view.isEmpty) {
    parts.push(emptyStateHtml(view));
  } else {
    parts.push(view.days.map(dayHtml).join(''));
  }

  if (feed.skipped.length) {
    parts.push(`<p class="life-feed-skipped">${feed.skipped.length} `
      + `${feed.skipped.length === 1 ? 'event' : 'events'} not shown (unrecognized type).</p>`);
  }

  root.innerHTML = parts.join('');
}

function onClick(event) {
  const chip = event.target.closest('[data-life-feed-domain]');
  if (!chip) return;
  const domain = chip.getAttribute('data-life-feed-domain');
  if (!LIFE_FEED_FILTERS.includes(domain) || domain === activeDomain) return;
  activeDomain = domain;
  render();
  const focusTarget = mount()?.querySelector(`[data-life-feed-domain="${domain}"]`);
  if (focusTarget) focusTarget.focus();
}

function init() {
  if (initialized) return;
  initialized = true;
  const view = document.getElementById('view-life');
  if (view) view.addEventListener('click', onClick);
}

export function renderLifeFeed() {
  init();
  render();
}

if (typeof window !== 'undefined') {
  window.renderLifeFeed = renderLifeFeed;
  init();
}
