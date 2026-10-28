"""Read protected artifacts; write only TASK-037 verification evidence."""
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[2]
out = Path(__file__).resolve().parent
worktrees = root.parent
baseline = '9aaf021afdc97c6da9baf9bb346ff7dc39a97390'
old_token = '20261027-task035-release-reliability-v1'
new_token = '20261027-task037-online-release-repair-v1'
def git(at, *args):
    return subprocess.check_output(['git', '-C', str(at), *args])
def digest(data):
    return hashlib.sha256(data).hexdigest()
def text(data):
    return data.decode('utf-8').replace('\r\n', '\n')

manifest = worktrees / 'task-035-release-reliability/review-artifacts/task-035-release-reliability/PROTECTED_BEFORE.json'
before = json.loads(manifest.read_text(encoding='utf-8'))
problems = []
protected_count = 0
for name, snapshot in before.items():
    at = worktrees / name
    if git(at, 'rev-parse', 'HEAD').decode().strip() != snapshot['head']:
        problems.append(f'{name}: HEAD differs')
    if git(at, 'status', '--porcelain').decode().strip() != snapshot['status']:
        problems.append(f'{name}: status differs')
    for name_in_tree, expected in snapshot['files'].items():
        protected_count += 1
        p = at / name_in_tree
        if not p.is_file() or digest(p.read_bytes()) != expected:
            problems.append(f'{name}/{name_in_tree}: content differs')

approved = worktrees / 'task-035-release-reliability'
approved_clean = not git(approved, 'diff', 'HEAD', '--name-only').decode().strip()
assert git(approved, 'rev-parse', 'HEAD').decode().strip() == baseline
html = text((root / 'index.html').read_bytes()).replace(new_token, old_token)
old_html = text(git(root, 'show', f'{baseline}:index.html'))
strip_scripts = lambda value: re.sub(r'(<script\b[^>]*>)[\s\S]*?</script>', r'\1</script>', value)
markup_unchanged = strip_scripts(html) == strip_scripts(old_html)
assert markup_unchanged, 'Approved static markup changed'
assert approved_clean, 'Approved reliability worktree changed'
assert not problems, problems

unchanged = ['storage.js', 'plan-authority.js', 'plan-fence-sync.js', 'plan-item-origin.js',
             'brain-dump-model.js', 'brain-dump-sync.js', 'brain-dump-ui.js', 'firebase.rules.json',
             'style.css', 'daily-command-center.js', 'daily-command-center.css', 'plan-tomorrow-ui.js',
             'plan-tomorrow.css', 'planning-continuity-ui.js', 'planning-continuity.css',
             'tests/daily-use-reliability.spec.js']
for name in unchanged:
    assert text((root / name).read_bytes()) == text(git(root, 'show', f'{baseline}:{name}')), name
tracked = git(root, 'ls-tree', '-r', '--name-only', baseline).decode().splitlines()
batch = subprocess.run(['git', '-C', str(root), 'cat-file', '--batch'],
                       input=''.join(f'{baseline}:{name}\n' for name in tracked).encode(),
                       stdout=subprocess.PIPE, check=True).stdout
stream = io.BytesIO(batch)
originals = {}
for name in tracked:
    header = stream.readline().split()
    originals[name] = stream.read(int(header[-1]))
    assert stream.read(1) == b'\n'
allowed = {'CODEMAP.md', 'TASKS.md', 'CHANGELOG.md', 'TEST_REPORT.md', 'index.html', 'sw.js',
           'plan-tomorrow-model.js', 'plan-tomorrow.test.js', 'calendar-plan-model.test.js', 'npm-test-wiring.test.js', 'package.json',
           'personal-day-boundary-web-runtime.test.js', 'tests/calendar-native-plan-identity.spec.js',
           'tests/plan-tomorrow-ui.spec.js', 'www/index.html', 'www/sw.js', 'www/plan-tomorrow-model.js',
           'functions/shared/plan-tomorrow-model.js'}
unrelated = []
for name in tracked:
    if not name or name in allowed:
        continue
    current = (root / name).read_bytes()
    original = originals[name]
    if current != original:
        try:
            if text(current) == text(original):
                continue
        except UnicodeDecodeError:
            pass
        unrelated.append(name)
assert not unrelated, unrelated
result = {'approvedCandidate': baseline, 'protectedHistoricalWorktrees': len(before),
          'protectedHistoricalHashes': protected_count, 'protectedHistoricalUnchanged': not problems,
          'referenceManifestSha256': digest(manifest.read_bytes()), 'approvedReliabilityTrackedClean': approved_clean,
          'approvedStaticMarkupUnchanged': markup_unchanged, 'unchangedContractsAndAssets': unchanged,
          'unrelatedTrackedDrift': unrelated, 'note': 'Owner test server and private state were neither stopped nor reset.'}
(out / 'PRESERVATION.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result, indent=2))
