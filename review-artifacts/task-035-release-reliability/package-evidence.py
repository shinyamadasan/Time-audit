"""Preserve raw gate output in deterministic gzip archives; do not modify originals."""
import gzip
import hashlib
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent
archive = OUT / 'logs'
archive.mkdir(exist_ok=True)
manifest = {}
for path in sorted(OUT.iterdir()):
    if path.suffix not in ('.log', '.json') or path.name in (
        'ARTIFACT_MANIFEST.json', 'PROTECTED_BEFORE.json', 'SOURCE_VERIFICATION.json',
        'PROTECTED_VERIFICATION.json', 'GATE_RESULTS.json', 'HARD_RULES.json', 'FINAL_SCOPE.json'):
        continue
    raw = path.read_bytes()
    packed = gzip.compress(raw, mtime=0)
    target = archive / (path.name + '.gz')
    target.write_bytes(packed)
    manifest[path.name] = {'rawSha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
                           'archive': target.relative_to(OUT).as_posix(),
                           'archiveSha256': hashlib.sha256(packed).hexdigest()}
(OUT / 'ARTIFACT_MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n')
print('Archived', len(manifest), 'raw gate outputs; originals retained')
