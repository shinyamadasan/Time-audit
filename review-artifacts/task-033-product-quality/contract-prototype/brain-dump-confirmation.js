// Exact server inspection for schema-3 edited promotions. No SDK-cache fallback or writes.
import { validBrainDumpId, brainDumpPlanItemId } from './brain-dump-model.js';
import { physicalTargetKey, FENCE_REMOTE_PATHS } from './plan-item-origin.js';

export function createPromotionConfirmation({context,fetchImpl=globalThis.fetch,timeoutMs=8000}) {
  async function read(segments) {
    const ctx={...context()};
    if (!ctx?.uid || !Number.isInteger(ctx.generation) || !ctx.databaseURL || !ctx.roomRef || typeof ctx.getIdToken !== 'function') return {ok:false,reason:'offline'};
    const current=()=>{const next=context();return next?.uid===ctx.uid && next.generation===ctx.generation && next.databaseURL===ctx.databaseURL;};
    const controller=new AbortController();let active=true,timer;
    const timeout=new Promise(resolve=>{timer=setTimeout(()=>{active=false;controller.abort();resolve({ok:false,reason:'pending'});},timeoutMs);});
    const work=(async()=>{
      try {
        const token=await ctx.getIdToken();
        if (!active || !current()) return {ok:false,reason:'owner-changed'};
        if (typeof token !== 'string' || !token) return {ok:false,reason:'offline'};
        const url=new URL(`rooms/${encodeURIComponent(`uid_${ctx.uid}`)}/${segments.map(encodeURIComponent).join('/')}.json`,ctx.databaseURL);
        url.searchParams.set('auth',token);
        const response=await fetchImpl(url.href,{method:'GET',cache:'no-store',signal:controller.signal});
        if (!response.ok) return {ok:false,reason:'unconfirmed'};
        const value=await response.json();
        return active && current() ? {ok:true,value} : {ok:false,reason:'owner-changed'};
      } catch { return {ok:false,reason:'unconfirmed'}; }
    })();
    return Promise.race([work,timeout]).finally(()=>{active=false;clearTimeout(timer);});
  }
  return {
    ownerGuard() { const initial={...context()};return ()=>{const next=context();return !!initial?.uid && initial.uid===next?.uid && initial.generation===next.generation;}; },
    readCapture(id) { return validBrainDumpId(id) ? read(['brainDump',id]) : Promise.resolve({ok:false,reason:'invalid-input'}); },
    readItem(target,id) {
      const captureId=typeof id==='string' ? id.replace(/^bdp1\|/,'') : '';
      const key=physicalTargetKey(target?.store,target?.id);
      if (!validBrainDumpId(captureId) || id!==brainDumpPlanItemId(captureId) || !key || !FENCE_REMOTE_PATHS[target.store]) return Promise.resolve({ok:false,reason:'invalid-input'});
      return read([FENCE_REMOTE_PATHS[target.store],key,id]);
    },
  };
}

export const promotionConfirmation=createPromotionConfirmation({context:()=>globalThis.getTaskCompletionAppContext?.()});
