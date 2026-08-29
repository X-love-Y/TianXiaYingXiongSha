'use strict';
const BASE='http://127.0.0.1:8000';
async function api(p,m,b){const r=await fetch(`${BASE}${p}`,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});const pl=await r.json().catch(()=>({}));return {status:r.status,payload:pl};}
function shuffle(v){const l=[...v];for(let i=l.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[l[i],l[j]]=[l[j],l[i]];}return l;}
function roomCode(){return String(100000+Math.floor(Math.random()*900000));}
async function waitReady(code,timeout=60000){const dl=Date.now()+timeout;while(Date.now()<dl){const {payload}=await api('/api/rooms','GET');if(payload.rooms[code]?.heroGeneration?.status==='READY'&&payload.rooms[code].generatedHeroes)return payload.rooms[code];await new Promise(r=>setTimeout(r,200));}throw new Error('timeout');}
async function main(){
  const code=roomCode();
  const players=['p1','p2','p3','p4'].map((id,i)=>({id,nickname:`玩家${i+1}`,role:i===0?'host':'player'}));
  let r=await api('/api/rooms','PUT',{changes:{[code]:{roomCode:code,phase:'CUSTOMIZING',mode:'free',duration:0,players,customizations:{},confirmations:{},picks:{},specialCards:[],heroGeneration:{status:'WAITING'}}},knownRevisions:{}});
  if(r.status!==200) throw new Error('create');
  const desc='擅长篮球连击和进攻';
  for(const p of players){r=await api(`/api/rooms/${code}/customizations`,'POST',{playerId:p.id,cards:Array.from({length:5},(_,i)=>({name:`${p.nickname}英雄${i}`,description:desc}))});if(r.status>=400)throw new Error('submit');}
  await waitReady(code);
  // 并发确认
  const confirmResults=await Promise.all(players.map(p=>api(`/api/rooms/${code}/confirmations`,'POST',{playerId:p.id})));
  console.log('confirm statuses:', confirmResults.map(x=>x.status).join(','));
  let room=(await api('/api/rooms','GET')).payload.rooms[code];
  console.log('after confirm phase=',room.phase,'confirmed=',Object.keys(room.confirmations||{}).length);
  // 并发选将
  const selResults=await Promise.all(players.map(p=>{const dealt=room.dealtHands[p.id];const [m,s]=shuffle(dealt);return api(`/api/rooms/${code}/selections`,'POST',{playerId:p.id,mainHeroId:m.id,secondaryHeroId:s.id});}));
  console.log('select statuses:', selResults.map(x=>x.status).join(','));
  room=(await api('/api/rooms','GET')).payload.rooms[code];
  console.log('after select phase=',room.phase,'has game=',!!room.game,'specialCards=',room.specialCards?.length);
  if(room.phase!=='PLAYING') throw new Error('did not reach PLAYING');
  if(!room.game) throw new Error('no authoritative game');
  console.log('CONCURRENT FLOW OK');
}
main().catch(e=>{console.error(e);process.exit(1);});
