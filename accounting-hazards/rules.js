// Local-only accounting rules. Production builder/artifact and planning/API rules stay unchanged.
import { cancellationRules } from '../unknown-recovery-proof/recovery.js';

export function accountingCommandRules() {
  const rules = cancellationRules(), room = rules.rules.rooms.$roomId;
  const next = "newData.child('_csWrite')", previous = "data.child('_csWrite')";
  const revision = [
    'newData.exists()', `${next}.child('v').val() === 1`,
    `(!${previous}.exists() || (${previous}.child('v').val() === 1 && ${previous}.child('revision').isNumber() && ${previous}.child('revision').val() > 0 && ${previous}.child('revision').val() % 1 === 0))`,
    `${next}.child('baseRevision').isNumber()`,
    `${next}.child('baseExists').val() === data.exists()`,
    `${next}.child('baseRevision').val() === (${previous}.exists() ? ${previous}.child('revision').val() : 0)`,
    `${next}.child('revision').isNumber()`, `${next}.child('revision').val() % 1 === 0`,
    `${next}.child('revision').val() > 0`, `${next}.child('revision').val() <= 9007199254740991`,
    `${next}.child('revision').val() === ${next}.child('baseRevision').val() + 1`,
  ].map(part => `(${part})`).join(' && ');
  for (const node of [room.timer, room.entries.$entryId]) node['.write'] = `(${node['.write']}) && ${revision}`;
  const grant = room.focusRedemptions['.write'];
  delete room.focusRedemptions['.write'];
  room.focusRedemptions.$redemptionId['.write'] = `(${grant}) && ${revision}`;
  return rules;
}

// LOCAL ONLY. New identities bind to one physical child; pre-existing identical aliases
// may be updated together, retaining both source records and their own revisions.
export function physicalWriterRules() {
  const rules = accountingCommandRules(), entry = rules.rules.rooms.$roomId.entries.$entryId;
  const id = "('' + newData.child('id').val())";
  const otherKey = `($entryId === ${id} ? 'e_' + ${id} : ${id})`;
  const oldOther = `data.parent().child(${otherKey})`, nextOther = `newData.parent().child(${otherKey})`;
  const binding = [
    `($entryId === ${id} || $entryId === 'e_' + ${id})`,
    `(!data.exists() || newData.child('id').val() === data.child('id').val())`,
    `(data.exists() || !${nextOther}.exists())`,
    `(!${oldOther}.exists() || (${nextOther}.exists() && ${nextOther}.child('id').val() === newData.child('id').val() && ${nextOther}.child('_csWrite/operationId').val() === newData.child('_csWrite/operationId').val() && ${nextOther}.child('_csWrite/revision').val() === (${oldOther}.child('_csWrite').exists() ? ${oldOther}.child('_csWrite/revision').val() : 0) + 1))`,
  ].map(part => `(${part})`).join(' && ');
  entry['.write'] = `(${entry['.write']}) && ${binding}`;
  return rules;
}
