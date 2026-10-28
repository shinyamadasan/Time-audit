"""Read-only source/preservation checks and local test-summary evidence."""
import json
import re
import subprocess
from pathlib import Path

OUT = Path(__file__).resolve().parent
ROOT = OUT.parent.parent
BASE = 'ff3d4268fc1faf76cc45ec142cd8ee8dc3c5b1f2'

def git(*args, cwd=ROOT):
    return subprocess.check_output(['git', *args], cwd=cwd).decode('utf-8').strip()

def before(file):
    return subprocess.check_output(['git', 'show', f'{BASE}:{file}'], cwd=ROOT).decode('utf-8').replace('\r\n', '\n')

def now(file):
    return (ROOT / file).read_text(encoding='utf-8')

files = [f for f in git('ls-files').splitlines() if '/' not in f and f.endswith('.js') and not f.endswith('.test.js') and f != 'plan-tomorrow-ui.js']
files += ['firebase.rules.json', 'scripts/firebase-rules-builder.mjs']
unchanged = {f: before(f) == now(f) for f in files}
assert all(unchanged.values()), 'Unexpected domain mutation'

def index_lens(s):
    s = s.replace('20261027-task033-visual-refinement-v1', '20261026-task033-product-quality-v1')
    for start, end in [
        ('<section id="up-next"', '  <!-- Personal Day Boundary Live Wiring'),
        ('<!-- ══ NAV ══ -->', '<!-- ══ RECURRING BLOCK MODAL ══ -->'),
        ('<div class="review-overlay" id="plan-tomorrow-overlay">', '<!-- Install banner -->'),
        ('function renderTodayActionStrip()', 'function renderReviewCloseoutSummary()'),
    ]:
        i = s.index(start)
        j = s.index(end, i)
        s = s[:i] + 'PRESENTATION_REGION\n' + s[j:]
    return s

assert index_lens(now('index.html')) == index_lens(before('index.html')), 'Unexpected index change outside reviewed anchors'
protected = {}
for name, commit in [('task-028', '17608cd'), ('task-030-planning-prototype', '07411dd'), ('task-031-safe-planner', 'd7e01d0'), ('task-033-product-quality', 'ff3d426')]:
    tree = ROOT.parent / name
    state = {'commit': git('rev-parse', 'HEAD', cwd=tree), 'status': git('status', '--porcelain', cwd=tree)}
    assert state['commit'].startswith(commit) and not state['status'], name
    protected[name] = state
print(subprocess.check_output(['node', str(ROOT.parent / 'task-031-safe-planner/review-artifacts/task-031-safe-planner/preservation.mjs')], cwd=ROOT).decode('utf-8').strip())
(OUT / 'INVARIANTS.json').write_text(json.dumps({
    'baseline': BASE, 'unchangedProductionFiles': unchanged,
    'indexChangesConfinedTo': 'Up Next presentation/state disclosure, existing navigation/More, planner markup, coherent cache generation',
    'protectedWorktrees': protected, 'original028030031AndReviewArtifacts': 'match preserved TASK-031 snapshot',
}, indent=2) + '\n', encoding='utf-8')
log = now('task033-visual-node-final.log')
summary = {k: sum(map(int, re.findall(r'ℹ ' + k + r' (\d+)', log))) for k in ['tests', 'pass', 'fail', 'skipped', 'cancelled']}
summary['legacyHarness'] = re.findall(r'(\d+) tests: (\d+) passed, (\d+) failed', log)
assert summary['fail'] == 0 and summary['cancelled'] == 0 and summary['tests'] > 2000
assert summary['legacyHarness'] == [('455', '455', '0')]
(OUT / 'NODE_RESULTS.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
print(f'PASS: {len(unchanged)} production files unchanged; protected baselines intact; Node {summary}')
