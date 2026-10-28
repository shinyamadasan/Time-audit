// Local-only acceptance transport. Never writes the approved runtime or a remote service.
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {computeClosure} from '../scripts/runtime-mirror.mjs';
import {JAR} from '../rtdb-emulator-support.js';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.dirname(HERE), PRIVATE=path.join(HERE,'private');
const lan='127.0.0.1';
const expected=process.argv[2];
if(!/^[a-f0-9]{40}$/.test(expected||''))throw Error('Supply the exact reviewed candidate commit');
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT}).toString().trim();
if(head!==expected) throw Error('Device instance must start at the exact reviewed candidate');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const approvedFiles=computeClosure({rootDir:ROOT}).files;
for(const file of [...approvedFiles,'sw.js','firebase.rules.json']){
  const approved=execFileSync('git',['show',`${expected}:${file}`],{cwd:ROOT,maxBuffer:16*1024*1024});
  const actual=readFileSync(path.join(ROOT,file));
  // Git checkout CRLF does not change the approved textual runtime contract.
  if(!approved.equals(actual)&&approved.toString().replaceAll('\r\n','\n')!==actual.toString().replaceAll('\r\n','\n'))throw Error(`Unapproved runtime drift: ${file}`);
}
if(sha(readFileSync(JAR))!=='b70d99344caf17c98b6f910fa8f6edf32a7c016cb1035e8915f70d38901eb97f')throw Error('Emulator checksum mismatch');
mkdirSync(PRIVATE,{recursive:true});
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});
const emulatorPort=await freePort();
const emulator=spawn('java',['-jar',JAR,'--host','127.0.0.1','--port',String(emulatorPort)],{stdio:'ignore',windowsHide:true});
const namespace='deviceacceptance'+randomBytes(6).toString('hex');
const base=`http://127.0.0.1:${emulatorPort}`;
let ready=false;
for(let attempt=0;attempt<100&&!ready;attempt++){
  try{ready=(await fetch(`${base}/.json?ns=${namespace}`)).ok;}catch{}
  if(!ready)await new Promise(resolve=>setTimeout(resolve,100));
}
if(!ready){emulator.kill();throw Error('Loopback emulator unavailable');}
const rules=readFileSync(path.join(ROOT,'firebase.rules.json'));
const loaded=await fetch(`${base}/.settings/rules.json?ns=${namespace}`,{method:'PUT',headers:{Authorization:'Bearer owner'},body:rules});
if(!loaded.ok){emulator.kill();throw Error('Candidate rules refused by local emulator');}
const uid='device-acceptance';
const timezone='America/Phoenix';
await fetch(`${base}/rooms/uid_${uid}/settings.json?ns=${namespace}`,{method:'PUT',headers:{Authorization:'Bearer owner'},
  body:JSON.stringify({timezone,intervalMin:1,sleepSetupDone:true,presets:[],templates:[]})});
const certificate={lan};
let access=randomBytes(24).toString('hex');
try{const previous=JSON.parse(readFileSync(path.join(PRIVATE,'session.json')));if(/^[a-f0-9]{48}$/.test(previous.access))access=previous.access;}catch{}
const config={lan,namespace,emulatorPort,uid,timezone,candidate:expected,...certificate};
const stats={startedUtc:new Date().toISOString(),httpRequests:0,websocketConnections:0,cspBlocked:0};
const csp="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; report-uri /acceptance/csp";
const sdk=path.join(ROOT,'node_modules/firebase');
const vendors=new Map(['firebase-app-compat.js','firebase-database-compat.js'].map(file=>[`/vendor/${file}`,readFileSync(path.join(sdk,file))]));
const bootstrap=readFileSync(path.join(HERE,'bootstrap.js'));
const transport=readFileSync(path.join(HERE,'transport.js'));
let html=readFileSync(path.join(ROOT,'index.html'),'utf8');
for(const name of ['app','database'])html=html.replace(`https://www.gstatic.com/firebasejs/10.12.2/firebase-${name}-compat.js`,`/vendor/firebase-${name}-compat.js`);
html=html.replace('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js','/acceptance/bootstrap.js');
const bootstrapTag='<script>window.__deviceTestConfig='+JSON.stringify(config)+'</script><script src="/acceptance/transport.js"></script>';
html=html.replace('<script src="/vendor/firebase-app-compat.js">',bootstrapTag+'\n<script src="/vendor/firebase-app-compat.js">');
const portal=readFileSync(path.join(HERE,'portal.html'),'utf8').replace('CONFIG_PLACEHOLDER',JSON.stringify(config));
const mime={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json',
  '.woff2':'font/woff2','.png':'image/png','.mp3':'audio/mpeg','.svg':'image/svg+xml'};
