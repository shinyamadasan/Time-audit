"""Package exact local gate/review evidence; no app or protected file writes."""
import gzip
import hashlib
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[2]
out = Path(__file__).resolve().parent
expected = '''
0e80cf058fd558a91af7efc79d74573680b48eb35e0b43b7ff67c59af0a8578d index.html
faa005777ebd027c1ae8da2d97c0b1c1fb517b74453a97a88f7b54af983fc3c0 sw.js
282ca2c82a836467671cc7254bf91cb54cb1287dee0308b9fbfc47cf2f82d09f plan-tomorrow-model.js
7c3c5fd4c3228244b00d056b7afa6c6e49938252ca10b313979d99d63021b875 plan-tomorrow.test.js
22425d517f169e4113e1f2d900fbd9ce7b4f1a476bde5dab91bb4c104f21bdf9 notification-reliability.test.js
b811e7daf6f51ed5f935690541b51238ec2040bc484a4a2fbb37ddff140fe07f online-planner-sdk.test.js
c73328394d3b150e553429724ef5e58bc7416942fd2d652cb801ff9dae40d08a tests/plan-tomorrow-ui.spec.js
5f66b9efe2b1db77c87ae78ce3b93ece5252054641670ceae21a52b3b0bb150c tests/online-planner-sdk-ui.spec.js
0980d4fa29b34f802a8aa8c2741b9746679eb1d2a6ced8f318b45017d681b2bd calendar-plan-model.test.js
9f4432cb529821d0133bdb6d96f23300c96de7ff94d7945278943c3034b652c6 package.json
0521e58c843264a7ac0c5739a5f73968e2142c03770dbcbe04c8f788e87ad0d6 npm-test-wiring.test.js
5472e292f156a945f36eae21f5cab199f044ab5af645e0cd9edc178e6f5687d0 personal-day-boundary-web-runtime.test.js
1e1ea9b5ac0a6c2b51c6f79838334401eadde747ce2a978fdc2d1a0757f32175 tests/calendar-native-plan-identity.spec.js
12b3dd89783ab5d24d2f30456c0f827c15bb7b55a7d1f1a7946878867dd66f15 tests/daily-use-reliability.spec.js
d81a0d312f16b45c319144651751c627a2b6e1b592293fcfa80b6a887d81ce17 device-acceptance/server.mjs
17298a33a0846f7796fbfb06952194f27ba34ded4eead7ca305f45c95a82b759 device-acceptance/Start-OnlineRetest.ps1
4910a257ed53ce418fb0c9d67fe03022c95cdeb4b9ad329baa779e64da95aad2 device-acceptance/Stop-OnlineRetest.ps1
9804ae6c8e3471bda9f1836e9ff210c8560af1b97b2d206c349c069d9def227c device-acceptance/bootstrap.js
ec4f2b589740dd9158002421c01027551f655f341cdd1768be7081ad1f059199 device-acceptance/transport.js
0f4ae07d60f12f88670cafa7b48630daf63bff7b376fe519a5c911b9b7a05b2b device-acceptance/portal.html
1d77db8a9f035b6e6bfb8a92a89197cf211bb0e030094fcb637d544566025934 device-acceptance/.gitignore
'''
reviewed = {}
for line in expected.strip().splitlines():
    digest, name = line.split(' ', 1)
    actual = hashlib.sha256((root / name).read_bytes()).hexdigest()
    assert actual == digest, f'Reviewed file drift: {name}'
    reviewed[name] = actual
(out / 'SOURCE_REVIEW_HASHES.json').write_text(json.dumps({'reviewer': '/root/task037_independent_review',
    'verdict': 'PASS', 'exactReviewedFilesMatch': True, 'sha256': reviewed}, indent=2) + '\n', encoding='utf-8')

def content(name):
    return (out / name).read_text(encoding='utf-8-sig', errors='replace')
