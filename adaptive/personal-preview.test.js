'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const E=require('./engine');
const {syntheticS2Entry}=require('./personal-preview');
const {createSceneSource,apply}=require('./s3-source');

test('default S2 still refuses unknown exposure even on a preview-marked state',()=>{
  const s=syntheticS2Entry();
  assert.equal(s.current.delivery,'unknown');
  assert.throws(()=>E.act(s,'copy'),/scenario not confirmed/);
  assert.equal(s.current.turns,0);
});
test('preview only accepts unknown S2 without creating independent evidence',()=>{
  const s=syntheticS2Entry();
  const uuid='12345678-1234-4234-8234-123456789abc';
  const source=createSceneSource(s,'S2',{newId:()=>uuid});
  const request={kind:'action',commandId:'preview-1',action:'copy'};
  assert.throws(()=>apply(source,request),/scenario not confirmed/);
  assert.equal(source.events.length,1);
  const result=apply(source,request,{previewAllowUnknownS2:true});
  assert.equal(result.status,'APPLIED');
  assert.equal(source.state.current.delivery,'unknown');
  assert.equal(source.state.current.turns,1);
  assert.equal(source.state.current.continued,false);
  assert.equal(source.events.filter(e=>e.type==='ACTION_ACCEPTED').length,1);
  assert.equal(apply(source,request,{previewAllowUnknownS2:true}).status,'REPLAYED');
});
test('a non-preview state cannot bypass S2 exposure even with a preview option',()=>{
  const s=syntheticS2Entry();
  s.previewOnly=false;
  assert.throws(()=>E.act(s,'copy',{previewAllowUnknownS2:true}),/scenario not confirmed/);
});