const allowed=new Set([...approvedFiles,'sw.js']);
const matches=value=>typeof value==='string'&&value.length===access.length&&timingSafeEqual(Buffer.from(value),Buffer.from(access));
const authorized=req=>{
  const url=new URL(req.url,'http://localhost');
  const cookie=/(?:^|;\s*)cs_device_access=([^;]+)/.exec(req.headers.cookie||'')?.[1];
  return matches(url.searchParams.get('access'))||matches(cookie);
};
const hostAllowed=req=>[lan,'localhost','127.0.0.1'].includes(new URL('http://'+req.headers.host).hostname);
function handler(req,res){
  stats.httpRequests++;
  if(!hostAllowed(req)||!authorized(req)){res.writeHead(403);res.end('Local device-test access required');return;}
  const url=new URL(req.url,'http://localhost');
  res.setHeader('Content-Security-Policy',csp);
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Cache-Control','no-cache');
  if(url.searchParams.has('access'))res.setHeader('Set-Cookie',`cs_device_access=${access}; Path=/; HttpOnly; SameSite=Strict${req.socket.encrypted?'; Secure':''}`);
  const send=(body,type='text/html',status=200)=>{res.writeHead(status,{'Content-Type':type});res.end(body);};
  if(req.method==='POST'&&url.pathname==='/acceptance/csp'){
    let size=0;req.on('data',chunk=>{size+=chunk.length;if(size>4096)req.destroy();});
    req.on('end',()=>{stats.cspBlocked++;send('','text/plain',204);});return;
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){send('Method refused','text/plain',405);return;}
  if(url.pathname==='/acceptance/status'){send(JSON.stringify({candidate:expected,namespace,rulesSha256:sha(rules),...stats}),'application/json');return;}
  if(url.pathname==='/acceptance/bootstrap.js'){send(bootstrap,'text/javascript');return;}
  if(url.pathname==='/acceptance/transport.js'){send(transport,'text/javascript');return;}
  if(url.pathname==='/acceptance/'||url.pathname==='/acceptance'){send(portal);return;}
  if(url.pathname==='/'||url.pathname==='/index.html'){
    if(!req.socket.encrypted&&!['localhost','127.0.0.1'].includes(new URL('http://'+req.headers.host).hostname))send(portal);
    else send(html);
    return;
  }
  if(vendors.has(url.pathname)){send(vendors.get(url.pathname),'text/javascript');return;}
  let relative;
  try{relative=decodeURIComponent(url.pathname).slice(1);}catch{send('Invalid path','text/plain',400);return;}
  if(!allowed.has(relative)){send('Not in approved runtime allowlist','text/plain',404);return;}
  send(readFileSync(path.join(ROOT,relative)),mime[path.extname(relative)]||'application/octet-stream');
}
function upgrade(req,socket,head){
  const url=new URL(req.url,'http://localhost');
  if(!hostAllowed(req)||!authorized(req)||url.pathname!=='/rtdb/.ws'||url.searchParams.get('ns')!==namespace){socket.destroy();return;}
  stats.websocketConnections++;
  const proxy=http.request({host:'127.0.0.1',port:emulatorPort,path:'/.ws'+url.search,headers:{...req.headers,host:`127.0.0.1:${emulatorPort}`}});
  proxy.on('upgrade',(response,upstream,upstreamHead)=>{
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'+response.rawHeaders.reduce((s,v,i)=>s+v+(i%2?'\r\n':': '),'')+'\r\n');
    if(head.length)upstream.write(head);if(upstreamHead.length)socket.write(upstreamHead);
    socket.pipe(upstream);upstream.pipe(socket);socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
  });
  proxy.on('error',()=>socket.destroy());proxy.end();
}
const plain=http.createServer(handler);plain.on('upgrade',upgrade);
plain.on('error',error=>{console.error(error.message);emulator.kill();process.exit(1);});
await new Promise(resolve=>plain.listen(8767,'127.0.0.1',resolve));
const servers=[plain];
const session={...config,access,serverPid:process.pid,emulatorPid:emulator.pid,
  connectionMode:'usb-localhost',
  lanSetupUrl:null,lanAppUrl:null,
  usbAppUrl:`http://localhost:8767/?access=${access}`,emulatorBase:base,runtimeHashes:Object.fromEntries(approvedFiles.map(file=>[file,sha(readFileSync(path.join(ROOT,file)))]))};
writeFileSync(path.join(PRIVATE,'session.json'),JSON.stringify(session,null,2));
console.log(JSON.stringify({lanSetupUrl:session.lanSetupUrl,lanAppUrl:session.lanAppUrl,usbAppUrl:session.usbAppUrl,candidate:expected,namespace,emulatorPort}));
async function stop(){
  try{const data=await(await fetch(`${base}/.json?ns=${namespace}`,{headers:{Authorization:'Bearer owner'}})).json();writeFileSync(path.join(PRIVATE,'test-data-snapshot.json'),JSON.stringify(data));}catch{}
  servers.forEach(server=>server.close());emulator.kill();process.exit(0);
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('exit',()=>emulator.kill());
