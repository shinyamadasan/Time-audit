"""Archive this checkout's generated visual copies, then restore their approved staged baselines."""
from pathlib import Path
import hashlib
import json
import subprocess

root = Path(__file__).resolve().parents[2]
out = Path(__file__).resolve().parent
imports = json.loads((out / 'IMPORT_PROVENANCE.json').read_text(encoding='utf8'))['importedPaths']
changed = subprocess.check_output(['git', 'diff', '--name-only'], cwd=root).decode().splitlines()
record = {}
for name in changed:
    if not name.startswith('review-artifacts/') or name.startswith('review-artifacts/task-039-release-integration/'):
        continue
    assert name in imports, name
    target = (root / name).resolve()
    assert target.is_relative_to(root.resolve())
    staged = subprocess.check_output(['git', 'rev-parse', ':' + name], cwd=root).decode().strip()
    assert staged == imports[name]['approvedBlob'], f'Not an approved staged artifact: {name}'
    baseline = subprocess.check_output(['git', 'show', ':' + name], cwd=root)
    data = target.read_bytes()
    same = data == baseline if name.endswith(('.png', '.gz')) else data.replace(b'\r\n', b'\n') == baseline.replace(b'\r\n', b'\n')
    if not same:
        archive = out / 'visual-verification' / name
        archive.parent.mkdir(parents=True, exist_ok=True)
        archive.write_bytes(data)
        record[name] = {'archive': archive.relative_to(out).as_posix(), 'sha256': hashlib.sha256(data).hexdigest()}
    subprocess.run(['git', 'checkout-index', '--force', '--', name], cwd=root, check=True)
for name in ['review-artifacts/task-033-product-quality/after/MEASUREMENTS.json',
             'review-artifacts/daily-command-center-v1/MEASUREMENTS.json']:
    target = root / name
    if target.is_file():
        data = target.read_bytes()
        archive = out / 'visual-verification' / name
        archive.parent.mkdir(parents=True, exist_ok=True)
        archive.write_bytes(data)
        record[name] = {'archive': archive.relative_to(out).as_posix(), 'sha256': hashlib.sha256(data).hexdigest(), 'untrackedMeasurement': True}
(out / 'GENERATED_VISUAL_OUTPUTS.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf8')
print(f'Archived {len(record)} generated outputs; restored only this checkout historical artifact copies.')
