// Refresh account dashboards independently of page entry, while the app is foreground.
const cache = require('./view-cache');
const { call } = require('./api');
const { refreshUser } = require('./auth');
const listeners = new Set();
let active = false, timer = null, inflight = null, again = false, last = 0;
function publish(type, data) { listeners.forEach(fn => { try { fn(type, data); } catch (_) {} }); }
function read(type) { return cache.read('dashboard_' + type); }
function refresh(force) {
  const app = getApp();
  if (!app.globalData.cloudReady || !cache.uid()) return Promise.resolve();
  if (inflight) { if(force)again=true; return inflight; }
  if (!force && Date.now()-last<60000) return Promise.resolve();
  last=Date.now(); const uid=cache.uid();
  inflight=(async()=>{
    await Promise.all([
      refreshUser().then(user=>{if(user&&cache.uid()===uid)publish('user',user);}),
      call('userStats').then(data=>{if(cache.uid()!==uid)return;cache.write('dashboard_stats',data);publish('stats',data);}),
      (async()=>{
        const data=await call('listUsage',{page:1});
        const depth=Math.max(1,Math.min((cache.read('usage')||{}).page||1,10,Math.ceil((data.total||0)/20)||1));
        let list=data.list||[];
        if(depth>1){const rows=await Promise.all(Array.from({length:depth-1},(_,i)=>call('listUsage',{page:i+2})));rows.forEach(r=>{list=list.concat(r.list||[]);});}
        if(cache.uid()!==uid)return;
        const result={...data,list,_pages:depth,hasMore:list.length<(data.total||0)};
        cache.write('dashboard_usage',result);publish('usage',result);
      })(),
    ].map(p=>p.catch(()=>null)));
  })().catch(()=>{}).finally(()=>{inflight=null;if(again){again=false;refresh(true);}});
  return inflight;
}
function foreground(value) {
  active=!!value;clearTimeout(timer);timer=null;
  if(!active)return;
  refresh(true);
  const tick=()=>{if(!active)return;refresh(false);timer=setTimeout(tick,60000);};
  timer=setTimeout(tick,60000);
}
module.exports={read,refresh,foreground,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
