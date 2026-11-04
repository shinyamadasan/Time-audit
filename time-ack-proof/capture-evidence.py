"""Capture only local synthetic proof evidence. No production or remote operations."""
import gzip
import hashlib
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'review-artifacts/task-039-time-ack'
BASE = 'cfa2864576d5cac6a7ecfbedbc1d7791e2eb5806'


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT).decode('utf-8').strip()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(name, obj):
    (OUT / name).write_text(json.dumps(obj, indent=2) + '\n', encoding='utf-8')


names = ['attempt-1.log', 'attempt-2.log', 'attempt-3.log', 'final.log',
         'baseline-eight-attempt-1.log', 'baseline-eight-final.log']
logs = {}
for name in names:
    source = ROOT / 'time-ack-proof' / name
    compressed = OUT / (name + '.gz')
    raw = source.read_bytes() if source.exists() else gzip.decompress(compressed.read_bytes())
    compressed.write_bytes(gzip.compress(raw, mtime=0))
    logs[name] = {'raw_sha256': hashlib.sha256(raw).hexdigest(), 'gzip_sha256': sha(compressed)}
final = gzip.decompress((OUT / 'final.log.gz').read_bytes()).decode('utf-8')
counts = {key: int(re.search(r'\b' + key + r' (\d+)', final).group(1))
          for key in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']}
assert counts == {'tests': 35, 'pass': 35, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}
eight = json.loads((OUT / 'BASELINE_EIGHT_RESULTS.json').read_text(encoding='utf-8'))
assert (eight['scenarios'], eight['failed'], eight['skipped']) == (8, 0, 0)
assert eight['harnessSHA256'] == 'c9667bb3a30a4e20abdf67388c682b8fe48b1641ef0e07dd85769eddae428f12'
assert sha(OUT / 'baseline-exact/undo-boundary-proof.mjs') == eight['harnessSHA256']

allowed = {'TASKS.md', 'CHANGELOG.md', 'TEST_REPORT.md', 'TASK_039_TIME_ACK_PROOF.md'}
changed = git('diff', BASE, '--name-only').splitlines()
assert all(name in allowed or name.startswith(('time-ack-proof/', 'review-artifacts/task-039-time-ack/'))
           for name in changed), changed
prior = json.loads((ROOT / 'review-artifacts/task-039-final-local-safety/SOURCE_HASHES.json').read_text())['files']
production = {name: expected for name, expected in prior.items()
              if not name.startswith('release-safety/') and name != 'TASK_039_FINAL_LOCAL_SAFETY.md'}
assert all(sha(ROOT / name) == expected for name, expected in production.items())
refs = {'task-039-stale-write-integration': BASE,
        'task-039-stale-contract-proof': 'c7951add89bd0b4adcee13ebc9287f4c7caed875',
        'task-039-final-local-safety': 'b662d14616e5744807304d0621f6354392d2c2be',
        'task-039-hosted-ci-repair': '122d3835f7114503d9be5ea581227b0d95fb9d9d',
        'task-039-gateway-hardening': 'c224180f1d0bdc00264dffd3abb132ad91b8c27a'}
assert all(git('rev-parse', name) == expected for name, expected in refs.items())
write('RESULTS.json', {'baseline': BASE, 'scope': 'LOCAL design/emulator proof, no application integration',
      'node': subprocess.check_output(['node', '--version']).decode().strip(), 'TZ': 'America/Phoenix',
      'lifecycle_command': 'node --test --test-concurrency=1 time-ack-proof/proof.test.js',
      'lifecycle_counts': counts, 'baseline_command': 'node time-ack-proof/rerun-baseline.mjs',
      'baseline_observations': {'scenarios': 8, 'failed': 0, 'skipped': 0, 'meaning': 'Original STOP reproduced'},
      'lifecycle_verdict': 'Technically viable in tested ordinary-session scope; pending/unknown availability restrictions remain',
      'browser_storage_and_cross_tab': 'not integrated/proven; isolated single-writer fsync/rename envelope fixture',
      'coverage_percentage': 'not measured', 'full_suites': 'not rerun; no production source changes',
      'logs': logs, 'Guardian': 'NOT RUN / NOT PASSED', 'production': 'NO-GO'})
write('PRESERVATION.json', {'baseline': BASE,
      'baseline_tracked_paths': len(git('ls-tree', '-r', '--name-only', BASE).splitlines()),
      'allowed_changes_only': True, 'production_source_SHA256': production, 'frozen_local_refs': refs,
      'time_algorithms_UI_rules_API_gateway_changes': 'none; no old tracked source/evidence changed',
      'post_checkpoint_review_records': ['PRESERVED_EXACT_CHECKPOINT_REVIEW.md', 'PRESERVED_FINAL_VERIFICATION.json'],
      'checkout_EOL': 'Inherited text files may have CRLF/LF checkout conversions; original Git blobs unchanged. Baseline rerun copied from exact blob.',
      'production_access_remote_operations': 'none'})
write('ATTEMPTS.json', {'attempt1': {'pass': 12, 'fail': 13, 'cause': 'Nested RTDB PATCH acknowledgement compared against flat multi-path request; conservative UNKNOWN'},
      'attempt2': {'pass': 25, 'fail': 0}, 'attempt3': {'pass': 33, 'fail': 0}, 'final': counts,
      'approval_interruption': {'executed': False, 'reason': 'Automatic approval review usage limit; later owner continuation followed by approved final baseline rerun'},
      'baseline_first': '8/8 observations but checkout EOL changed harness byte hash',
      'baseline_final': '8/8 observations using exact pinned original bytes'})
paths = [path for folder in [ROOT / 'time-ack-proof', OUT] for path in folder.rglob('*')
         if path.is_file() and path.suffix != '.log' and path.name != 'SOURCE_HASHES.json']
paths.append(ROOT / 'TASK_039_TIME_ACK_PROOF.md')
write('SOURCE_HASHES.json', {'baseline': BASE, 'files': {path.relative_to(ROOT).as_posix(): sha(path) for path in sorted(paths)}})
print(json.dumps({'lifecycle': counts, 'baseline_observations': 8, 'unchanged_production_hashes': len(production), 'frozen_refs': len(refs)}))
