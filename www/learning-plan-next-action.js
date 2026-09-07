export function findNextLearningPlanStep(plan) {
  if (!plan || !Array.isArray(plan.phases)) return null;

  for (let phaseIndex = 0; phaseIndex < plan.phases.length; phaseIndex++) {
    const phase = plan.phases[phaseIndex];
    if (!phase || !Array.isArray(phase.lessons)) continue;

    for (let lessonIndex = 0; lessonIndex < phase.lessons.length; lessonIndex++) {
      const lesson = phase.lessons[lessonIndex];
      if (!lesson || !Array.isArray(lesson.steps)) continue;

      for (let stepIndex = 0; stepIndex < lesson.steps.length; stepIndex++) {
        const step = lesson.steps[stepIndex];
        if (!step || step.completed !== false) continue;

        return {
          phaseId: phase.id,
          phaseTitle: phase.title,
          phaseIndex,
          lessonId: lesson.id,
          lessonTitle: lesson.title,
          lessonIndex,
          stepId: step.id,
          stepTitle: step.title,
          stepIndex
        };
      }
    }
  }

  return null;
}

export const LEARNING_PLAN_NEXT_ACTION_V1 = Object.freeze({
  ordering: 'phase-lesson-step-array-order',
  completionField: 'completed === false'
});
