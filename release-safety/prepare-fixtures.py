from pathlib import Path
import subprocess,json,hashlib,re,posixpath
root=Path(__file__).resolve().parent.parent
out=root/'review-artifacts/task-039-final-local-safety';out.mkdir(parents=True,exist_ok=True)
fixtures=root/'release-safety/fixtures';fixtures.mkdir(exist_ok=True)
files={}
queue=['plan-tomorrow-model.js','stale-plan-recovery-model.js']
while queue:
    name=queue.pop(0)
    if name in files:continue
    data=subprocess.check_output(['git','show','ce24092:'+name],cwd=root)
    (fixtures/name).parent.mkdir(parents=True,exist_ok=True)
    (fixtures/name).write_bytes(data)
    files[name]=hashlib.sha256(data).hexdigest()
    for dependency in re.findall(r'''(?:from\s*|import\s*)['"](\.[^'"]+)['"]''',data.decode()):
        queue.append(posixpath.normpath(posixpath.join(posixpath.dirname(name),dependency)))
(out/'OLD_FIXTURES.json').write_text(json.dumps({'source':'ce24092f4037cbacd9e2cf79a7465638bb8ef2ec',
  'kind':'exact public pre-release source; previously captured client matched these git blobs',
  'sha256':files,'production_access':False},indent=2)+'\n',encoding='utf-8')
print('Pinned old-client model fixtures captured from local Git objects.')
