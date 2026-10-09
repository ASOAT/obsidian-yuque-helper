'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {executeSync,digest,docBody}=require('../engine');
function harness(initial={}) {
  const state={books:{},notes:{},pendingBooks:{},pendingDocs:{},assets:{},...initial};
  const remoteBooks=new Map(Object.values(state.books).map(b=>[b.id,{...b}]));
  const docs=new Map();let id=100;const calls=[];
  const client={
    listBooks:async()=>[...remoteBooks.values()].map(b=>({...b})),
    createBook:async(name,slug)=>{const b={id:++id,name,slug,url:'https://www.yuque.com/test/'+slug};remoteBooks.set(b.id,b);calls.push('book');return {...b};},
    listDocs:async book=>[...docs.values()].filter(d=>d.bookId===book.id).map(d=>({...d})),
    createDoc:async(book,title,slug,body)=>{const d={id:++id,title,slug,body,bookId:book.id,format:'markdown',url:book.url+'/'+slug};docs.set(d.id,d);calls.push('create');return {...d};},
    readDoc:async(_book,doc)=>({...docs.get(doc.id)}),
    updateDoc:async(_book,doc,title,body)=>{Object.assign(docs.get(doc.id),{title,body});calls.push('update');},
    deleteDoc:async(_book,doc)=>{docs.delete(doc.id);calls.push('delete');}
  };
  const note=(path,body='local')=>({path,folder:path.split('/')[0],title:path.split('/').pop().replace(/\.md$/,''),source:body,calculateHash:async()=>digest(body)});
  const run=(notes,options={})=>executeSync({state,notes,folders:['A'],client,saveState:async()=>{},convert:async n=>({markdown:n.source,warnings:[]}),canDelete:async()=>true,...options});
  return {state,docs,client,calls,note,run};
}
test('second sync retains remote ID and skips unchanged verified content',async()=>{
  const h=harness(); await h.run([h.note('A/one.md')]);const id=h.state.notes['A/one.md'].id;
  const r=await h.run([h.note('A/one.md')]);assert.equal(h.state.notes['A/one.md'].id,id);assert.equal(h.docs.size,1);assert.equal(r.skipped,1);assert.equal(h.calls.filter(x=>x==='create').length,1);
});
test('remote edits are overwritten even when local hash has not changed',async()=>{
  const h=harness();await h.run([h.note('A/a.md')]);const record=h.state.notes['A/a.md'];h.docs.get(record.id).body='remote change';
  const r=await h.run([h.note('A/a.md')]);assert.equal(r.updated,1);assert.equal(h.docs.get(record.id).body,'local');
});
test('remote title edits are overwritten even when body hash has not changed',async()=>{
  const h=harness();await h.run([h.note('A/a.md')]);const record=h.state.notes['A/a.md'];h.docs.get(record.id).title='remote title';
  const r=await h.run([h.note('A/a.md')]);assert.equal(r.updated,1);assert.equal(h.docs.get(record.id).title,'a');
});
test('readback mismatch never marks successful sync and blocks deletion',async()=>{
  const h=harness();await h.run([h.note('A/old.md')]);h.client.updateDoc=async()=>{};
  const r=await h.run([h.note('A/new.md','new text')]);assert.equal(r.errors.length,1);assert.equal(r.deletionBlocked,true);assert.ok(h.state.notes['A/old.md']);assert.equal(h.state.notes['A/new.md'].hash,null);
});
test('missing local mapped note deletes only its paired remote doc',async()=>{
  const h=harness();await h.run([h.note('A/a.md')]);const book=h.state.books.A;await h.client.createDoc(book,'unrelated','manual','manual body');
  const r=await h.run([]);assert.equal(r.deleted,1);assert.equal(h.docs.size,1);assert.equal([...h.docs.values()][0].slug,'manual');
});
test('local vault change blocks all planned deletion',async()=>{
  const h=harness();await h.run([h.note('A/a.md')]);const r=await h.run([],{canDelete:async()=>false});assert.equal(r.deletionBlocked,true);assert.equal(h.docs.size,1);
});
test('local changes after the first deletion stop remaining deletions',async()=>{
  const h=harness();await h.run([h.note('A/a.md'),h.note('A/b.md')]);let changed=false;const original=h.client.deleteDoc;
  h.client.deleteDoc=async(...args)=>{await original(...args);changed=true;};
  const r=await h.run([],{canDelete:async()=>!changed});assert.equal(r.deleted,1);assert.equal(r.deletionBlocked,true);assert.equal(h.docs.size,1);assert.ok(h.state.notes['A/b.md']);
});
test('an ambiguous creation outcome recovers by persisted slug without duplicates',async()=>{
  const h=harness();const original=h.client.createDoc;let fail=true;
  h.client.createDoc=async(...args)=>{const d=await original(...args);if(fail){fail=false;throw Error('response lost');}return d;};
  const first=await h.run([h.note('A/a.md')]);assert.equal(first.errors.length,1);assert.equal(h.docs.size,1);assert.ok(h.state.pendingDocs['A/a.md']);
  const second=await h.run([h.note('A/a.md')]);assert.equal(second.errors.length,0);assert.equal(h.docs.size,1);assert.equal(Object.keys(h.state.pendingDocs).length,0);
});
test('a failed journal save prevents any remote creation',async()=>{
  const h=harness();await assert.rejects(h.run([h.note('A/a.md')],{saveState:async()=>{throw Error('disk full');}}),/无法保存/);assert.deepEqual(h.calls,[]);
});
test('cross-note conversion sees all destination URLs before any final body write',async()=>{
  const h=harness();let checked=false;
  await h.run([h.note('A/a.md'),h.note('A/b.md')],{convert:async(_n,s)=>{assert.ok(s.notes['A/a.md'].url);assert.ok(s.notes['A/b.md'].url);checked=true;return {markdown:'linked',warnings:[]};}});assert.equal(checked,true);
});
test('deletion acknowledgment is verified before dropping the mapping',async()=>{
  const h=harness();await h.run([h.note('A/a.md')]);h.client.deleteDoc=async()=>{};
  const r=await h.run([]);assert.equal(r.errors.length,1);assert.equal(r.deleted,0);assert.ok(h.state.notes['A/a.md']);
});

