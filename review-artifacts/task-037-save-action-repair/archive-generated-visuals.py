"""Archive gate-generated visual outputs, then restore only this new checkout's baseline copies."""
from pathlib import Path
import hashlib
import json
import subprocess

root = Path(__file__).resolve().parents[2]
out = Path(__file__).resolve().parent
base = '6fcee749417a2ad49ea3a047c6988c01c0526603'
changed = subprocess.check_output(['git', 'diff', base, '--name-only'], cwd=root).decode().splitlines()
prefixes = ('review-artifacts/task-033-product-quality/', 'review-artifacts/task-033-visual-refinement/',
            'review-artifacts/daily-command-center-v1/')
manifest = {}
for name in changed:
    if not name.startswith(prefixes):
        continue
    target = (root / name).resolve()
    assert target.is_relative_to(root.resolve())
    data = target.read_bytes()
    archive = out / 'visual-verification' / name
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.write_bytes(data)
    baseline = subprocess.check_output(['git', 'show', f'{base}:{name}'], cwd=root)
    target.write_bytes(baseline)
    manifest[name] = {'archive': archive.relative_to(out).as_posix(),
                      'generatedSha256': hashlib.sha256(data).hexdigest(),
                      'restoredBaselineSha256': hashlib.sha256(baseline).hexdigest()}
measurement = root / 'review-artifacts/daily-command-center-v1/MEASUREMENTS.json'
if measurement.exists():
    data = measurement.read_bytes()
    archive = out / 'visual-verification/MEASUREMENTS.json'
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.write_bytes(data)
(out / 'GENERATED_VISUAL_OUTPUTS.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf8')
print(f'Archived {len(manifest)} generated tracked copies; restored only this checkout, no protected tree edits.')
