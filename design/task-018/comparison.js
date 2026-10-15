// Screenshot viewer only. No design selection, persistence or production connection.
document.querySelectorAll('[data-state]').forEach(button => button.addEventListener('click', () => {
  const state = button.dataset.state;
  document.querySelectorAll('[data-state]').forEach(control => control.setAttribute('aria-pressed', String(control === button)));
  document.querySelectorAll('img[data-option]').forEach(img => {
    img.src = `../../playwright-report/task-018-design/${img.dataset.option}-mobile-${state}.png`;
    img.alt = `Actual rendered option ${img.dataset.option}, mobile ${state}`;
  });
}));
