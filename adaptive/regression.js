'use strict';
const assert=require('node:assert/strict');
const E=require('./engine');
let n=0;
function test(name,fn){fn();n++;console.log('PASS '+name)}
function begin(){const s=E.create();E.selectInterest(s,'unknown');E.presentation(s,'scenario','confirmed');return s}
function move(s,a,d='confirmed'){E.act(s,a);E.presentation(s,'consequence',d,s.current.turns)}
function s3(){const s=begin();move(s,'add');E.next(s);E.presentation(s,'scenario','confirmed');move(s,'copy');move(s,'copy');E.next(s);E.presentation(s,'scenario','confirmed');return s}
test('terminal consequence can be acknowledged',()=>{const s=begin();E.act(s,'add');assert.equal(s.current.done,true);E.presentation(s,'consequence','confirmed',1);assert.equal(s.current.consequenceDelivery,'confirmed')});
test('scenario must be confirmed before action',()=>{const s=E.create();E.selectInterest(s,'unknown');assert.throws(()=>E.act(s,'add'),/scenario not confirmed/)});
test('pending help blocks action',()=>{const s=begin();E.help(s);assert.throws(()=>E.act(s,'add'),/help pending/)});
test('acknowledgement must match turn',()=>{const s=s3();E.act(s,'copy');assert.throws(()=>E.presentation(s,'consequence','confirmed',2),/invalid consequence turn/)});
test('consequence cannot be acknowledged before action',()=>{const s=begin();assert.throws(()=>E.presentation(s,'consequence','confirmed',1),/invalid consequence turn/)});
test('restore rejects invalid turn count',()=>{const s=s3();move(s,'copy');const bad=JSON.parse(JSON.stringify(s));bad.current.turns=100;bad.episodes.at(-1).turns=100;assert.throws(()=>E.restore(JSON.stringify(bad)),/invalid episode turns/)});
test('unseen failure does not establish independent switch',()=>{const s=s3();move(s,'copy');move(s,'copy','unknown');move(s,'check');assert.equal(s.current.changed,false);assert.equal(E.offer(s),'choice')});
test('confirmed failure permits independent switch',()=>{const s=s3();move(s,'copy');move(s,'copy');move(s,'check');assert.equal(s.current.changed,true)});
console.log('PASS '+n+' regression tests');
