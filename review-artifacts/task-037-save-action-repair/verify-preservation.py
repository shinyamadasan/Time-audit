"""Read protected trees and verify the authorized two-line runtime delta; write own evidence only."""
from pathlib import Path
import hashlib
import json
import subprocess

root = Path(__file__).resolve().parents[2]
out = Path(__file__).resolve().parent
base = '6fcee749417a2ad49ea3a047c6988c01c0526603'
old = b'20261027-task037-online-release-repair-v1'
new = b'20261027-task037-save-action-repair-v2'

def git(at, *args):
    return subprocess.check_output(['git', '-C', str(at), *args])

def sha(data):
    return hashlib.sha256(data).hexdigest()

before = git(root, 'show', f'{base}:index.html').replace(b'\r\n', b'\n')
expected = before
for prefix in [b"renderQuickActionGrid('ql-quick-actions', option => {",
               b"renderRecentTaskGrid('ql-recent-tasks', 'ql-recent-wrap', item => {"]:
    fragment = prefix + b'\n    if (quickLogBusy) return;\n    quickLogBusy = true;'
    assert expected.count(fragment) == 1
    expected = expected.replace(fragment, prefix + b'\n    if (quickLogBusy) return;')
actual = (root / 'index.html').read_bytes().replace(b'\r\n', b'\n').replace(new, old)
assert actual == expected, 'Product delta exceeds the two authorized removals and generation token'
assert (root / 'www/index.html').read_bytes() == (root / 'index.html').read_bytes()
changed = git(root, 'diff', base, '--name-only').decode().splitlines()
allowed = {'TASKS.md', 'index.html', 'www/index.html', 'personal-day-boundary-web-runtime.test.js',
           'tests/calendar-native-plan-identity.spec.js', 'tests/online-planner-sdk-ui.spec.js',
           'CHANGELOG.md', 'TEST_REPORT.md'}
unexpected = [p for p in changed if p not in allowed and not p.startswith('review-artifacts/task-037-save-action-repair/')
              and p != 'TASK_037_SAVE_REPAIR.md']
assert not unexpected, unexpected
for file in ['tests/daily-use-reliability.spec.js', 'storage.js', 'sw.js', 'plan-authority.js',
             'plan-tomorrow-model.js', 'brain-dump-model.js', 'brain-dump-ui.js', 'brain-dump-sync.js',
             'brain-dump-promotion.js', 'plan-fence-sync.js', 'firebase.rules.json']:
    assert (root / file).read_bytes().replace(b'\r\n', b'\n') == git(root, 'show', f'{base}:{file}').replace(b'\r\n', b'\n'), file

manifest = root.parent / 'task-035-release-reliability/review-artifacts/task-035-release-reliability/PROTECTED_BEFORE.json'
protected = json.loads(manifest.read_text(encoding='utf-8'))
count = 0
for name, snapshot in protected.items():
    tree = root.parent / name
    assert git(tree, 'rev-parse', 'HEAD').decode().strip() == snapshot['head'], name
    assert git(tree, 'status', '--porcelain').decode().strip() == snapshot['status'], name
    for file, digest in snapshot['files'].items():
        assert sha((tree / file).read_bytes()) == digest, f'{name}/{file}'
        count += 1
previous = root.parent / 'task-037-online-release-repair'
assert git(previous, 'rev-parse', 'HEAD').decode().strip() == base
assert not git(previous, 'diff', 'HEAD', '--name-only').strip()
result = {'pass': True, 'base': base, 'authorizedRuntimeRemovals': 2, 'governedGeneration': new.decode(),
          'allOtherTrackedRuntimeUnchanged': True, 'protectedHistoricalTrees': len(protected),
          'protectedHistoricalHashes': count, 'previousCandidateTrackedClean': True,
          'originalSevenTestFileUnchanged': True, 'centralSaverAndOwnershipAccountingUnchanged': True}
(out / 'PRESERVATION.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result))
