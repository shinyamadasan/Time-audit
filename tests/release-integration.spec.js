import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildCommitment} from '../commitments-model.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const oldModel=readFileSync(path.join(root,'fixtures/release-integration/commitments-model-before-task032.txt'),'utf8');
const html=readFileSync(path.join(root,'index.html'),'utf8');
const map=html.match(/<script type="importmap">\s*([\s\S]*?)<\/script>/)?.[1];
if(!map)throw Error('Actual application import map missing');
const built=buildCommitment({id:'cupgrade',title:'Date-only upgrade test',precision:'date',date:'2026-10-28',time:null,
  timezone:'Asia/Manila',now:Date.parse('2026-10-27T18:00:00Z'),updatedBy:'upgrade-browser'});
if(!built.ok)throw Error('Invalid test commitment');
const wire={...built.record};delete wire.time;
let server,url,serveOldBare=true;
const modelRequests=[];

test.beforeAll(async()=>{
  server=http.createServer((request,response)=>{
    const parsed=new URL(request.url,'http://localhost');
    if(parsed.pathname==='/legacy'||parsed.pathname==='/current'){
      const legacy=parsed.pathname==='/legacy';
      response.writeHead(200,{'content-type':'text/html','cache-control':'no-store',
        'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'none'"});
      response.end(`<!doctype html>${legacy?'':`<script type="importmap">${map}</script>`}
        <script type="module">import './${legacy?'commitments-model':'commitments-repository'}.js';
        window.result=globalThis.CommitmentsModel.normalizeCommitment(${JSON.stringify(wire)});
        window.finished=true;</script>`);
      return;
    }
    const name=parsed.pathname.slice(1);
    if(!['commitments-model.js','commitments-repository.js','personal-day-boundary-model.js',
      'personal-day-boundary-repository.js'].includes(name)){response.writeHead(404).end();return;}
    if(name==='commitments-model.js')modelRequests.push(parsed.search);
    const body=name==='commitments-model.js'&&!parsed.search&&serveOldBare?oldModel:readFileSync(path.join(root,name),'utf8');
    response.writeHead(200,{'content-type':'text/javascript','cache-control':'public, max-age=86400'});
    response.end(body);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  url=`http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async()=>{await new Promise(resolve=>server.close(resolve));});

test('warm old-client cache upgrades the transitive commitment model and retains a Firebase-pruned date-only record',async({page})=>{
  await page.goto(url+'/legacy');
  await page.waitForFunction(()=>window.finished===true);
  expect(await page.evaluate(()=>window.result)).toBeNull();
  expect(modelRequests).toEqual(['']);
  // The origin now serves the fixed model even for a bare request; only the browser cache stays old.
  serveOldBare=false;
  await page.goto(url+'/current');
  await page.waitForFunction(()=>window.finished===true);
  expect(await page.evaluate(()=>window.result)).toEqual(built.record);
  const token=JSON.parse(map).imports['./commitments-model.js'];
  expect(token).toMatch(/^\.\/commitments-model\.js\?v=/);
  expect(modelRequests).toEqual(['',new URL(token,url).search]);
});
