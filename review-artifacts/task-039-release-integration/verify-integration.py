"""Verify the source composition and protected input worktrees; write only own evidence."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

root = Path(__file__).resolve().parents[2]
out = Path(__file__).resolve().parent
manifest = json.loads((out / 'IMPORT_PROVENANCE.json').read_text(encoding='utf8'))
main, approved = manifest['currentRemoteMain'], manifest['approvedCandidate']
old_token = b'20261027-task037-save-action-repair-v2'
token = b'20261027-task039-release-integration-v1'

def git(*args, at=root):
    return subprocess.check_output(['git', '-C', str(at), *args])

def canonical(data, name):
    return data if name.endswith(('.png', '.woff2', '.gz', '.zip')) else data.replace(b'\r\n', b'\n')

def blob(ref, name):
    # Object IDs avoid Windows path-stat limits for deeply nested historical evidence.
    object_id = manifest['importedPaths'][name]['approvedBlob'] if ref == approved and name in manifest['importedPaths'] else git('rev-parse', f'{ref}:{name}').decode().strip()
    return canonical(git('cat-file', 'blob', object_id), name)

assert git('rev-parse', 'HEAD').decode().strip() in [main] or git('rev-parse', 'HEAD^').decode().strip() == main
candidate_index = blob(approved, 'index.html')
start = candidate_index.index(b'// Auto-start "PC Time" on fresh browser open')
end = candidate_index.index(b'// Auto-start on mobile / native:', start)
mobile = re.search(rb'const isMobileBrowser = [^\n]+\n', candidate_index[start:end]).group()
expected = candidate_index[:start] + mobile + candidate_index[end:]
anchor = b'    "./commitments-repository.js": '
assert expected.count(anchor) == 1
expected = expected.replace(anchor, b'    "./commitments-model.js": "./commitments-model.js?v=' + old_token + b'",\n' + anchor)
expected = expected.replace(old_token, token)
actual = canonical((root / 'index.html').read_bytes(), 'index.html')
assert actual == expected, 'Unexpected index integration delta'
assert (root / 'www/index.html').read_bytes() == (root / 'index.html').read_bytes()

special = {'index.html', 'www/index.html', 'firebase-rules.test.js', 'firebase-rules-emulator.test.js',
           'personal-day-boundary-web-runtime.test.js', 'tests/calendar-native-plan-identity.spec.js'}
for name in manifest['importedPaths']:
    if name not in special:
        assert canonical((root / name).read_bytes(), name) == blob(approved, name), f'Approved input changed: {name}'
for name in manifest['retainedMainOnlyPaths']:
    if name not in ['TASKS.md', 'CHANGELOG.md', 'TEST_REPORT.md']:
        assert canonical((root / name).read_bytes(), name) == blob(main, name), f'Main input changed: {name}'
for name in ['commitments-model.js', 'functions/shared/commitments-model.js', 'www/commitments-model.js',
             'functions/src/identity.js', 'functions/src/plan-mutation-action.js',
             'workers/chronasense-conversational-bridge/src/index.js',
             'workers/chronasense-conversational-bridge/src/mcp.js', 'tests/no-pc-autostart.spec.js']:
    assert canonical((root / name).read_bytes(), name) == blob(main, name), name
assert canonical((root / 'firebase.rules.json').read_bytes(), 'firebase.rules.json') == blob(approved, 'firebase.rules.json')

before = json.loads((out / 'PROTECTED_BEFORE.json').read_text(encoding='utf8'))
count = 0
for name, snapshot in before.items():
    tree = Path(name)
    assert git('rev-parse', 'HEAD', at=tree).decode().strip() == snapshot['head'], name
    assert git('status', '--porcelain', at=tree).decode().strip() == snapshot['status'], f'{name}: status drift'
    for file, digest in snapshot['trackedSha256'].items():
        assert hashlib.sha256((tree / file).read_bytes()).hexdigest() == digest, f'{name}/{file}'
        count += 1
assert git('rev-parse', 'main').decode().strip() == manifest['localMain']
result = {'pass': True, 'base': main, 'approvedCandidate': approved, 'protectedTrees': len(before),
          'protectedTrackedHashes': count, 'localMainUnchanged': True, 'approvedRulesExact': True,
          'mainBackendWorkerAndCommitmentFixExact': True,
          'indexDeltaFromApproved': 'retain main desktop PC-autostart removal; add commitment-model map entry; unified generation',
          'approvedRuntimeAndOriginalStrictTestsRetained': True}
(out / 'PRESERVATION.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf8')
print(json.dumps(result))
