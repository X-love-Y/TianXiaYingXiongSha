'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const BASE = 'http://127.0.0.1:8000';
async function api(p, m, b) { const r = await fetch(`${BASE}${p}`, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); const pl = await r.json().catch(() => ({})); return { status: r.status, payload: pl }; }
function shuffle(v){const l=[...v];for(let i=l.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[l[i],l[j]]=[l[j],l[i]];}return l;}
function roomCode(){return String(100000+Math.floor(Math.random()*900000));}
async function waitReady(code,t=90000){const dl=Date.now()+t;while(Date.now()<dl){const {payload}=await api('/api/rooms','GET');if(payload.rooms[code]?.heroGeneration?.status==='READY'&&payload.rooms[code].generatedHeroes)return payload.rooms[code];await new Promise(r=>setTimeout(r,300));}throw new Error('timeout');}
class CL{constructor(){this.s=new Set();}add(...n){n.forEach(x=>this.s.add(x));}remove(...n){n.forEach(x=>this.s.delete(x));}toggle(n,f){if(f===undefined){if(this.s.has(n)){this.s.delete(n);return false;}this.s.add(n);return true;}if(f)this.s.add(n);else this.s.delete(n);return !!f;}contains(n){return this.s.has(n);}}
class FS{setProperty(){}}
class FE{constructor(id){this.id=id;this.classList=new CL();this.style=new FS();this.dataset={};this.children=[];this._i='';this.disabled=false;this.open=false;this.textContent='';this.value='';this.currentTime=0;this.offsetWidth=0;this.handlers={};}get innerHTML(){return this._i;}set innerHTML(v){this._i=v;}addEventListener(t,fn){(this.handlers[t]=this.handlers[t]||[]).push(fn);}querySelectorAll(){return [];}querySelector(){return null;}showModal(){this.open=true;}close(){this.open=false;}play(){return Promise.resolve();}click(){}}
async function main(){
  const code=roomCode();
  const players=['p1','p2','p3','p4'].map((id,i)=>({id,nickname:`玩家${i+1}`,role:i===0?'host':'player'}));
  let r=await api('/api/rooms','PUT',{changes:{[code]:{roomCode:code,phase:'CUSTOMIZING',mode:'free',duration:0,players,customizations:{},confirmations:{},picks:{},specialCards:[],aiConfig:{provider:'openai'},heroGeneration:{status:'WAITING'}}},knownRevisions:{}});
  if(r.status!==200) throw new Error('create');
  const desc='擅长篮球连击和进攻';
  for(const p of players){r=await api(`/api/rooms/${code}/customizations`,'POST',{playerId:p.id,cards:Array.from({length:5},(_,i)=>({name:`${p.nickname}英雄${i}`,description:desc}))});if(r.status>=400)throw new Error('submit');}
  let room=await waitReady(code);
  for(const p of players){await api(`/api/rooms/${code}/confirmations`,'POST',{playerId:p.id});}
  room=(await api('/api/rooms','GET')).payload.rooms[code];
  for(const p of players){const dealt=room.dealtHands[p.id];const [m,s]=shuffle(dealt);await api(`/api/rooms/${code}/selections`,'POST',{playerId:p.id,mainHeroId:m.id,secondaryHeroId:s.id});}
  room=(await api('/api/rooms','GET')).payload.rooms[code];
  console.log('server has game?',!!room.game);

  const roomStorageKey='heroKillLocalRooms',sessionStorageKey='heroKillRoomSession';
  const roomNoGame=JSON.parse(JSON.stringify(room));delete roomNoGame.game;
  const localStore=new Map([[roomStorageKey,JSON.stringify({[code]:roomNoGame})]]);
  const sessionStore=new Map([[sessionStorageKey,JSON.stringify({roomCode:code,playerId:'p1'})]]);
  const elements=new Map();const makeEl=(id)=>{if(!elements.has(id))elements.set(id,new FE(id));return elements.get(id);};
  const esInstances=[];
  const FakeEventSource=class{constructor(){esInstances.push(this);}close(){}addEventListener(t,fn){this[t]=fn;}};
  class FakeEvent{constructor(type,opts){this.type=type;if(opts)Object.assign(this,opts);}}
  class FakeStorageEvent extends FakeEvent{}
  const storageListeners=[];
  const sandbox={console,Math,Date,JSON,Object,Array,Map,Set,Promise,String,Number,Boolean,RegExp,Error,parseInt,parseFloat,isNaN,
    setTimeout:(f,ms=0)=>({f,ms}),setInterval:(f,ms=0)=>({f,ms}),clearTimeout:()=>{},clearInterval:()=>{},
    EventSource:FakeEventSource,Event:FakeEvent,StorageEvent:FakeStorageEvent,
    fetch:()=>{throw new Error('fetch unavailable');},
    localStorage:{getItem:k=>localStore.has(k)?localStore.get(k):null,setItem:(k,v)=>localStore.set(k,String(v)),removeItem:k=>localStore.delete(k)},
    sessionStorage:{getItem:k=>sessionStore.has(k)?sessionStore.get(k):null,setItem:(k,v)=>sessionStore.set(k,String(v)),removeItem:k=>sessionStore.delete(k)},
    document:{getElementById:id=>makeEl(id),querySelector:()=>makeEl('__q__'),querySelectorAll:()=>[],addEventListener:()=>{}},
    window:{addEventListener:(t,fn)=>storageListeners.push({t,fn}),dispatchEvent:(ev)=>{storageListeners.filter(x=>x.t===ev.type).forEach(x=>x.fn(ev));return true;},location:{href:'',replace:()=>{}},EventSource:FakeEventSource,HeroKillNet:null},
    location:{href:'',replace:()=>{},protocol:'http:'}
  };
  const ctx=vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','network.js'),'utf8'),ctx,{filename:'network.js'});
  const gscript=[...fs.readFileSync(path.join(__dirname,'..','game.html'),'utf8').matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/g)].pop()[1];
  vm.runInContext(gscript,ctx,{filename:'game.html'});
  const ev=(c)=>vm.runInContext(c,ctx,{filename:'e'});
  console.log('initial loadOrCreateGame:',ev('loadOrCreateGame()'),'| gameState?',ev('!!gameState'));
  if(ev('!!gameState')) throw new Error('should start waiting');
  // 通过 SSE 推送带 game 的房间
  const eventData=JSON.stringify({rooms:{[code]:room},updatedAt:Date.now()});
  console.log('EventSource instances:',esInstances.length,'| has rooms listener:',typeof esInstances[0]?.rooms==='function');
  console.log('rooms listener exists on window? typeof window.HeroKillNet:', typeof ev('window.HeroKillNet'));
  esInstances.forEach(es=>{if(es.rooms)es.rooms({data:eventData});});
  const storedRoom=JSON.parse(localStore.get(roomStorageKey))[code];
  console.log('after SSE: localStorage has game?', !!storedRoom?.game, '| game.version=', storedRoom?.game?.version);
  console.log('storage listeners registered:', storageListeners.filter(x=>x.t==='storage').length);
  console.log('after SSE -> gameState?',ev('!!gameState'),'| currentPlayer?',ev('currentPlayer&&currentPlayer.id'));
  ev('try { handleRemoteGameUpdate(); } catch(e) { window.__hguErr = String(e); }');
  console.log('manual handleRemoteGameUpdate -> gameState?',ev('!!gameState'),'| error?',ev('window.__hguErr||""'));
  console.log('loadOrCreateGame after SSE:', ev('loadOrCreateGame()'));
  console.log('player hand len:',ev('currentPlayer?currentPlayer.hand.length:-1'));
  if(!ev('!!gameState')) throw new Error('client did not recover after SSE');
  console.log('CLIENT RECOVERY OK');
}
main().catch(e=>{console.error(e);process.exit(1);});
