'use strict';
const assert=require('node:assert/strict');
const { test }=require('node:test');
const E=require('./engine');
const {createS3Repository,EVENT_NAME,RECEIPT_NAME}=require('./s3-postgres');
const context={userId:1,sessionId:'set-001',episodeId:'12345678-1234-4234-8234-123456789abc'};
function s3() {
  let s=E.create();E.selectInterest(s,'unknown');E.presentation(s,'scenario','confirmed');
  E.act(s,'add');E.presentation(s,'consequence','confirmed',1);E.next(s);
  E.presentation(s,'scenario','confirmed');E.act(s,'copy');E.presentation(s,'consequence','confirmed',1);
  E.act(s,'copy');E.presentation(s,'consequence','confirmed',2);E.next(s);return s;
}
function fakePg({failOnEvent=false}={}) {
  let durable={ episodes:new Map(), events:[], nextId:0 }, inTx=null;
  const clone=x=>structuredClone(x);
  const state=()=>inTx??durable;
  const rows=x=>({rows:x,rowCount:x.length});
  function query(sql,params=[]) {
    const q=sql.replace(/\s+/g,' ').trim();
    if(q==='BEGIN'){if(inTx)throw Error('double begin');inTx=clone(durable);return rows([])}
    if(q==='COMMIT'){durable=inTx;inTx=null;return rows([])}
    if(q==='ROLLBACK'){inTx=null;return rows([])}
    if(q.includes('pg_advisory_xact_lock'))return rows([{}]);
    if(q.includes('FROM nablon_sessions'))return rows(params[0]===context.sessionId&&params[1]===context.userId?[{id:context.sessionId}]:[]);
    if(q.includes('FROM nablon_episodes')){
      let ep=state().episodes.get(params[0]);return rows(ep&&ep.session_id===params[1]?[clone(ep)]:[]);
    }
    if(q.includes('INSERT INTO nablon_episodes')){
      if(state().episodes.has(params[0]))throw Error('duplicate episode');state().episodes.set(params[0],{id:params[0],session_id:params[1],scene_id:'S3',status:'WAITING_RESPONSE'});return rows([]);
    }
    if(q.includes('UPDATE nablon_episodes SET')){
      let ep=state().episodes.get(params[0]);ep.status=params[2];ep.turn_index=params[1];return rows([]);
    }
    if(q.includes('INSERT INTO nablon_events')){
      const name=params[3];if(failOnEvent&&name===EVENT_NAME&&state().events.length>=3){failOnEvent=false;throw Error('SIMULATED_PG_FAILURE')}
      const date=new Date(Date.UTC(2026,10,22,10,0,state().events.length));
      const e={id:++state().nextId,user_id:params[0],session_id:params[1],episode_id:params[2],event_name:name,turn_index:params[4],payload:JSON.parse(params[9]),occurred_at:date};state().events.push(e);
      return rows([{id:e.id,occurred_at:date}]);
    }
    if(q.includes('FROM nablon_events')){
      let select=state().events.filter(x=>x.user_id===params[0]&&x.session_id===params[1]&&x.episode_id===params[2]&&x.event_name===params[3]);
      if(q.includes('DESC'))select=select.slice().reverse().slice(0,1);
      return rows(clone(select));
    }
    throw Error('Unknown SQL: '+q);
  }
  const pool={ connect:async()=>({query:async(...args)=>query(...args),release(){}}),query:async(...args)=>query(...args)};
  return {pool,inspect:()=>clone(durable),setFail:()=>{failOnEvent=true}};
}
const request=(commandId,action)=>({commandId,kind:'action',action});
test('S3 action with unknown exposure writes action and consequence in one commit',async()=>{
  const db=fakePg(),repo=createS3Repository(db.pool);await repo.start(context,s3(),'start');
  const r=await repo.execute(context,request('u1','copy'));
  assert.deepEqual(r.canonicalEvents.map(e=>e.type),['ACTION_ACCEPTED','CONSEQUENCE_PREPARED']);
  assert.equal(r.status,'APPLIED');
  const stored=await repo.readSource(context);
  assert.equal(stored.state.current.delivery,'unknown');
  assert.equal(stored.state.current.turns,1);
  assert.equal(stored.state.current.changed,false);
  const actual=await repo.readPrimaryEvents(context);
  assert.deepEqual(stored.events,actual);
  assert.equal(db.inspect().events.filter(x=>x.event_name===RECEIPT_NAME).length,2);
});
test('exact replay after commit returns fixed events; changed payload conflicts without new action',async()=>{
  const db=fakePg(),repo=createS3Repository(db.pool);await repo.start(context,s3(),'start');
  const once=await repo.execute(context,request('u1','copy'));
  let count=db.inspect().events.length;
  assert.deepEqual(await repo.execute(context,request('u1','copy')),{...once,status:'REPLAYED'});
  assert.equal((await repo.execute(context,request('u1','delete'))).status,'CONFLICT');
  assert.equal((await repo.start(context,s3(),'start')).status,'REPLAYED');
  assert.equal(db.inspect().events.length,count);
});
test('rollback erases action, canonical facts, checkpoint, and permits retry once',async()=>{
  const db=fakePg(),repo=createS3Repository(db.pool);await repo.start(context,s3(),'start');
  db.setFail();const before=db.inspect();
  await assert.rejects(()=>repo.execute(context,request('u1','copy')),/SIMULATED_PG_FAILURE/);
  assert.deepEqual(db.inspect(),before);
  const ret=await repo.execute(context,request('u1','copy'));
  assert.equal(ret.status,'APPLIED');
  assert.equal((await repo.execute(context,request('u1','copy'))).status,'REPLAYED');
  assert.equal((await repo.readPrimaryEvents(context)).filter(e=>e.type==='ACTION_ACCEPTED').length,1);
});
test('a Telegram confirmed report remains unknown and cannot prove independent change',async()=>{
  const db=fakePg(),repo=createS3Repository(db.pool);await repo.start(context,s3(),'start');
  await repo.execute(context,{commandId:'ack-intro',kind:'presentation',presentationKind:'scenario',delivery:'confirmed'});
  await repo.execute(context,request('u1','copy'));
  await repo.execute(context,{commandId:'ack1',kind:'presentation',presentationKind:'consequence',turn:1,delivery:'confirmed'});
  await repo.execute(context,request('u2','copy'));
  await repo.execute(context,{commandId:'ack2',kind:'presentation',presentationKind:'consequence',turn:2,delivery:'confirmed'});
  await repo.execute(context,request('u3','check'));
  await repo.execute(context,request('u4','delete'));
  await repo.execute(context,request('u5','copy'));
  let state=(await repo.readSource(context)).state.current;
  assert.equal(state.delivery,'unknown');assert.equal(state.consequenceDelivery,'unknown');
  assert.equal(state.changed,false);assert.equal(state.precautionary,false);
  assert.equal(E.offer((await repo.readSource(context)).state),'choice');
});
test('failed start leaves no orphan episode and successful repeat does not create second',async()=>{
  const db=fakePg(),repo=createS3Repository(db.pool);await repo.start(context,s3(),'start');
  const count=db.inspect().events.length;
  assert.equal((await repo.start(context,s3(),'start')).status,'REPLAYED');
  assert.equal(db.inspect().events.length,count);
  assert.equal(db.inspect().episodes.size,1);
});
