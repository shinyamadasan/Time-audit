"""Read-only protected-worktree check; writes only TASK-035 local evidence."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

OUT = Path(__file__).resolve().parent
WORKTREES = OUT.parents[2]
NAMES = ['task-028', 'task-030-planning-prototype', 'task-031', 'task-031-safe-planner',
         'task-033-product-quality', 'task-033-visual-refinement', 'task-034-release-preparation']

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args]).decode().strip()

result = {}
for name in NAMES:
    root = WORKTREES / name
    files = set(git(root, 'ls-files', '-z').split('\0')) - {''}
    files.update(p.relative_to(root).as_posix() for p in (root / 'review-artifacts').rglob('*') if p.is_file())
    if name == 'task-034-release-preparation':
        files.add('TASK_034_RELEASE_READINESS.md')
    result[name] = {'head': git(root, 'rev-parse', 'HEAD'), 'status': git(root, 'status', '--porcelain'),
                    'files': {p: hashlib.sha256((root / p).read_bytes()).hexdigest() for p in sorted(files)}}
before = OUT / 'PROTECTED_BEFORE.json'
if sys.argv[1] == 'before':
    before.write_text(json.dumps(result, indent=2) + '\n')
else:
    unchanged = json.loads(before.read_text()) == result
    (OUT / 'PROTECTED_VERIFICATION.json').write_text(json.dumps({'unchanged': unchanged,
        'worktrees': len(result), 'files': sum(len(t['files']) for t in result.values())}, indent=2) + '\n')
    if not unchanged:
        raise SystemExit('Protected worktree drift')
print('Protected worktrees:', len(result), 'files:', sum(len(t['files']) for t in result.values()))
