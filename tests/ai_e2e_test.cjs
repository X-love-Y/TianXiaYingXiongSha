'use strict';
const BASE = 'http://127.0.0.1:8000';
async function api(p, method, body) {
  const r = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const payload = await r.json().catch(() => ({}));
  return { status: r.status, payload };
}
function shuffle(v){ const l=[...v]; for(let i=l.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [l[i],l[j]]=[l[j],l[i]];} return l; }
function roomCode(){ return String(100000 + Math.floor(Math.random()*900000)); }
async function waitReady(code, timeoutMs=90000){
  const dl=Date.now()+timeoutMs;
  while(Date.now()<dl){
    const {payload}=await api('/api/rooms','GET');
    const room=payload.rooms[code];
    if(room?.heroGeneration?.status==='READY' && room.generatedHeroes) return room;
    if(room?.heroGeneration?.status==='FAILED') throw new Error('generation FAILED');
    await new Promise(r=>setTimeout(r,400));
  }
  throw new Error('generation timeout');
}

async function main(){
  const code=roomCode();
  const players=['p1','p2','p3','p4'].map((id,i)=>({id,nickname:`玩家${i+1}`,role:i===0?'host':'player'}));
  let r=await api('/api/rooms','PUT',{changes:{[code]:{roomCode:code,phase:'CUSTOMIZING',mode:'free',duration:0,players,customizations:{},confirmations:{},picks:{},specialCards:[],heroGeneration:{status:'WAITING'}}},knownRevisions:{}});
  if(r.status!==200) throw new Error('create '+JSON.stringify(r.payload));
  const descs=['擅长篮球连击和进攻，猛攻压制对手','医生仁心，治疗救护回血','刺客身法闪避，灵巧收割','坦克防御铁壁，挨打抗压'];
  for(let i=0;i<players.length;i++){
    const p=players[i];
    const cards=Array.from({length:5},(_,k)=>({name:`${p.nickname}英雄${k}`,description:`${descs[i]} ${k}号`}));
    r=await api(`/api/rooms/${code}/customizations`,'POST',{playerId:p.id,cards});
    if(r.status>=400) throw new Error('submit');
  }
  console.log('submitted all, waiting for DeepSeek generation...');
  const room=await waitReady(code);
  let ai=0, fallback=0, total=0;
  Object.values(room.generatedHeroes).forEach((heroes)=>heroes.forEach((h)=>{ total++; if(h.generationSource==='fallback') fallback++; else ai++; }));
  console.log('generated heroes total=',total,'ai=',ai,'fallback=',fallback,'status=',room.heroGeneration.status);
  const sample=(room.generatedHeroes?.p1||[])[0];
  console.log('sample hero:', JSON.stringify({name:sample?.heroName, title:sample?.title, primary:sample?.primarySkill?.templateId, secondary:sample?.secondarySkill?.templateId, special:sample?.specialSkill?.templateId}));
  if(total!==20) throw new Error('expected 20 heroes, got '+total);
  if(ai<1) throw new Error('DeepSeek generation did not produce AI heroes (all fallback)');
  console.log('AI E2E OK');
}
main().catch((e)=>{console.error(e);process.exit(1);});
