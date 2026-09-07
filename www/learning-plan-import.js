function countDraft(phases) {
  let lessons = 0;
  let steps = 0;
  phases.forEach(phase => {
    lessons += phase.lessons.length;
    phase.lessons.forEach(lesson => {
      steps += lesson.steps.length;
    });
  });
  return { phases: phases.length, lessons, steps };
}

function parseLine(line) {
  const content = line.trimStart();
  if (!content.trim()) return { kind: 'blank' };
  const lessonMatch = content.match(/^##(?!#)\s+(.*)$/);
  if (lessonMatch) return { kind: 'lesson', title: lessonMatch[1].trim() };
  const phaseMatch = content.match(/^#(?!#)\s+(.*)$/);
  if (phaseMatch) return { kind: 'phase', title: phaseMatch[1].trim() };
  const stepMatch = content.match(/^[-*]\s+(.*)$/);
  if (stepMatch) return { kind: 'step', title: stepMatch[1].trim() };
  return { kind: 'unsupported' };
}

function error(line, code, message, content, expected = '"# Phase", "## Lesson", or "- Step"') {
  return {
    line,
    code,
    message,
    content,
    expected
  };
}

function validateOpenLesson(lesson, errors) {
  if (lesson && lesson.steps.length === 0) {
    errors.push(error(
      lesson.line,
      'empty_lesson',
      `Line ${lesson.line}: Lesson "${lesson.title}" must contain at least one step.`,
      lesson.raw,
      '- Step'
    ));
  }
}

function validateOpenPhase(phase, errors) {
  if (phase && phase.lessons.length === 0) {
    errors.push(error(
      phase.line,
      'empty_phase',
      `Line ${phase.line}: Phase "${phase.title}" must contain at least one lesson.`,
      phase.raw,
      '## Lesson'
    ));
  }
}

function publicDraft(phases) {
  return phases.map(phase => ({
    title: phase.title,
    lessons: phase.lessons.map(lesson => ({
      title: lesson.title,
      steps: lesson.steps.map(step => ({ title: step.title }))
    }))
  }));
}

export function parseLearningPlanOutline(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const phases = [];
  const errors = [];
  let currentPhase = null;
  let currentLesson = null;

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const parsed = parseLine(raw);
    if (parsed.kind === 'blank') return;

    if (parsed.kind === 'phase') {
      if (!parsed.title) {
        errors.push(error(lineNumber, 'empty_phase_title', `Line ${lineNumber}: Phase title cannot be blank.`, raw, '# Phase'));
        currentPhase = null;
        currentLesson = null;
        return;
      }
      validateOpenLesson(currentLesson, errors);
      validateOpenPhase(currentPhase, errors);
      currentPhase = { title: parsed.title, lessons: [], line: lineNumber, raw };
      phases.push(currentPhase);
      currentLesson = null;
      return;
    }

    if (parsed.kind === 'lesson') {
      if (!parsed.title) {
        errors.push(error(lineNumber, 'empty_lesson_title', `Line ${lineNumber}: Lesson title cannot be blank.`, raw, '## Lesson'));
        currentLesson = null;
        return;
      }
      if (!currentPhase) {
        errors.push(error(lineNumber, 'lesson_before_phase', `Line ${lineNumber}: Lesson must come after a phase.`, raw, '# Phase'));
        currentLesson = null;
        return;
      }
      validateOpenLesson(currentLesson, errors);
      currentLesson = { title: parsed.title, steps: [], line: lineNumber, raw };
      currentPhase.lessons.push(currentLesson);
      return;
    }

    if (parsed.kind === 'step') {
      if (!parsed.title) {
        errors.push(error(lineNumber, 'empty_step_title', `Line ${lineNumber}: Step title cannot be blank.`, raw, '- Step'));
        return;
      }
      if (!currentPhase) {
        errors.push(error(lineNumber, 'step_before_phase', `Line ${lineNumber}: Step must come after a phase and lesson.`, raw, '# Phase, then ## Lesson'));
        return;
      }
      if (!currentLesson) {
        errors.push(error(lineNumber, 'step_before_lesson', `Line ${lineNumber}: Step must come after a lesson.`, raw, '## Lesson'));
        return;
      }
      currentLesson.steps.push({ title: parsed.title, line: lineNumber, raw });
      return;
    }

    errors.push(error(
      lineNumber,
      'unsupported_line',
      `Line ${lineNumber}: Expected "# Phase", "## Lesson", or "- Step".`,
      raw
    ));
  });

  validateOpenLesson(currentLesson, errors);
  validateOpenPhase(currentPhase, errors);

  const counts = countDraft(phases);
  if (counts.phases === 0) {
    errors.push(error(1, 'no_phases', 'Outline must include at least one phase.', '', '# Phase'));
  }
  if (counts.lessons === 0) {
    errors.push(error(1, 'no_lessons', 'Outline must include at least one lesson.', '', '## Lesson'));
  }
  if (counts.steps === 0) {
    errors.push(error(1, 'no_steps', 'Outline must include at least one step.', '', '- Step'));
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    phases: publicDraft(phases),
    counts
  };
}
