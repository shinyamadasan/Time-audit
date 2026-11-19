// my-day-work-model.js — My Day Unified Command Center V1: the "Today's work" tile's lines.
//
// Pure and read-only. It turns counts the existing My Day sections already hold (planned tasks,
// learning-routine steps, SOP runs) into one line each, plus the id of the My Day section that
// manages it. Nothing here reads storage, writes plans, starts timers or touches accounting.
// Classic script: attaches MyDayWorkModel to globalThis (browser and node tests).
(function (root) {
  'use strict';
  const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

  /**
   * @param {{ tasks?: {total:number, done:number}|null,
   *           learning?: Array<{planTitle:string, stepTitle:string, complete:boolean}>|null,
   *           sop?: {linked:number, complete:number}|null }} input  null = that section has not loaded yet
   * @returns {Array<{key:'tasks'|'learning'|'sop', text:string, target:string}>}
   */
  function workLines({ tasks = null, learning = null, sop = null } = {}) {
    const taskText = !tasks ? 'Tasks · loading…'
      : tasks.total ? `Tasks · ${tasks.done}/${tasks.total} done` : 'Tasks · none planned today';
    let learningText = 'Learning · loading…';
    if (Array.isArray(learning)) {
      const due = learning.filter(step => !step.complete);
      learningText = !learning.length ? 'Learning · no learning step today'
        : due.length ? `Learning · ${plural(due.length, 'step')} today · Next: ${due[0].stepTitle}`
          : `Learning · ${plural(learning.length, 'step')} done today`;
    }
    const sopText = !sop ? 'Procedures · loading…'
      : sop.linked ? `Procedures · ${sop.complete}/${plural(sop.linked, 'SOP run')} complete` : 'Procedures · no task linked to an SOP';
    return [
      { key: 'tasks', text: taskText, target: 'timeline-section' },
      { key: 'learning', text: learningText, target: 'daily-routines' },
      { key: 'sop', text: sopText, target: 'sop-execution' },
    ];
  }


  root.MyDayWorkModel = { workLines };
})(globalThis);
