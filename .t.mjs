import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { chromium } from 'playwright';
const root = path.resolve('site'); const d3 = fs.readFileSync('node_modules/d3/dist/d3.min.js','utf8'); const out=process.argv[2];
const srv = http.createServer((q,r)=>{const p=path.join(root,q.url.split('?')[0]); if(!fs.existsSync(p)){r.writeHead(404);return r.end();} r.writeHead(200,{'Content-Type':p.endsWith('.html')?'text/html':'application/json'}); fs.createReadStream(p).pipe(r);});
await new Promise(r=>srv.listen(0,r)); const base='http://127.0.0.1:'+srv.address().port; const b = await chromium.launch();
const shipsFile = process.argv[3] || 'tests/fixtures/ships.json';
for (const [w,name,scheme] of [[1280,'desk','light'],[390,'phone','dark']]) {
  const p = await b.newPage({viewport:{width:w,height:900}, colorScheme: scheme});
  await p.route(/^https?:\/\/(?!127\.0\.0\.1)/, (rt)=>{const u=rt.request().url(); if(u.includes('d3.min.js')) return rt.fulfill({body:d3,contentType:'application/javascript'}); if(u.includes('ships.json')) return rt.fulfill({contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:fs.readFileSync(shipsFile,'utf8').replaceAll('__NOW__',new Date(Date.now()-20*60e3).toISOString())}); return rt.abort();});
  await p.goto(base+'/gas_dashboard.html'); await p.waitForTimeout(1200); await p.click('#tab-lng'); await p.waitForTimeout(400);
  await p.evaluate(()=>document.querySelector('.sc-top')?.remove());
  await (await p.$('#lng-fleet')).screenshot({path:`${out}/fleet-${name}.png`}); await p.close();
}
await b.close(); srv.close();
