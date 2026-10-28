"""TASK-035 final source/design/contract evidence, without production access."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[1]
APPROVED = ROOT.parent / 'task-033-visual-refinement'

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def read(root, name):
    return (root / name).read_text(encoding='utf-8')

files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=APPROVED).decode().split('\0')
visual = [p for p in files if p.endswith('.css') or p.startswith('assets/fonts/')]
visual += ['daily-command-center.js', 'plan-tomorrow-ui.js']
visual_drift = [p for p in visual if sha(ROOT / p) != sha(APPROVED / p)]
domain = ['firebase.rules.json', 'scripts/firebase-rules-builder.mjs', 'plan-authority.js', 'focus-mode.js']
domain += [p for p in files if p.startswith('brain-dump-') and p.endswith('.js')]
domain_drift = [p for p in domain if sha(ROOT / p) != sha(APPROVED / p)]
old_token = '20261027-task033-visual-refinement-v1'
new_token = '20261027-task035-release-reliability-v1'
markup = lambda root: read(root, 'index.html').split('// STATE', 1)[0].replace(old_token, 'GENERATION').replace(new_token, 'GENERATION')
before = read(APPROVED, 'tests/daily-use-reliability.spec.js')
after = read(ROOT, 'tests/daily-use-reliability.spec.js')
assertions = {}
for case in range(1, 8):
    def body(source):
        start = source.index(f"test('F-{case} ")
        end = source.index('\n  });', start)
        lines = source[start:end].splitlines()[1:]
        return '\n'.join(line for line in lines if 'knownFailure(' not in line)
    assertions[f'F-{case}'] = body(before) == body(after)
reviewed = {
    'index.html': 'e6cee26364e94e42a5bb0773704e4b7ef3185f13dcaf6939d7edd437b0b8825d',
    'storage.js': '2afe3c819560b7234813df1b2647103a32642d5cd3ca2e3e93ddddbf7a992240',
    'tests/daily-use-reliability.spec.js': '12b3dd89783ab5d24d2f30456c0f827c15bb7b55a7d1f1a7946878867dd66f15',
    'entry-reliability-sdk.test.js': '3d7b7773eabc449f20a51ef8766c55da8abe9d796a32941c33d30c8ad4272fae',
    'entry-validation.test.js': '17daadc6672575ccb2ba034715c32f031527c8a7ce144103232a3ff6f846628e',
    'tests/capability-career-ui.spec.js': '761673f786d54e8126373eb09e5b883446fc6a22f2deb3bcabe0c1d5202c2e57',
    'tests/learning-plan-ui.spec.js': 'f8257192f3439cde2f1688b4a6d6ac84d2b566641933cd7d86ab5a261e603c97',
    'tests/cross-domain-intelligence-ui.spec.js': 'cec12243405def377b0dda45395c8f07fd415c6822afbe9ba4c158c13804a710',
    'tests/install-interruption.spec.js': '9d2b2ad75de04a4d1e3e72adb21a3f8be72b0cdedb03734d6beb6e83f51208ab',
    'tests/smoke.spec.js': 'b172f959988e5b632bc9a5308cc1947b759d3f3f949305b68afe3d14d735b4c3',
    'tests/personal-day-boundary.spec.js': '512b6f8a8983d454efd4518a7d0f807dcc6c6f4c4a8cbf503aef1642e72a6968',
    'tests/calendar-native-plan-identity.spec.js': 'accf7617ebe75667a8571c4786faea6f9bad3cc180fde26316b8cc958cbd9de2',
}
result = {'visualFilesChecked': len(visual), 'visualDrift': visual_drift,
          'markupUnchangedExceptGeneration': markup(ROOT) == markup(APPROVED),
          'protectedDomainFilesChecked': len(domain), 'domainDrift': domain_drift,
          'originalSevenBodiesUnchangedExceptExpectedFailureRemoval': assertions,
          'noExpectedFailureHandling': not re.search(r'test\.fail\(|knownFailure\(', after),
          'sourceHashes': {p: sha(ROOT / p) for p in reviewed},
          'independentReviewHashesMatch': all(sha(ROOT / p) == digest for p, digest in reviewed.items()),
          'rulesSha256': sha(ROOT / 'firebase.rules.json')}
(OUT / 'SOURCE_VERIFICATION.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
assert not visual_drift and not domain_drift
assert result['markupUnchangedExceptGeneration'] and all(assertions.values())
assert result['noExpectedFailureHandling'] and result['independentReviewHashesMatch']
