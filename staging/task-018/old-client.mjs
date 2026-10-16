// Released-client compatibility replay against STAGING: the real cf43080 calendar plan bridge over the same compat
// SDK (10.12.2) index.html loads, signed in as a synthetic staging user. Hosts come only from the guarded config.
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/database';
import { memoryStorage } from '../../calendar-plan-test-support.js';
import { createCalendarPlanRepository as oldRepository } from '../../fixtures/cf43080-client/calendar-plan-repository.js';
import { createCalendarPlanSyncBridge as oldBridge } from '../../fixtures/cf43080-client/calendar-plan-sync.js';
import { assertStagingConfig } from './guard.mjs';

firebase.setLogLevel('silent');

export async function releasedClientReplay(config, { email, password, uid, date, targetId }) {
  assertStagingConfig(config);
  const { apiKey, authDomain, databaseURL, projectId } = config;
  const app = firebase.initializeApp({ apiKey, authDomain, databaseURL, projectId }, `staging-released-${Date.now()}`);
  try {
    const credential = await app.auth().signInWithEmailAndPassword(email, password);
    if (credential.user.uid !== uid) throw new Error('released client signed in as an unexpected account');
    const roomId = `uid_${uid}`, roomRef = app.database().ref(`rooms/${roomId}`);
    const repository = oldRepository({ storage: memoryStorage(), getOwner: () => roomId, getTimezone: () => 'Etc/UTC' });
    const bridge = oldBridge({ repository, getRoomRef: () => roomRef, getRoomId: () => roomId });
    await bridge.hydrateAll();
    const before = repository.read(date);
    if (!before?.items?.length) throw new Error('released client did not hydrate the synthetic plan');
    const now = Date.now();
    repository.write(date, before.items.map(item => ({ ...item, updatedAt: now, updatedBy: 'released', task: `${item.task} (released-client edit)` })),
      { updatedBy: 'released', now });
    const first = await bridge.pushPlan(targetId), second = await bridge.pushPlan(targetId); // second = reconnect replay
    return { kind: 'cf43080-sdk', committed: [first?.committed === true, second?.committed === true] };
  } finally {
    await app.auth().signOut().catch(() => {});
    await app.delete();
  }
}
