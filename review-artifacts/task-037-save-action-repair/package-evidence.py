"""Validate completed local gates and exact reviewed sources; archive own evidence only."""
from pathlib import Path
import gzip
import hashlib
import json
import re

out = Path(__file__).resolve().parent
root = out.parents[1]
reviewed = dict(line.split(' ', 1)[::-1] for line in '''
42fa9ea18e9fb94cb3afafcec20a0a476b73335ef68452ec36a04d79de021c23 index.html
42fa9ea18e9fb94cb3afafcec20a0a476b73335ef68452ec36a04d79de021c23 www/index.html
584d974c3bb1a001b099ba1e2af46c4256251475bae4a95bb8e0ce0d68d43ee5 tests/online-planner-sdk-ui.spec.js
972b021889a145b03c52bba66f43b59fec6b117f8d951b6dc0538d38341d7887 personal-day-boundary-web-runtime.test.js
dfd835a98c7472fb83927cecc00819479818c005138653bdf07837abbd619f03 tests/calendar-native-plan-identity.spec.js
12b3dd89783ab5d24d2f30456c0f827c15bb7b55a7d1f1a7946878867dd66f15 tests/daily-use-reliability.spec.js
'''.strip().splitlines())
for file, digest in reviewed.items():
    assert hashlib.sha256((root / file).read_bytes()).hexdigest() == digest, file
(out / 'SOURCE_REVIEW_HASHES.json').write_text(json.dumps({'reviewer': '/root/task037_independent_review',
    'verdict': 'PASS', 'sha256': reviewed,
    'canonicalLfSha256': {file: hashlib.sha256((root / file).read_bytes().replace(b'\r\n', b'\n')).hexdigest()
                         for file in reviewed}}, indent=2) + '\n', encoding='utf8')

def content(name):
    return (out / name).read_text(encoding='utf-8-sig', errors='replace')

def totals(name):
    data = content(name)
    return {key: sum(map(int, re.findall(r'[ℹ#] ' + key + r' (\d+)', data)))
            for key in ['tests', 'pass', 'fail', 'skipped', 'cancelled']}

node = totals('full-node.log')
fence = totals('firebase-fence.log')
worker = totals('worker.log')
assert node == {'tests': 2343, 'pass': 2342, 'fail': 0, 'skipped': 1, 'cancelled': 0}, node
assert fence == {'tests': 170, 'pass': 170, 'fail': 0, 'skipped': 0, 'cancelled': 0}, fence
assert worker == {'tests': 32, 'pass': 32, 'fail': 0, 'skipped': 0, 'cancelled': 0}, worker
assert '455 tests: 455 passed, 0 failed' in content('full-node.log')
for file, count in [('full-browser.log', 1024), ('strict-seven.log', 21), ('green-ui-final.log', 21)]:
    data = content(file)
    assert re.search(rf'\b{count} passed \(', data), file
    assert not re.search(r'^\s*\d+ (?:failed|skipped|flaky|did not run)', data, re.M), file
assert '0 errors, 48 warnings' in content('lint.log')
assert '--dry-run: exiting now.' in content('worker-dry-run.log')
preservation = json.loads((out / 'PRESERVATION.json').read_text(encoding='utf8'))
assert preservation['pass']
browser = content('full-browser.log')
specs = {}
for spec in re.findall(r'\[\d+/1024\].*?tests[\\/]([^:\r\n]+):', browser):
    specs[spec] = specs.get(spec, 0) + 1
gates = {'base': '6fcee749417a2ad49ea3a047c6988c01c0526603',
    'generation': '20261027-task037-save-action-repair-v2', 'localRepair': 'PASS',
    'runtimeLogicDelta': 'two caller busy assignments removed; central saver/guards unchanged',
    'redUI': {'actualPasses': 2, 'actualFailures': 4, 'expectedFailures': 0},
    'newAndExistingSDKUI': {'actualPasses': 21, 'uniqueCases': 7, 'repetitions': 3, 'failures': 0},
    'independentSDKUI': {'actualPasses': 7, 'failures': 0, 'skips': 0, 'sourceHashesMatch': True},
    'fullBrowser': {'actualPasses': 1024, 'failures': 0, 'skips': 0, 'expectedFailures': 0},
    'browserCasesBySpec': specs, 'strictOriginalSeven': {'actualPasses': 21, 'repetitions': 3, 'fileUnchanged': True},
    'node': {**node, 'legacyHarnessPasses': 455, 'skip': 'Existing opt-in lower-case-drive diagnostic'},
    'firebaseFenceSDKMutation': fence, 'worker': worker, 'workerBundle': 'PASS; dry-run only, no upload',
    'lint': {'errors': 0, 'existingWarnings': 48}, 'preservation': preservation,
    'priorPhysicalEvidence': 'Planner owner PASS and Android reminder delivery PASS at 6fcee74; unchanged relevant paths',
    'freshPhysicalSaveStop': 'Not claimed; repaired callbacks verified automatically, no new owner walkthrough',
    'ownerPriorities': ['planning', 'Eisenhower', 'Brain Dump', 'reminders'],
    'production': 'NO-GO; integration, hosted CI, formal exact-head/base review and explicit deployment authorization remain',
    'noProductionActions': True,
    'attemptNotes': ['Initial new-checkout UI attempt lacked the local SDK dependency directory; setup failure, not defect evidence.',
        'Initial green had fixture-only canonical label, awaited-start and canonical entry-key corrections; all exact span/count/guard assertions retained.',
        'First repeated green was interrupted after fixture issues; not counted as a final gate.']}
(out / 'GATE_RESULTS.json').write_text(json.dumps(gates, indent=2) + '\n', encoding='utf8')
archives = out / 'logs'
archives.mkdir(exist_ok=True)
manifest = {}
for file in sorted(out.glob('*.log')):
    raw = file.read_bytes()
    packed = gzip.compress(raw, mtime=0)
    target = archives / (file.name + '.gz')
    target.write_bytes(packed)
    manifest[file.name] = {'archive': target.relative_to(out).as_posix(), 'rawBytes': len(raw),
        'sha256': hashlib.sha256(raw).hexdigest(), 'archiveSha256': hashlib.sha256(packed).hexdigest()}
(out / 'ARTIFACT_MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf8')
print(f'All gates validated; {len(reviewed)} reviewed hashes; {len(manifest)} log archives.')
