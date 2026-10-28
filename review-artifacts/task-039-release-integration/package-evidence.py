"""Bind reviewed source and completed local gates; archive own logs, never production data."""
from pathlib import Path
import gzip
import hashlib
import json
import re

out = Path(__file__).resolve().parent
root = out.parents[1]
reviewed = dict(line.split(' ', 1)[::-1] for line in '''
e660522ddd80120ab30c2b9a7ddb2f35c6071138ac12db5f91b4232fdb6677a9 index.html
e660522ddd80120ab30c2b9a7ddb2f35c6071138ac12db5f91b4232fdb6677a9 www/index.html
5ab8052c89117c8067dce7bc120eac59ccc6b7fe48f78f106961770c09e181b1 firebase.rules.json
6f80cbac1e9781763f490e15567afcb9f70aed47f9a7460eec47aa90cf50ab39 tests/release-integration.spec.js
890edb01fd41bc3f65db90ede88fa431dd1e7e8dbaede92841142eb0a42de0cd fixtures/release-integration/commitments-model-before-task032.txt
1cec6a2db787fd43aef22b386606b0ac84cbf10807ba34e7c5f8f47d99e85c9e functions/src/envelope.js
3e49adc873ae161cf1a4c9a632c3dbe5eb7c865c50a990f98c3bfeefa9446c03 functions/src/plan-mutation-action.js
1fe01780144360cb69b2f2dee64e4e7092f69b4280987fd759a3d6c92ae844c0 functions/src/user-scoped-rtdb.js
dada8372c6f7d0bdb006feabfdfe6d89bce71af137de3e6391640d118d26e9a0 functions/test/plan-legacy-move.test.js
704dd4e981f3244ccfa4a53fd961ccd536430caf0fd9791a46f478c53c3aecdb workers/chronasense-conversational-bridge/src/mcp.js
c8b35a555cac1198d8a0c6f3b3d809b07e466712dbd80260849ac660fac47274 firebase-rules-emulator.test.js
'''.strip().splitlines())
for name, digest in reviewed.items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest, name
(out / 'SOURCE_REVIEW_HASHES.json').write_text(json.dumps({'reviewer': '/root/task037_independent_review',
    'verdict': 'PASS', 'sha256': reviewed, 'canonicalLfSha256': {name: hashlib.sha256(
        (root / name).read_bytes().replace(b'\r\n', b'\n')).hexdigest() for name in reviewed}}, indent=2) + '\n', encoding='utf8')

def content(name):
    return (out / name).read_text(encoding='utf-8-sig', errors='replace')

def totals(name):
    return {key: sum(map(int, re.findall(r'[ℹ#] ' + key + r' (\d+)', content(name))))
            for key in ['tests', 'pass', 'fail', 'skipped', 'cancelled']}

node, fence, worker = totals('full-node-final.log'), totals('firebase-fence-final.log'), totals('worker-final.log')
assert node == {'tests': 2393, 'pass': 2392, 'fail': 0, 'skipped': 1, 'cancelled': 0}, node
assert fence == {'tests': 177, 'pass': 177, 'fail': 0, 'skipped': 0, 'cancelled': 0}, fence
assert worker == {'tests': 44, 'pass': 44, 'fail': 0, 'skipped': 0, 'cancelled': 0}, worker
assert '455 tests: 455 passed, 0 failed' in content('full-node-final.log')
assert totals('independent-backend-final.log')['pass'] == 86
for file, count in [('full-browser-final.log', 1027), ('strict-seven.log', 21),
                    ('focused-browser.log', 30), ('warm-upgrade-green-final.log', 3), ('independent-warm.log', 1)]:
    data = content(file)
    assert re.search(rf'\b{count} passed \(', data), file
    assert not re.search(r'^\s*\d+ (?:failed|skipped|flaky|did not run)', data, re.M), file
assert '1 failed' in content('warm-upgrade-red-ready.log')
assert '--dry-run: exiting now.' in content('worker-dry-run-final.log')
assert '0 errors, 48 warnings' in content('lint.log')
preserved = json.loads((out / 'PRESERVATION.json').read_text(encoding='utf8'))
assert preserved['pass']
gates = {'base': preserved['base'], 'approvedCandidate': preserved['approvedCandidate'],
    'generation': '20261027-task039-release-integration-v1', 'localIntegration': 'PASS',
    'production': 'NO-GO; hosted CI/formal review and separate production authorization pending',
    'fullBrowser': {'actualPasses': 1027, 'failures': 0, 'skips': 0, 'expectedFailures': 0, 'minutes': 17.1},
    'browserBaseRefreshProof': 'BROWSER_GATE_SURFACE_PROOF.json; 98 runtime files + 94 static dependencies from 59 tests unchanged',
    'focusedBrowser': {'actualPasses': 30, 'repetitions': 3, 'uniqueCases': 10},
    'warmCache': {'strictRedFailures': 1, 'actualGreenPasses': 3, 'fixturePortable': True},
    'strictOriginalSeven': {'actualPasses': 21, 'repetitions': 3, 'fileUnchangedFromApproved': True},
    'node': {**node, 'legacyHarnessPasses': 455, 'skip': 'Existing opt-in lower-case-drive diagnostic'},
    'firebaseFenceSDKMutation': fence, 'worker': worker, 'workerBundle': 'PASS; dry-run only',
    'lint': {'errors': 0, 'existingWarnings': 48}, 'generatedParity': {'runtimeFiles': 98, 'shared': 'PASS', 'rules': 'PASS'},
    'independentReview': {'verdict': 'PASS', 'backendActualPasses': 86, 'warmBrowserActualPasses': 1,
                          'approvedImports': 340, 'retainedMainPaths': 35},
    'preservation': preserved, 'phoneRetesting': 'none requested or performed',
    'hostedCI': 'not run; no push/PR authorization', 'formalRepositoryReview': 'pending exact head/base',
    'nextApproval': 'push exact isolated branch and open draft PR for hosted CI/formal review only; no merge/deploy',
    'attemptNotes': ['Initial warm fixture lacked precision; corrected before actual red.',
        'Initial browser run interrupted to remove historical Git-object dependency from fixture; no product/assertion change.',
        'Remote main advanced0d9ab8f toce24092; browser surface unchanged independently verified; full backend/fence/Worker gates rerun.',
        'Imported historical evidence newline-only copies restored; generated outputs archived before approved-copy restoration.',
        'Windows long-path evidence lookup used blob IDs instead of path-form git show; verification assertions unchanged.'],
    'noProductionActions': True}
(out / 'GATE_RESULTS.json').write_text(json.dumps(gates, indent=2) + '\n', encoding='utf8')
logs = out / 'logs'
logs.mkdir(exist_ok=True)
manifest = {}
for file in sorted(out.glob('*.log')):
    raw = file.read_bytes()
    packed = gzip.compress(raw, mtime=0)
    target = logs / (file.name + '.gz')
    target.write_bytes(packed)
    manifest[file.name] = {'archive': target.relative_to(out).as_posix(), 'rawBytes': len(raw),
        'sha256': hashlib.sha256(raw).hexdigest(), 'archiveSha256': hashlib.sha256(packed).hexdigest()}
(out / 'ARTIFACT_MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf8')
print(f'Final gates validated; {len(reviewed)} independent source hashes; {len(manifest)} log archives.')
