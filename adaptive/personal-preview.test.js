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

test('preview Ukrainian text covers every existing scenario and consequence',()=>{
  const {scenarios,consequences}=require('./content');
  const {displayText,previewTranslations}=require('./personal-preview-i18n');
  const ukrainian=previewTranslations('uk');
  for(const [kind,source] of [['scenarios',scenarios],['consequences',consequences]]){
    assert.deepEqual(Object.keys(ukrainian[kind]).sort(),Object.keys(source).sort());
    for(const [key,text] of Object.entries(source)){
      assert.equal(typeof displayText('uk',kind,key,text),'string');
      assert.equal(displayText('ru',kind,key,text),text);
    }
  }
  const labels=previewTranslations('uk').buttons;
  const E=require('./engine');
  for(const command of [...E.ACTIONS.S2,...E.ACTIONS.S3,'S4A','S4B']){
    assert.equal(typeof labels[command],'string');
    assert.ok(labels[command].length>0);
  }
  assert.throws(()=>displayText('uk','scenarios','UNKNOWN','Original'),/Missing preview translation/);
});
