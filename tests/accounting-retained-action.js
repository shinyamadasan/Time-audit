// Chromium can answer an evaluate that is still pending with -32000 "Promise was collected", which Playwright
// reports as a destroyed context. It happens with no navigation, even when the awaited promise is rooted on
// window. The cause is unknown. Product calls never wait on CDP, so only the test loses that reply.
import { expect } from '@playwright/test';

const HELD = Symbol.for('accounting.heldEvaluates');
const CONTEXT_LOST = 'Execution context was destroyed';
let held = 0;

// Runs one action in the page, keeping its result in the page, so no CDP reply stays pending for its duration.
function startHeld([action, arg, id]) {
  const slot = (window.__heldEvaluates ??= {})[id] = {};
  const result = action(arg);
  if (typeof result?.then !== 'function') return { value: result };
  Promise.resolve(result).then(value => { slot.outcome = { value }; },
    error => { slot.outcome = { error: String(error?.message ?? error) }; });
  return null;
}
function readHeld(id) {
  const slot = window.__heldEvaluates?.[id];
  return slot ? slot.outcome ?? null : { navigated: true };
}

// Replaces Page.evaluate for the rest of the worker, whichever spec runs next. Reads repeat safely, so a lost
// reply there is simply read again. The action still runs exactly once, and a navigation still rejects.
export function holdEvaluates(test) {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const prototype = Object.getPrototypeOf(page);
    await page.close();
    if (prototype[HELD]) return;
    const direct = prototype.evaluate;
    prototype[HELD] = true;
    prototype.evaluate = async function (action, arg) {
      if (typeof action !== 'function') return direct.call(this, action, arg);
      const handle = await this.evaluateHandle(new Function(`return (${action})`));
      const id = ++held;
      const started = await direct.call(this, startHeld, [handle, arg, id]);
      if (started) return started.value;
      for (let lost = 0; ;) {
        let outcome;
        try { outcome = await direct.call(this, readHeld, id); } catch (error) {
          if (!error.message.includes(CONTEXT_LOST) || ++lost > 3) throw error;
          continue;
        }
        if (outcome?.navigated) throw Error(`page.evaluate: ${CONTEXT_LOST}, most likely because of a navigation.`);
        if (outcome?.error != null) throw Error(`page.evaluate: Error: ${outcome.error}`);
        if (outcome) return outcome.value;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
  });
}

// Any hydrate or ping in flight refuses Undo with a toast, before anything changes, and a person taps again.
// The gate and the Undo share one page tick, so a test waits only for that refusal and never skips a real one.
export async function acknowledgedUndo(page) {
  let result = null;
  await expect.poll(async () => (result = await page.evaluate(() => _timeAckBusy || timeAckBlocks('Undo') ? null : undoLastAction()))).not.toBeNull();
  return result;
}

export async function retainedAccountingResult(page, name) {
  await page.evaluate(name => {
    const commands = { stop: stopAndLog, 'take-over': takeOverActiveTimer, 'focus-end-work': endWorkSession,
      'focus-end-pomodoro-break': endPomodoroBreak, 'end-break': endBreak };
    const operation = Promise.resolve(commands[name]());
    window.__retainedQualification = { operation };
    operation.then(result => { window.__retainedQualification.outcome = { result }; },
      error => { window.__retainedQualification.outcome = { error: error.message }; });
  }, name);
  await expect.poll(() => page.evaluate(() => window.__retainedQualification?.outcome), { timeout: 30_000 }).toBeDefined();
  const { result, error } = await page.evaluate(() => window.__retainedQualification.outcome);
  if (error) throw Error(error);
  return result;
}
