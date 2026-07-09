// Systematic row-alignment auditor (design governance tool).
//
// For every visual-smoke fixture, finds horizontal clusters of interactive
// controls and reports:
//   - height mismatch  (same control type sharing a row)
//   - centerline drift (mixed control types sharing a row)
//   - radius mismatch  (same-row controls on different radius families;
//                       role=switch is pill by design and exempt)
// Usage: node scripts/audit-alignment.mjs   (expects a built renderer)
// Rule of thumb: mixed types align CENTERS; same types also match heights.
import { spawn } from 'node:child_process';
const ROOT='/Users/jakevin/.slock/agents/f3545298-8201-4cd0-95cf-432e8a5987e9/maka-agent';
const ELECTRON=ROOT+'/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
const FIXTURES=['module-skills','module-daily-review','plan-reminders','settings-general','fetched-empty','settings-data','settings-gateway','turn-narrative','settings-permissions'];
let port=Number(process.env.AUDIT_PORT_BASE ?? 14600);
const EXPR=`(()=>{
  const controls=[...document.querySelectorAll('button,[role=button],[role=switch],input,select,[role=combobox],[role=tab]')].filter(e=>{
    const r=e.getBoundingClientRect();
    const cs=getComputedStyle(e);
    return r.width>0 && r.height>8 && cs.visibility!=='hidden' && cs.display!=='none';
  });
  const clusters=new Map();
  for(const e of controls){
    const p=e.parentElement; if(!p) continue;
    if(!clusters.has(p)) clusters.set(p,[]);
    clusters.get(p).push(e);
  }
  const issues=[];
  for(const [p,els] of clusters){
    if(els.length<2) continue;
    const rects=els.map(e=>({e,r:e.getBoundingClientRect(),cs:getComputedStyle(e)}));
    // horizontal cluster: vertical ranges overlap pairwise with the first
    const base=rects[0].r;
    const horiz=rects.filter(({r})=>Math.min(r.bottom,base.bottom)-Math.max(r.top,base.top) > Math.min(r.height,base.height)*0.5);
    if(horiz.length<2) continue;
    const type=(e)=>e.getAttribute('role')||e.tagName;
    const sameType=new Set(horiz.map(({e})=>type(e))).size===1;
    const hs=horiz.map(({r})=>+r.height.toFixed(1));
    const cys=horiz.map(({r})=>+(r.top+r.height/2).toFixed(1));
    const rads=horiz.map(({cs})=>cs.borderRadius);
    const label=(e)=>((e.getAttribute('aria-label')||e.textContent||e.className||'').trim().slice(0,16));
    const hSpread=Math.max(...hs)-Math.min(...hs);
    const cySpread=Math.max(...cys)-Math.min(...cys);
    const radSet=[...new Set(horiz.filter(({e})=>e.getAttribute('role')!=='switch').map(({cs})=>cs.borderRadius).filter(x=>!x.includes('%')&&parseFloat(x)<100))];
    if(hSpread>2.5 && sameType) issues.push({kind:'height',parent:p.className.split(' ')[0]||p.tagName,spread:+hSpread.toFixed(1),items:horiz.map(({e,r})=>label(e)+':'+r.height.toFixed(0))});
    if(cySpread>1.5 && (!sameType || hSpread<=2.5)) issues.push({kind:'center',parent:p.className.split(' ')[0]||p.tagName,spread:+cySpread.toFixed(1),items:horiz.map(({e,r})=>label(e)+':'+(r.top+r.height/2).toFixed(0))});
    if(radSet.length>1 && hSpread<=2.5) issues.push({kind:'radius',parent:p.className.split(' ')[0]||p.tagName,items:horiz.map(({e,cs})=>label(e)+':'+cs.borderRadius)});
  }
  return JSON.stringify(issues.slice(0,12));
})()`;
for(const fx of FIXTURES){
  const P=port++;
  const child=spawn(ELECTRON,[ROOT+'/apps/desktop','--remote-debugging-port='+P,'--user-data-dir=/private/tmp/claude-501/audit-'+P+'-'+process.pid],{env:{...process.env,MAKA_VISUAL_SMOKE_FIXTURE:fx,MAKA_VISUAL_SMOKE_THEME:'light'},stdio:'ignore'});
  try{
    await new Promise(r=>setTimeout(r,8500));
    const list=await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
    const page=list.find(t=>t.type==='page');
    const ws=new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r=>ws.onopen=r);
    let id=0; const send=(m,p)=>new Promise(res=>{const i=++id;const h=e=>{const d=JSON.parse(e.data);if(d.id===i){ws.removeEventListener('message',h);res(d.result);}};ws.addEventListener('message',h);ws.send(JSON.stringify({id:i,method:m,params:p}));});
    const r=await send('Runtime.evaluate',{expression:EXPR,returnByValue:true});
    console.log('==',fx,'==');
    const arr=JSON.parse(r.result.value);
    for(const i of arr) console.log(JSON.stringify(i));
    if(!arr.length) console.log('(clean)');
  }catch(e){console.log('==',fx,'== ERROR',e.message);}
  child.kill('SIGKILL');
}
process.exit(0);