test('native Lake uses one conversion per write and verifies the published representation',async()=>{
  const h=harness();let conversions=0;
  h.client.prepareContent=async source=>({format:'lake',body:`<ne-p id="generated-${++conversions}">${source}</ne-p>`,html:'<p>cached HTML</p>'});
  h.client.updateDoc=async(_book,doc,title,prepared)=>{
    Object.assign(h.docs.get(doc.id),{title,type:'Doc',format:'lake',body_asl:prepared.body,body_draft_asl:prepared.body,body:prepared.html});h.calls.push('update');
  };
  const note=h.note('A/a.md','# source Markdown');
  const first=await h.run([note]);assert.equal(first.errors.length,0);assert.equal(conversions,1);
  const record=h.state.notes[note.path];assert.equal(record.bodyHash,digest('<ne-p id="generated-1"># source Markdown</ne-p>'));
  const second=await h.run([note]);assert.equal(second.skipped,1);assert.equal(conversions,1);
  h.docs.get(record.id).body_asl='<ne-p>Remote edit</ne-p>';
  const third=await h.run([note]);assert.equal(third.updated,1);assert.equal(conversions,2);
  assert.equal(h.docs.get(record.id).body_asl,'<ne-p id="generated-2"># source Markdown</ne-p>');
});

test('published Lake mismatch or draft-only content cannot authorize success or deletions',async()=>{
  const h=harness();await h.run([h.note('A/old.md')]);
  h.client.prepareContent=async()=>({format:'lake',body:'<ne-p>Expected</ne-p>',html:'<p>Expected</p>'});
  h.client.updateDoc=async(_book,doc,title,prepared)=>{
    Object.assign(h.docs.get(doc.id),{title,type:'Doc',format:'lake',body_asl:'<ne-p>Different</ne-p>',body_draft_asl:prepared.body});
  };
  const result=await h.run([h.note('A/new.md')]);assert.equal(result.errors.length,1);assert.equal(result.deletionBlocked,true);
  assert.equal(h.state.notes['A/new.md'].hash,null);assert.ok(h.state.notes['A/old.md']);
  assert.throws(()=>docBody({type:'Doc',format:'lake',body_draft_asl:'<ne-p>Expected</ne-p>',body:'Expected'}),/已发布正文/);
  assert.throws(()=>docBody({type:'Sheet',format:'lake',body_asl:'<ne-p>Expected</ne-p>'}),/已发布正文/);
});
