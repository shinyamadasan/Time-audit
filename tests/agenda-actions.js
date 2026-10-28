// The command center deliberately puts source actions behind an explicit disclosure.
// Retained domain tests still perform their original action and assertions after opening it.
export async function revealAgendaItem(action) {
  const detail = action.locator('xpath=ancestor::details[contains(@class,"command-card")]');
  if (await detail.count() && !await detail.evaluate(element => element.open)) {
    await detail.locator(':scope > summary').click();
  }
}
