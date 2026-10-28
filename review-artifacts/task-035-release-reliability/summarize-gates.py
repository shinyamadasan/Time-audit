"""Summarize retained actual outcomes, explicitly separating expected failures/skips."""
import json
from pathlib import Path
import re

OUT = Path(__file__).resolve().parent

def browser(name):
    data = json.loads((OUT / f'{name}.json').read_text(encoding='utf-8-sig'))
    outcomes = []
    def visit(suite):
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                for result in test['results']:
                    outcomes.append((spec['title'], test['expectedStatus'], result['status'], result['retry']))
        for child in suite.get('suites', []):
            visit(child)
    for suite in data['suites']:
        visit(suite)
    return {'actualPasses': sum(actual == 'passed' for _, _, actual, _ in outcomes),
            'actualFailures': sum(actual == 'failed' or actual == 'timedOut' for _, _, actual, _ in outcomes),
            'expectedFailures': sum(expected == 'failed' for _, expected, _, _ in outcomes),
            'skipped': sum(actual == 'skipped' for _, _, actual, _ in outcomes),
            'retries': sum(retry > 0 for _, _, _, retry in outcomes),
            'reportedStats': data['stats']}

def node(name):
    text = (OUT / f'{name}.log').read_text(encoding='utf-8-sig')
    totals = {key: sum(map(int, re.findall(r'(?:ℹ|#) ' + key + r' (\d+)', text)))
              for key in ['tests', 'pass', 'fail', 'skipped', 'cancelled']}
    legacy = re.findall(r'(\d+) tests: (\d+) passed, (\d+) failed', text)
    if legacy:
        totals['legacyHarness'] = dict(zip(['tests', 'pass', 'fail'], map(int, legacy[-1])))
    return totals

result = {'base': 'ab0c601745c0471a84feb44deeb6b38214b25383',
          'generation': '20261027-task035-release-reliability-v1',
          'beforeStrict': browser('before-strict'),
          'strictRepeated': browser('strict-repeat'),
          'affectedBrowser': browser('focused-final'),
          'firstFullBrowser': browser('browser-full'),
          'correctedFixturesAndVisualExpectations': browser('full-gate-corrections'),
          'fullBrowser': browser('browser-full-final'),
          'node': node('node-final'), 'firebaseFenceIncludingSDK': node('fence-final'),
          'worker': node('worker-final'),
          'lint': {'errors': 0, 'existingWarnings': 48},
          'generated': '98 byte-identical runtime mirrors; shared/rules parity pass',
          'workerBundle': 'Wrangler 4.149.0 --dry-run, exit 0, no upload/deploy',
          'coverage': 'not measured',
          'environment': 'Windows, Node 24.19.0, Chromium; hosted Node-22 CI unverified'}
for key in ['strictRepeated', 'affectedBrowser', 'fullBrowser']:
    assert result[key]['actualFailures'] == 0 and result[key]['expectedFailures'] == 0
    assert result[key]['skipped'] == 0 and result[key]['retries'] == 0
for key in ['node', 'firebaseFenceIncludingSDK', 'worker']:
    assert result[key]['fail'] == 0 and result[key]['cancelled'] == 0
(OUT / 'GATE_RESULTS.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
