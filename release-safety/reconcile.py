from pathlib import Path
import subprocess, json, hashlib, sys

root=Path(__file__).resolve().parent.parent
git=lambda *args:subprocess.check_output(['git',*args],cwd=root)
base='ce24092f4037cbacd9e2cf79a7465638bb8ef2ec'
main='a9e22afba5370f426c4066c94bf216eac3cced94'
head='122d3835f7114503d9be5ea581227b0d95fb9d9d'
assert git('rev-parse','HEAD').decode().strip()==main
assert git('branch','--show-current').decode().strip()=='task-039-final-local-safety'
conflicts=['CHANGELOG.md','TASKS.md','TEST_REPORT.md']
main_paths=set(git('diff','--name-only',base,main).decode().splitlines())
pr_paths=set(git('diff','--name-only',base,head).decode().splitlines())
assert sorted(main_paths & pr_paths)==conflicts
patch=git('diff','--binary',base,head,'--','.',*[f':(exclude){name}' for name in conflicts])
if '--verify' not in sys.argv:
    subprocess.run(['git','apply','--binary','--whitespace=nowarn','-'],cwd=root,input=patch,check=True)
for name in ['CHANGELOG.md','TEST_REPORT.md']:
    old=git('show',base+':'+name).decode().replace('\r\n','\n')
    current=git('show',main+':'+name).decode().replace('\r\n','\n')
    proposed=git('show',head+':'+name).decode().replace('\r\n','\n')
    assert proposed.startswith(old) and current.startswith(old),name
    expected=current+'\n'+proposed[len(old):]
    if '--verify' not in sys.argv:
        (root/name).write_text(expected,encoding='utf-8',newline='\n')
    else:
        assert (root/name).read_text(encoding='utf-8')==expected,name
# Current-main TASKS remains authoritative. The one owner-direct entry was already recorded/re-read.
task=(root/'TASKS.md').read_text(encoding='utf-8')
main_tasks=git('show',main+':TASKS.md').decode().replace('\r\n','\n')
before,after=task.split('### TASK-039 - Final local release safety closure',1)
entry='### TASK-039 - Final local release safety closure'+after.split('<!-- Paste new tasks above this line. -->',1)[0]
assert task.replace(entry,'')==main_tasks
out=root/'review-artifacts/task-039-final-local-safety';out.mkdir(parents=True,exist_ok=True)
imports={}
tree={}
for row in git('ls-tree','-rz',head).split(b'\0'):
    if row:
        info,name=row.split(b'\t',1);tree[name.decode()]=info.split()[2].decode()
for name in sorted(pr_paths-set(conflicts)):
    actual=(root/name).read_bytes()
    expected=git('cat-file','blob',tree[name])
    assert actual.replace(b'\r\n',b'\n')==expected.replace(b'\r\n',b'\n'),name
    imports[name]={'blob':tree[name],'git_blob_sha256':hashlib.sha256(expected).hexdigest()}
for name in sorted(main_paths-set(conflicts)):
    assert git('hash-object',name).decode().strip()==git('rev-parse',main+':'+name).decode().strip(),name
(out/'RECONCILIATION.json').write_text(json.dumps({'main':main,'pr20':head,'common_base':base,
  'conflicts':conflicts,'resolution':'main histories retained; PR20 log tails appended; own task entry only',
  'imported_paths':imports,'retained_main_paths':sorted(main_paths-set(conflicts)),
  'gateway_imported':False,'git_merge_performed':False},indent=2)+'\n',encoding='utf-8')
print(f'Reconciliation PASS: {len(imports)} exact PR20 imports; current-main OAuth retained; three documentation conflicts resolved.')
