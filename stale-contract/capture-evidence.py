"""Capture only local, synthetic proof evidence; no network or production credentials."""
import gzip
import hashlib
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'review-artifacts/task-039-stale-contract'
BASELINE = 'b662d14616e5744807304d0621f6354392d2c2be'


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT).decode('utf-8').strip()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


log_names = ['first-run.log', 'emulator-run-1.log', 'emulator-run-2.log',
             'emulator-final.log', 'emulator-final-26.log']
logs = {}
for name in log_names:
    raw_path = ROOT / 'stale-contract' / name
    raw = raw_path.read_bytes() if raw_path.exists() else gzip.decompress((OUT / (name + '.gz')).read_bytes())
    compressed = OUT / (name + '.gz')
    compressed.write_bytes(gzip.compress(raw, mtime=0))
    logs[name] = {'raw_sha256': hashlib.sha256(raw).hexdigest(), 'gzip_sha256': sha(compressed)}
final = gzip.decompress((OUT / 'emulator-final-26.log.gz').read_bytes()).decode('utf-8')
counts = {key: int(re.search(r'\b' + key + r' (\d+)', final).group(1))
          for key in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']}
assert counts == {'tests': 26, 'pass': 26, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}, counts
write('RESULTS.json', {'baseline': BASELINE, 'command': 'node --test --test-concurrency=1 stale-contract/proof.test.js',
      'TZ': 'America/Phoenix', 'node': subprocess.check_output(['node', '--version']).decode().strip(),
      'counts': counts, 'coverage_percentage': 'not measured', 'logs': logs,
      'full_suites': 'not rerun; canonical production/approved regression sources unchanged',
      'guardian': 'NOT RUN / NOT PASSED', 'production': 'NO-GO'})

allowed = {'TASKS.md', 'CHANGELOG.md', 'TEST_REPORT.md'}
tracked = git('ls-tree', '-r', '--name-only', BASELINE).splitlines()
all_changes = git('diff', BASELINE, '--name-only').splitlines()
tracked_changes = [name for name in all_changes if name in tracked]
assert set(tracked_changes) <= allowed, tracked_changes
assert all(name in allowed or name == 'TASK_039_STALE_CONTRACT.md'
           or name.startswith(('stale-contract/', 'review-artifacts/task-039-stale-contract/'))
           for name in all_changes), all_changes
prior_checkout = ROOT.parent / 'task-039-final-local-safety'
same_bytes, eol_only, changed_documentation = [], [], []
for name in tracked:
    actual = (ROOT / name).read_bytes()
    previous = (prior_checkout / name).read_bytes()
    if actual == previous:
        same_bytes.append(name)
    elif name in allowed:
        changed_documentation.append(name)
    else:
        assert actual.replace(b'\r\n', b'\n') == previous.replace(b'\r\n', b'\n'), name
        eol_only.append(name)
prior_hashes = json.loads((ROOT / 'review-artifacts/task-039-final-local-safety/SOURCE_HASHES.json').read_text())['files']
source_check = {name: {'current_sha256': sha(ROOT / name), 'prior_evidence_sha256': expected,
                      'exact_byte_match': sha(ROOT / name) == expected}
                for name, expected in prior_hashes.items()}
write('PRESERVATION.json', {'baseline': BASELINE, 'tracked_changes': tracked_changes,
      'baseline_tracked_files': len(tracked), 'same_checkout_bytes': len(same_bytes),
      'documentation_changes': changed_documentation, 'checkout_EOL_only_git_blobs_unchanged': eol_only,
      'prior_source_hashes': source_check,
      'unchanged': 'all baseline Git blobs except own append-only TASKS/CHANGELOG/TEST_REPORT entries',
      'frozen_PR20_head_local_ref': git('rev-parse', 'task-039-hosted-ci-repair'),
      'frozen_gateway_ref': git('rev-parse', 'task-039-gateway-hardening'),
      'remote_operations': 'none; local refs only'})
files = [str(path.relative_to(ROOT)).replace('\\', '/')
         for directory in ['stale-contract', 'review-artifacts/task-039-stale-contract']
         for path in (ROOT / directory).rglob('*') if path.is_file() and path.suffix != '.log'
         and path.name != 'SOURCE_HASHES.json']
files.append('TASK_039_STALE_CONTRACT.md')
write('SOURCE_HASHES.json', {'baseline': BASELINE, 'files': {name: sha(ROOT / name) for name in sorted(files)}})
assert git('rev-parse', 'task-039-hosted-ci-repair') == '122d3835f7114503d9be5ea581227b0d95fb9d9d'
assert git('rev-parse', 'task-039-final-local-safety') == BASELINE
assert git('rev-parse', 'task-039-gateway-hardening') == 'c224180f1d0bdc00264dffd3abb132ad91b8c27a'
print(json.dumps({'counts': counts, 'baseline_files': len(tracked), 'byte_identical': len(same_bytes),
                  'EOL_only_count': len(eol_only), 'tracked_changes': tracked_changes}, indent=2))