def totals(name):
    value = content(name)
    return {key: sum(map(int, re.findall(r'[ℹ#] ' + key + r' (\d+)', value)))
            for key in ['tests', 'pass', 'fail', 'skipped', 'cancelled']}
node, fence = totals('npm-test.log'), totals('fence.log')
assert node == {'tests': 2343, 'pass': 2342, 'fail': 0, 'skipped': 1, 'cancelled': 0}, node
assert fence == {'tests': 170, 'pass': 170, 'fail': 0, 'skipped': 0, 'cancelled': 0}, fence
assert '455 tests: 455 passed, 0 failed' in content('npm-test.log')
for name, count in [('full-browser.log', 1017), ('strict-repeat.log', 21), ('online-sdk-ui-repeat.log', 3)]:
    assert re.search(rf'\b{count} passed \(', content(name)), name
gates = {'base': '9aaf021afdc97c6da9baf9bb346ff7dc39a97390',
    'generation': '20261027-task037-online-release-repair-v1', 'localRepair': 'PASS', 'productionRelease': 'NO-GO',
    'redPlanner': {'pass': 44, 'fail': 6}, 'redScheduler': {'pass': 4, 'fail': 5, 'unhandledRejectionObserved': True},
    'focusedPlannerModelAndSDK': {'pass': 50, 'fail': 0}, 'focusedScheduler': {'pass': 17, 'fail': 0},
    'plannerWireEchoUI': {'pass': 3, 'fail': 0}, 'affectedBrowser': {'pass': 76, 'fail': 0},
    'fullBrowser': {'actualPasses': 1017, 'fail': 0, 'skipped': 0, 'expectedFailures': 0, 'retries': 0},
    'additionalActualSDKBrowser': {'pass': 3, 'repeatEach': 3, 'uniqueCases': 1, 'staleSaveAttemptedAndRefused': True},
    'uniqueBrowserCasesAcrossCommands': 1018, 'strictOriginalSeven': {'pass': 21, 'repeatEach': 3, 'bodiesUnchanged': True},
    'node': {**node, 'legacyHarness': {'pass': 455, 'fail': 0},
      'skip': 'Existing opt-in lower-case-drive control; CROSS_REPO_COMPAT_CONTROL_PROOF=1'},
    'firebaseFenceSDKMutation': fence, 'worker': {'pass': 32, 'fail': 0, 'bundleDryRun': 'PASS; no upload'},
    'lint': {'errors': 0, 'existingWarnings': 48}, 'generated': {'runtimeClosure': 98, 'shared': 'PASS', 'rules': 'PASS'},
    'independentReview': 'PASS; exact hashes validated', 'physicalRetest': 'pending', 'hostedCI': 'pending; no push authorized',
    'integration': 'pending; current-main/TASK-032 preservation required; no merge authorized',
    'attempts': ['First full Node stopped at obsolete negative calendar counterfactual; independently reviewed exact positive correction.',
      'Second full Node hit unchanged Windows lock rename EPERM; focused case passed unchanged; subsequent full gate passed.',
      'New actual-SDK UI fixture startup and transaction-cache errors were corrected; no product source/timeout change for them.'],
    'noProductionActions': True}
(out / 'GATE_RESULTS.json').write_text(json.dumps(gates, indent=2) + '\n', encoding='utf-8')
archives = out / 'logs'
archives.mkdir(exist_ok=True)
manifest = {}
for p in sorted([*out.glob('*.log'), *out.glob('*.tap')]):
    raw = p.read_bytes()
    packed = gzip.compress(raw, mtime=0)
    target = archives / (p.name + '.gz')
    target.write_bytes(packed)
    manifest[p.name] = {'archive': target.relative_to(out).as_posix(), 'rawBytes': len(raw),
        'rawSha256': hashlib.sha256(raw).hexdigest(), 'archiveSha256': hashlib.sha256(packed).hexdigest()}
(out / 'ARTIFACT_MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print(f'Validated {len(reviewed)} independently reviewed files; packaged {len(manifest)} gate/attempt logs.')
