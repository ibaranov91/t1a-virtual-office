import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Table, TABLE_TURN_MS } from './table';
import { Arcade } from './arcade';
import { World } from './world';
import type { PublicUser, ServerMsg } from '../../shared/protocol';
import type { TableGameId, TableView } from '../../shared/table/types';
import * as rules from '../../shared/table/rules';
import * as lastcard from '../../shared/table/lastcard';
import { besideObject, findPath, isWalkable, KEEP_TYPES, layoutProblem, pathDuration, withLayout, type TileMap, type Tile } from '../../shared/map';
type Person = Pick<PublicUser,'id'|'name'|'bot'|'table'|'game'>;
const base:TileMap=JSON.parse(readFileSync(new URL('../../shared/tilemap.json',import.meta.url),'utf8'));
const fixture=base.objects.find(o=>o.type==='game_table')!;
function setup() {
  let now=100000, id=0;
  const users=new Map<string,Person>(), messages=new Map<string,ServerMsg[]>(), broadcasts:ServerMsg[]=[];
  const arcade=new Arcade({now:()=>now,timer:false,user:id=>users.get(id),send(){},broadcast:m=>broadcasts.push(structuredClone(m))});
  const table=new Table({now:()=>now,timer:false,seed:()=>42,id:()=>`match-${++id}`,user:id=>users.get(id),
    send:(id,m)=>messages.get(id)!.push(structuredClone(m)),broadcast:m=>broadcasts.push(structuredClone(m)),
    leaveCabinet:u=>arcade.leave(users.get(u.id)!),commit:(id,g,w)=>arcade.commitTable(id,g,w)});
  const add=(id:string,bot=false)=>{const u:Person={id,name:id,bot,game:null,table:null};users.set(id,u);messages.set(id,[]);table.join(u,fixture.id);return u;};
  const view=(u:Person):TableView=>messages.get(u.id)!.filter((m):m is Extract<ServerMsg,{t:'table'}>=>m.t==='table').at(-1)!.view!;
  const start=(game:TableGameId,people:Person[])=>{
    table.handle(people[0],{t:'table_pick',game,invite:people.slice(1).map(u=>u.id)});
    for(const u of people.slice(1)) table.handle(u,{t:'table_start'});
    table.handle(people[0],{t:'table_start'}); return table.session(people[0])!;
  };
  const move=(u:Person,value:unknown,revision=table.session(u)!.revision)=>table.handle(u,{t:'table_move',matchId:table.session(u)!.match!.id,revision,move:value});
  return {table,arcade,users,messages,broadcasts,add,start,view,move,now:()=>now,time:(n:number)=>{now=n;},tick:(n:number)=>{now=n;table.tick(now);}};
}
test('table: four seats in join order; host handover, public watchers and invitations require consent before frozen roster',()=>{
  const h=setup(),people=['a','b','c','d','watch'].map(id=>h.add(id)),[a,b,c,d,watch]=people;
  assert.deepEqual(h.view(a).sitters,['a','b','c','d']); assert.deepEqual(h.view(watch).watchers,['watch']); assert.equal(h.add('bot',true).table,null);
  h.table.handle(b,{t:'table_pick',game:'chess',invite:[a.id]}); assert.equal(h.view(a).invitation,null);
  h.table.handle(a,{t:'table_pick',game:'chess',invite:[b.id,c.id]}); assert.equal(h.view(a).invitation,null);
  h.table.handle(a,{t:'table_pick',game:'chess',invite:[b.id]}); h.table.handle(a,{t:'table_start'}); assert.equal(h.view(a).match,null);
  h.table.handle(c,{t:'table_start'}); assert.deepEqual(h.view(a).invitation!.accepted,['a']);
  h.table.handle(b,{t:'table_start'}); h.table.handle(a,{t:'table_start'}); const s=h.table.session(a)!;
  assert.deepEqual(s.match!.players,['a','b']); h.table.handle(c,{t:'table_start'}); assert.deepEqual(s.match!.players,['a','b']);
  h.table.leave(a); assert.equal(h.view(b).host,'b'); assert.equal(h.view(b).match!.state.result!.winner,1);
  for(const u of [b,c,d]) h.table.leave(u); assert.equal(h.table.sessions.size,0); assert.equal(watch.table,null);
});
test('table: invitations expire after 30s (including when a Join arrives first); rematch needs every previous player again',()=>{
  const h=setup(),a=h.add('a'),b=h.add('b'),c=h.add('c');
  h.table.handle(a,{t:'table_pick',game:'lastcard',invite:['b','c']}); h.time(h.now()+30000); h.table.handle(b,{t:'table_start'}); assert.equal(h.view(a).invitation,null);
  const s=h.start('lastcard',[a,b,c]); h.table.handle(b,{t:'table_resign',matchId:s.match!.id}); h.table.handle(c,{t:'table_resign',matchId:s.match!.id});
  const old=s.match!.id; h.table.handle(a,{t:'table_pick',game:'lastcard',rematch:true}); assert.equal(s.invitation!.rematch,true); assert.deepEqual(s.invitation!.invited,['b','c']);
  h.table.handle(b,{t:'table_start'}); h.table.handle(a,{t:'table_start'}); assert.equal(s.match!.id,old);
  h.table.handle(c,{t:'table_start'}); h.table.handle(a,{t:'table_start'}); assert.notEqual(s.match!.id,old); assert.deepEqual(s.match!.out,[]);
});
for(const game of ['dominoes','lastcard'] as const) test(`table ${game}: each recipient gets only their own hand, never a pile or other hands; new watchers and eliminated sitters see public state`,()=>{
  const h=setup(),people=['a','b','c','d','watch'].map(id=>h.add(id)),s=h.start(game,people.slice(0,3)),m=s.match!;
  for(const [i,u] of people.entries()) {
    const v=h.view(u).match!; assert.equal(v.game,game);
    if(v.game!=='dominoes'&&v.game!=='lastcard') throw new Error('wrong game');
    assert.equal('hands' in v.state,false); assert.equal('rng' in v.state,false); assert.equal('discards' in v.state,false);
    assert.equal(Array.isArray(v.game==='dominoes'?v.state.boneyard:v.state.pile),false);
    if(i<3) { const expected=m.rules.game==='dominoes'||m.rules.game==='lastcard'?m.rules.state.hands[i]:[]; assert.deepEqual(v.state.hand,expected); }
    else assert.equal('hand' in v.state,false);
  }
  const bye=structuredClone(m.rules.game==='dominoes'||m.rules.game==='lastcard'?m.rules.state.hands[1]:[]);
  h.table.handle(people[1],{t:'table_resign',matchId:m.id}); assert.equal('hand' in h.view(people[1]).match!.state,false);
  assert.deepEqual(m.rules.game==='dominoes'||m.rules.game==='lastcard'?m.rules.state.hands[1]:[],bye);
  const outside=h.add('outside'); assert.equal('hand' in h.view(outside).match!.state,false);
  for(const message of h.broadcasts) assert.notEqual(message.t,'table');
});
test('table: a fresh game with the same rules may invite a different opponent instead of proposing a rematch',()=>{
  const h=setup(),a=h.add('a'),b=h.add('b'),c=h.add('c'),s=h.start('chess',[a,b]);
  h.table.handle(b,{t:'table_resign',matchId:s.match!.id}); h.table.leave(b);
  h.table.handle(a,{t:'table_pick',game:'chess',invite:['c']}); assert.equal(s.invitation!.rematch,false);
  h.table.handle(c,{t:'table_start'}); h.table.handle(a,{t:'table_start'}); assert.deepEqual(s.match!.players,['a','c']);
});
test('table: revisions reject duplicate, stale, malformed, out-of-turn and wrong-match moves without resetting the clock',()=>{
  const h=setup(),a=h.add('a'),b=h.add('b'),s=h.start('chess',[a,b]),revision=s.revision,deadline=s.turnDeadline;
  h.time(h.now()+1000); h.move(b,{from:'e7',to:'e5'}); h.move(a,{from:'e2',to:'e5'}); assert.equal(s.revision,revision); assert.equal(s.turnDeadline,deadline);
  h.table.handle(a,{t:'table_move',matchId:'wrong',revision,move:{from:'e2',to:'e4'}}); assert.equal(s.revision,revision);
  h.move(a,{from:'e2',to:'e4'}); assert.equal(s.revision,revision+1); const nextDeadline=s.turnDeadline;
  h.move(a,{from:'e2',to:'e4'},revision); h.move(b,{from:'e7',to:'e5'},revision); assert.equal(s.revision,revision+1); assert.equal(s.turnDeadline,nextDeadline);
  h.move(b,{from:'e7',to:'e5'},NaN); assert.equal(s.revision,revision+1);
});
test('table: draw offers and answers increment revision, survive own move, expire on opponent move; agreement gives no win',()=>{
  const h=setup(),a=h.add('a'),b=h.add('b'),s=h.start('chess',[a,b]),id=s.match!.id,deadline=s.turnDeadline;
  const offer=()=>h.table.handle(a,{t:'table_draw',matchId:id,offer:true});
  const rev=s.revision; h.time(h.now()+500); offer(); assert.equal(s.revision,rev+1); assert.equal(s.turnDeadline,deadline); offer(); assert.equal(s.revision,rev+1);
  h.move(a,{from:'e2',to:'e4'}); assert.equal(s.match!.drawOffer,'a'); h.move(b,{from:'e7',to:'e5'}); assert.equal(s.match!.drawOffer,null);
  offer(); h.table.handle(b,{t:'table_draw',matchId:id,offer:false}); assert.equal(s.match!.drawOffer,null); assert.equal(s.match!.rules.state.result,null);
  offer(); h.table.handle(b,{t:'table_draw',matchId:id,offer:true}); assert.equal(s.match!.rules.state.result!.winner,null); assert.equal(s.turnDeadline,null); assert.deepEqual(h.arcade.boards().week.table,{});
});
test('table: two-player timeout runs before a move and exactly once; result commits once and survives board reload',()=>{
  const h=setup(),a=h.add('a'),b=h.add('b'),s=h.start('chess',[a,b]),rev=s.revision;
  h.time(s.turnDeadline!); h.move(a,{from:'e2',to:'e4'}); assert.equal(s.match!.rules.state.result!.winner,1); assert.equal(s.revision,rev+1);
  h.tick(h.now()); h.tick(h.now()+TABLE_TURN_MS); h.table.handle(b,{t:'table_resign',matchId:s.match!.id}); assert.equal(s.revision,rev+1);
  assert.equal(h.arcade.boards().week.table.chess.b,1);
  const save=h.arcade.dump(); h.arcade.load(save); h.arcade.commitTable(s.match!.id,'chess','b'); assert.equal(h.arcade.boards().week.table.chess.b,1);
});
for(const game of ['lastcard','dominoes'] as const) test(`table ${game}: multiplayer timeouts auto-act once, second consecutive timeout forfeits; no private hand is recycled`,()=>{
  const h=setup(),people=['a','b','c','d'].map(id=>h.add(id)),s=h.start(game,people),m=s.match!,p=m.rules.state.turn;
  const expected=rules.timeout(m.rules); const rev=s.revision;
  h.tick(s.turnDeadline!); assert.deepEqual(m.rules,expected); assert.equal(s.revision,rev+1); assert.equal(m.timeouts[p],1);
  h.tick(h.now()); assert.equal(s.revision,rev+1);
  // Drive whole turn deadlines until the same player next times out.
  for(let i=0;i<8&&!m.out.includes(m.players[p])&&!m.rules.state.result;i++) h.tick(s.turnDeadline!);
  assert.ok(m.out.includes(m.players[p]));
  assert.equal(m.rules.game,'lastcard'===game?'lastcard':'dominoes');
});
test('table: voluntary turn clears consecutive timeouts; drawn playable card and Catch never extend turn deadline',()=>{
  const h=setup(),people=['a','b','c'].map(id=>h.add(id)),s=h.start('lastcard',people),m=s.match!;
  if(m.rules.game!=='lastcard') throw new Error('wrong game');
  const red=lastcard.cards().filter(c=>c.colour==='red'&&c.symbol==='1');
  m.rules.state.turn=0; m.rules.state.colour='red'; m.rules.state.discards=[lastcard.cards().find(c=>c.colour==='red'&&c.symbol==='0')!];
  m.rules.state.pile.unshift(red[0]); m.timeouts[0]=1; const deadline=s.turnDeadline;
  h.time(h.now()+1000); h.move(people[0],{kind:'draw'}); assert.equal(s.turnDeadline,deadline); assert.equal(m.timeouts[0],1);
  h.move(people[0],{kind:'pass'}); assert.equal(m.timeouts[0],0); assert.equal(s.turnDeadline,h.now()+TABLE_TURN_MS);
  m.rules.state.catchable=0; const catchDeadline=s.turnDeadline; h.move(people[2],{kind:'catch'}); assert.equal(s.turnDeadline,catchDeadline);
  assert.equal(m.rules.state.catchable,null);
});
for(const n of [2,3,4]) test(`table: leaving with ${n} players preserves frozen roster and removes hands from play; final active player wins`,()=>{
  const h=setup(),people=Array.from({length:n},(_,i)=>h.add(String(i))),s=h.start('lastcard',people),m=s.match!;
  const roster=[...m.players], hands=m.rules.game==='lastcard'?structuredClone(m.rules.state.hands):[];
  h.table.leave(people[1]); assert.deepEqual(m.players,roster); assert.ok(m.out.includes('1'));
  if(m.rules.game!=='lastcard') throw new Error('wrong game'); assert.deepEqual(m.rules.state.hands[1],hands[1]);
  for(const u of people.slice(2)) h.table.leave(u);
  assert.equal(m.rules.state.result!.winner,0); assert.equal(h.arcade.boards().week.table.lastcard['0'],1);
});
function worldSetup(t:TestContext) {
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:100000}); const w=new World(structuredClone(base));
  const add=(name:string,tile:Tile={x:58,y:16})=>{const u=w.addUser(name,false,tile);u.presence='online'; const messages:ServerMsg[]=[];const c=w.connect(u.id,m=>messages.push(structuredClone(m)));return{u,messages,...c};};
  return{w,add,tick:(n:number)=>t.mock.timers.tick(n)};
}
test('table world: fixture is protected/nonwalkable/reachable, saved layouts gain exactly one fixture and retain edits',t=>{
  assert.deepEqual([fixture.x,fixture.y,fixture.w,fixture.h],[58,17,2,1]); assert.equal(fixture.use!.kind,'table'); assert.ok(KEEP_TYPES.has('game_table')); assert.equal(isWalkable(base,58,17),false);
  assert.ok(besideObject(base,fixture).some(t=>findPath(base,base.spawn,t).length));
  const blockers=besideObject(base,fixture).map((p,i)=>({id:`block${i}`,type:'plant',...p,w:1,h:1}));
  assert.equal(layoutProblem(withLayout(base,{objects:[...base.objects,...blockers],rugs:base.rugs})),'nobody could reach the game table');
  const {w,add}=worldSetup(t),a=add('a'),saved=w.dump(); saved.layout=structuredClone({objects:base.objects.filter(o=>o.type!=='game_table'),rugs:base.rugs});
  const cabinet=saved.layout.objects.find(o=>o.type==='arcade')!; cabinet.x=55;
  w.load(saved); assert.equal(w.map.objects.filter(o=>o.type==='game_table').length,1); assert.equal(w.map.objects.find(o=>o.id===cabinet.id)!.x,55);
  assert.equal(layoutProblem(w.map),null); assert.equal(w.users.get(a.u.id)!.table,null);
});
test('table world: clicking walks beside table; cabinet/table exclusive; accepted walk, meeting, layout step-aside and door grace leave',t=>{
  const {w,add,tick}=worldSetup(t),a=add('Andrii',{x:55,y:16}),cabinet=base.objects.find(o=>o.type==='arcade')!;
  w.arcade.join(a.u,cabinet.id); w.use(a.u,fixture.id); assert.equal(a.u.game,null); assert.equal(a.u.table??null,null);
  tick(pathDuration(a.u.path!)+1); assert.equal(a.u.table?.objectId,fixture.id);
  assert.equal(w.walk(a.u,{x:0,y:0}),null); assert.ok(a.u.table);
  w.use(a.u,cabinet.id); assert.equal(a.u.table,null); tick(pathDuration(a.u.path!)+1); assert.ok(a.u.game);
  w.table.join(a.u,fixture.id); assert.equal(a.u.game,null);
  a.u.email='andrii.butko@t1a.com'; const event={key:'m',instance:'m-room',start:Date.now(),end:Date.now()+60000,title:'meeting',emails:[a.u.email],owners:new Set([a.u.id])};
  w.meetings.events.set('m',event); w.enterMeeting(a.u,'m'); assert.equal(a.u.table,null); w.leaveMeeting(a.u);
  a.u.tile={x:55,y:16};a.u.move=null;a.u.path=null;w.table.join(a.u,fixture.id);w.edit(a.u,{op:'add',type:'plant',x:55,y:16}); assert.equal(a.u.table,null);
  w.table.join(a.u,fixture.id);a.close();tick(1000);assert.ok(a.u.table);tick(4000);assert.equal(a.u.table,null);
});
test('table world: owner-only mutations, redacted reconnect/handover resend and old owner null, disconnect keeps seat and clock through grace',t=>{
  const {w,add,tick}=worldSetup(t),a=add('a'),b=add('b'),watch=add('watch'); for(const p of [a,b,watch]) w.table.join(p.u,fixture.id);
  w.handle(a.u,{t:'table_pick',game:'lastcard',invite:[b.u.id]},a.socket);w.handle(b.u,{t:'table_start'},b.socket);w.handle(a.u,{t:'table_start'},a.socket);
  const s=w.table.session(a.u)!,deadline=s.turnDeadline,more:ServerMsg[]=[];
  const second=w.connect(a.u.id,m=>more.push(structuredClone(m)));
  assert.ok(a.messages.some(m=>m.t==='table'&&m.view===null)); assert.ok(more.some(m=>m.t==='table'&&m.view?.match?.id===s.match!.id));
  const rev=s.revision;w.handle(a.u,{t:'table_leave'},a.socket);assert.equal(s.revision,rev);assert.ok(a.u.table);
  for(const m of more) if(m.t==='table'&&m.view?.match?.game==='lastcard') assert.deepEqual(m.view.match.state.hand,(s.match!.rules as Extract<rules.GameState,{game:'lastcard'}>).state.hands[0]);
  a.messages.length=0; more.length=0;
  w.handle(a.u,{t:'voice_claim'},a.socket);assert.ok(more.some(m=>m.t==='table'&&m.view===null));assert.ok(a.messages.some(m=>m.t==='table'&&m.view?.match));
  assert.equal(s.turnDeadline,deadline); second.close(); a.close(); tick(1000);assert.ok(a.u.table);assert.equal(s.turnDeadline,deadline);
  const back:ServerMsg[]=[];w.connect(a.u.id,m=>back.push(structuredClone(m)));assert.ok(back.some(m=>m.t==='table'&&m.view?.match));assert.equal(s.turnDeadline,deadline);
});
test('table world: pending arrival rejects bots, offline, removed, repurposed and wandering users',t=>{
  const {w,add,tick}=worldSetup(t);
  for(const reason of ['bot','offline','removed','repurposed','wandered']) {
    const a=add(reason,{x:55,y:16}),o=w.map.objects.find(o=>o.id===fixture.id)!,copy=structuredClone(o);w.use(a.u,o.id); const duration=pathDuration(a.u.path!);
    if(reason==='bot')a.u.bot=true;if(reason==='offline')a.u.presence='offline';if(reason==='removed')w.map.objects=w.map.objects.filter(it=>it!==o);if(reason==='repurposed')o.use={kind:'records',label:'Records'};if(reason==='wandered')w.walk(a.u,{x:57,y:19});
    tick(duration+1);assert.equal(a.u.table??null,null,reason);if(reason==='removed')w.map.objects.push(copy);else Object.assign(o,copy);a.u.presence='offline';
  }
});
