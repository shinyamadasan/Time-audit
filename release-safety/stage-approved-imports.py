from pathlib import Path
import subprocess,json
root=Path(__file__).resolve().parent.parent
manifest=json.loads((root/'review-artifacts/task-039-final-local-safety/RECONCILIATION.json').read_text())
head=manifest['pr20']
tree={}
data=subprocess.check_output(['git','ls-tree','-rz',head],cwd=root)
for row in data.split(b'\0'):
    if row:
        info,path=row.split(b'\t',1);mode,kind,oid=info.split();tree[path.decode()]=(mode,oid)
# Newly-added historical evidence can contain intentional CRLF Git blobs. Preserve the reviewed
# original index objects rather than letting this host's clean filters normalize their bytes.
entries=[]
for path,record in manifest['imported_paths'].items():
    mode,oid=tree[path];assert oid.decode()==record['blob']
    entries.append(mode+b' '+oid+b'\t'+path.encode()+b'\0')
subprocess.run(['git','update-index','-z','--index-info'],cwd=root,input=b''.join(entries),check=True)
staged={}
for row in subprocess.check_output(['git','ls-files','--stage','-z'],cwd=root).split(b'\0'):
    if row:
        info,path=row.split(b'\t',1);staged[path.decode()]=info.split()[1].decode()
for path,record in manifest['imported_paths'].items():assert staged[path]==record['blob'],path
print('Index PASS: all413 imported paths retain exact approved original Git objects, including historical line endings.')
