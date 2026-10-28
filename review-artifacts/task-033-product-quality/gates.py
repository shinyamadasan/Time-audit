"""Summarize completed gates; refuse to label an incomplete browser run as passing."""
from pathlib import Path
import json
import re

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

def read(name):
    return (ROOT / name).read_text(encoding='utf-8')

def node_counts(name):
    value = read(name)
    return {key: sum(map(int, re.findall(r'ℹ ' + key + r' (\d+)', value))) for key in ('tests','pass','fail','skipped')}

def browser_counts(name):
    value = read(name)
    summaries = re.findall(r'^  (\d+) passed \(([^)]+)\)', value, re.M)
    if not summaries:
        raise RuntimeError(f'{name}: final browser summary not present')
    accepted, duration = summaries[-1]
    failures = re.findall(r'^  (\d+) failed\s*$', value, re.M)
    known = len(re.findall(r'^\s+x\s+\d+.*(?:KNOWN FAILURE|EXPECTED FAILURE)', value, re.M))
    return {'acceptedOutcomes': int(accepted), 'unexpectedFailures': int(failures[-1]) if failures else 0,
            'existingExpectedFailuresIncluded': known, 'duration': duration}

browser = browser_counts('task033-browser-verified.log')
assert browser['acceptedOutcomes'] == 997 and browser['unexpectedFailures'] == 0, browser
node = node_counts('task033-node-final.log')
assert node == {'tests': 2322, 'pass': 2321, 'fail': 0, 'skipped': 1}, node
fence = node_counts('task033-final-fence.log')
assert fence['tests'] == fence['pass'] == 161 and fence['fail'] == fence['skipped'] == 0, fence
worker = node_counts('task033-worker.log')
assert worker['pass'] == worker['tests'] == 32 and worker['fail'] == 0, worker
result = {
    'stage1': 'Automated gates accepted; independent source/visual review has no material must-fix; owner review pending',
    'stage2': 'FAIL — unconnected experiment permits initial creation replay to overwrite a later owner edit; no direct selection in runtime',
    'browser': browser, 'node': {**node,'legacy': '455/455','existingSkip': 'CROSS_REPO_COMPAT_CONTROL_PROOF=1 lower-case-drive diagnostic not enabled'},
    'fence': fence, 'worker': worker, 'bundle': 'Wrangler 4.149.0 --dry-run; no upload/deploy',
    'focused': '32 planning/dashboard cases + 2 corrected copy regressions; final 2 visual/accessibility cases pass; all are also in the final full browser gate',
    'lint': '0 errors, 48 existing warnings', 'runtimeMirror': '98 byte-identical runtime files, including local font',
    'generated': 'shared models and rules match; no production contract/rules delta', 'preservation': '25 domain/rules files + known presentation-only index delta; all protected worktrees/evidence match',
    'scenarios': {'desktopLaptopTabletPhone': 'PASS', 'contrastAndKeyboard': 'PASS; muted text 7.05:1, tab order/focus trap/return, inset timeline focus',
        'unsavedDraftsAndNavigation': 'PASS', 'repeatedSaveAndIdentity': 'PASS', 'existingSourceConflictRefusal': 'PASS',
        'offlineAndSaveConfirmation': 'PASS; local/pending/confirmed distinct', 'personalDayAndOvernight': 'PASS',
        'mobileKeyboardHeight': 'PASS controlled 480px viewport simulation', 'zoom': 'PASS 683x384 equivalent CSS viewport; native zoom not certified',
        'directEditedSelection': 'NOT IMPLEMENTED; failed gate preserved'},
    'prototype': {'positiveFenceChecks': 170, 'gate': 'FAIL despite positive checks', 'actualWriterAndEmulator': 'REPLAY_WRITER_EMULATOR_RESULT.json'},
    'coverage': 'Not measured', 'untested': ['Physical iOS/Android keyboard and feel','Native browser 200% zoom','Real accounts/cloud durability','Direct-selection UI because safety gate stopped it'],
    'release': 'HOLD — no push, merge, rules deployment or production release; inherited TASK-031 rules-first hold remains'
}
(HERE / 'GATE_RESULTS.json').write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
print(json.dumps({'browser':browser,'node':node,'fence':fence,'worker':worker},ensure_ascii=False))
