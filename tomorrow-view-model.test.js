import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveTomorrowViewState } from './tomorrow-view-model.js';

const preparation = (overrides = {}) => ({
  schemaVersion: 1, targetDate: '2026-09-14', timezone: 'Etc/UTC',
  firstPreparedAt: 1, firstPreparedMode: 'normal', lastPreparedAt: 1, lastPreparedMode: 'normal',
  updatedBy: 'device-a', intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: [],
  ...overrides
});

test('no preparation and no content is the true empty state', () => {
  assert.equal(deriveTomorrowViewState({ preparation: null, activeItemCount: 0, applicableRoutineCount: 0 }), 'unprepared-empty');
});

test('no preparation but active items exist is content-without-preparation, never "prepared"', () => {
  assert.equal(deriveTomorrowViewState({ preparation: null, activeItemCount: 1, applicableRoutineCount: 0 }), 'unprepared-content');
});

test('no preparation but an applicable routine exists is also content-without-preparation', () => {
  assert.equal(deriveTomorrowViewState({ preparation: null, activeItemCount: 0, applicableRoutineCount: 1 }), 'unprepared-content');
});

test('a confirmed, non-blank preparation is prepared regardless of live item/routine counts', () => {
  assert.equal(deriveTomorrowViewState({ preparation: preparation(), activeItemCount: 0, applicableRoutineCount: 0 }), 'prepared');
  assert.equal(deriveTomorrowViewState({ preparation: preparation(), activeItemCount: 2, applicableRoutineCount: 1 }), 'prepared');
});

test('an explicit intentionalBlank preparation is Open Day, never inferred from zero items', () => {
  assert.equal(deriveTomorrowViewState({ preparation: preparation({ intentionalBlank: true }), activeItemCount: 0, applicableRoutineCount: 0 }), 'open-day');
});

test('zero items alone is never Open Day without an authoritative preparation record', () => {
  assert.equal(deriveTomorrowViewState({ preparation: null, activeItemCount: 0, applicableRoutineCount: 0 }), 'unprepared-empty');
  assert.notEqual(deriveTomorrowViewState({ preparation: null, activeItemCount: 0, applicableRoutineCount: 0 }), 'open-day');
});

test('missing arguments default to the empty state rather than throwing', () => {
  assert.equal(deriveTomorrowViewState(), 'unprepared-empty');
  assert.equal(deriveTomorrowViewState({}), 'unprepared-empty');
});
