'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');
const native=Module._load;
class Plugin {registerEvent(){}addStatusBarItem(){return {setText(){}};}addSettingTab(){}addRibbonIcon(){}addCommand(c){this.commands.push(c);}async loadData(){return this.saved;}async saveData(d){this.saved=JSON.parse(JSON.stringify(d));}}
class TFile {constructor(path){this.path=path;this.name=path.split('/').pop();this.basename=this.name.replace(/\.md$/,'');this.extension=this.name.split('.').pop();}}
class TFolder {constructor(name){this.name=name;this.path=name;}}
const notices=[];
class Notice {constructor(message){notices.push(message);}}
Module._load=function(id,...args){if(id==='obsidian')return {Plugin,PluginSettingTab:class{},Setting:class{},Modal:class{},Notice,TFile,TFolder,Platform:{isDesktopApp:true},normalizePath:x=>x.replace(/\\/g,'/')};return native.call(this,id,...args);};
const PluginClass=require('../entry');const BundledClass=require('../main');Module._load=native;
test('plugin starts without uploading or selecting actual notes',async()=>{
  const p=new PluginClass();p.commands=[];p.app={vault:{on:()=>({})}};await p.onload();assert.deepEqual(p.data.settings.selectedFolders,[]);assert.equal(p.client,undefined);assert.equal(p.commands.length,5);
});
test('distributed single-file plugin loads through native external dependencies',async()=>{
  const p=new BundledClass();p.commands=[];p.app={vault:{on:()=>({})}};await p.onload();assert.equal(p.commands.length,5);assert.deepEqual(p.data.settings.selectedFolders,[]);
});
test('real note sync is blocked before the isolated self-test passes',async()=>{
  const p=new PluginClass();p.busy=false;p.data={testRun:{completed:false}};p.requireClient=()=>{throw Error('must not run');};await p.runSync();assert.equal(p.busy,false);
});
test('corrupt data is rejected rather than resetting tracked mappings',async()=>{
  const p=new PluginClass();p.saved={schema:100,state:{notes:{x:{id:1}}}};await assert.rejects(p.onload(),/无法识别/);assert.equal(p.saved.state.notes.x.id,1);
});
test('only immediate folders are selectable and login navigation excludes other hosts',()=>{
  const {listFirstFolders,safeYuqueUrl}=PluginClass._test;
  assert.deepEqual(listFirstFolders({getRoot:()=>({children:[new TFolder('01Notes'),new TFile('Home.md'),new TFolder('.obsidian')]})}),['01Notes']);
  assert.equal(safeYuqueUrl('https://www.yuque.com/login'),true);assert.equal(safeYuqueUrl('https://www.yuque.com.evil.test/login'),false);assert.equal(safeYuqueUrl('file:///secret'),false);
});
function adapter(source) {
  const p=new PluginClass();p.localEpoch=0;p.data={settings:{selectedFolders:['A']},state:{notes:{}}};
  const note=new TFile('A/note.md');const image=new TFile('assets/pic%20name.png');let bytes=Buffer.from('first');
  p.app={vault:{getRoot:()=>({children:[new TFolder('A')]}),getMarkdownFiles:()=>[note],read:async()=>source,readBinary:async()=>bytes,getAbstractFileByPath:path=>path===image.path?image:path===note.path?note:null},metadataCache:{getFirstLinkpathDest:()=>null}};
  return {p,note,image,setBytes:x=>{bytes=Buffer.from(x);}};
}
test('reference image byte changes affect sync hash without metadata cache',async()=>{
  const h=adapter('![image][ref]\n[ref]: ../assets/pic%2520name.png');const first=await h.p.scan();const a=await first.notes[0].calculateHash(h.p.data.state);
  h.setBytes('second');const second=await h.p.scan();assert.notEqual(await second.notes[0].calculateHash(h.p.data.state),a);
});
test('literal percent sequences in wikilinks are not decoded again',async()=>{
  const h=adapter('![[assets/pic%20name.png]]');const scan=await h.p.scan();assert.equal(scan.notes.length,1);assert.equal(h.p.resolveFile('assets/pic%20name.png','A/note.md'),h.image);
});
test('changing vault content during a scan rejects the unstable snapshot',async()=>{
  const h=adapter('plain');h.p.app.vault.read=async()=>{h.p.localEpoch++;return 'changed';};await assert.rejects(h.p.scan(),/扫描期间/);
});
test('relative link resolution remains within the vault',()=>{
  const h=adapter('plain');assert.equal(h.p.resolveFile('../assets/pic%20name.png','A/note.md'),h.image);assert.equal(h.p.resolveFile('../../outside.png','A/note.md'),null);
});
test('mixed folders scan only selected Markdown notes and never read non-note files',async()=>{
  const p=new PluginClass();p.localEpoch=0;p.data={settings:{selectedFolders:['A']},state:{notes:{}}};
  const files=['A/note.md','A/sub/nested.md','A/report.pdf','A/picture.png','A/scratch.txt','A/map.canvas','B/not-selected.md','Home.md'].map(path=>new TFile(path));
  const reads=[],binaryReads=[];
  p.app={vault:{
    getRoot:()=>({children:[new TFolder('A'),new TFolder('B'),new TFile('Home.md')]}),
    // Deliberately return a mixed list to verify the adapter's extra extension guard.
    getMarkdownFiles:()=>files,
    read:async file=>{reads.push(file.path);assert.ok(file.path==='A/note.md' || file.path==='A/sub/nested.md');return 'plain Markdown';},
    readBinary:async file=>{binaryReads.push(file.path);throw Error('unreferenced images must not be read');},
    getAbstractFileByPath:()=>null,
  },metadataCache:{getFirstLinkpathDest:()=>null}};
  const scan=await p.scan();
  assert.deepEqual(scan.notes.map(note=>note.path),['A/note.md','A/sub/nested.md']);
  assert.deepEqual(reads,['A/note.md','A/sub/nested.md']);
  assert.deepEqual(binaryReads,[]);
});

const VAULT_ID='11111111-1111-4111-8111-111111111111';
function sessionFixture() {
  const calls={clear:0,flushStorage:0,flushCookies:0};
  return {calls,
    clearStorageData:async()=>{calls.clear++;},
    flushStorageData:()=>{calls.flushStorage++;},
    cookies:{flushStore:async()=>{calls.flushCookies++;}},
  };
}
function loginPlugin(rememberLogin=true) {
  const p=new PluginClass();p.logs=[];p.busy=false;p.unloaded=false;p.sessionEpoch=0;
  p.data={schema:1,vaultId:VAULT_ID,accountId:'1',accountLogin:'test-user',settings:{account:'test-user',selectedFolders:[],rememberLogin},
    state:{books:{A:{id:11}},notes:{'A/note.md':{id:12,folder:'A',hash:'stable'}}}};
  p.status={setText(){}};
  return p;
}
test('lazy remembered session uses one stable isolated partition and rejects unsafe vault identifiers',async()=>{
  const p=loginPlugin();const session=sessionFixture();const partitions=[];
  let userAgent;session.getUserAgent=()=> 'Mozilla/5.0 Chrome/130.0 Electron/32.0 obsidian/1.14';session.setUserAgent=value=>{userAgent=value;};
  p.electronRemote=()=>({session:{fromPartition:(partition)=>{partitions.push(partition);return session;}}});
  assert.equal(await p.ensureSession(),session);assert.equal(await p.ensureSession(),session);
  assert.deepEqual(partitions,['persist:obsidian-yuque-helper-'+VAULT_ID]);
  assert.equal(userAgent,'Mozilla/5.0 Chrome/130.0');
  assert.equal(p.loginController,undefined);
  const unsafe=loginPlugin();unsafe.data.vaultId='../../another-profile';unsafe.electronRemote=()=>{throw Error('must not allocate');};
  await assert.rejects(unsafe.ensureSession(),/标识无效/);
});
test('disabling remembered login allocates a different ephemeral partition per session',async()=>{
  const partitions=[];
  for(let i=0;i<2;i++) {
    const p=loginPlugin(false);p.electronRemote=()=>({session:{fromPartition:partition=>{partitions.push(partition);return sessionFixture();}}});
    await p.ensureSession();assert.equal(p.sessionRemembered,false);
  }
  assert.equal(partitions.every(value=>value.startsWith('obsidian-yuque-helper-') && !value.startsWith('persist:')),true);
  assert.notEqual(partitions[0],partitions[1]);
});
test('unload flushes remembered login instead of clearing it and closes owned windows and requests',async()=>{
  const p=loginPlugin();const session=sessionFixture();p.yuqueSession=session;p.sessionRemembered=true;
  let requestsClosed=0,windowsClosed=0;p.requestBridge={close:()=>requestsClosed++};p.loginController={close:()=>windowsClosed++};p.client={};
  const before=JSON.stringify(p.data.state);await p.onunload();
  assert.deepEqual(session.calls,{clear:0,flushStorage:1,flushCookies:1});
  assert.equal(requestsClosed,1);assert.equal(windowsClosed,1);assert.equal(p.client,null);assert.equal(p.unloaded,true);
  assert.equal(JSON.stringify(p.data.state),before);
});
test('turning off remember-login clears the current session on unload',async()=>{
  const p=loginPlugin(false);const session=sessionFixture();p.yuqueSession=session;p.sessionRemembered=true;
  await p.onunload();assert.deepEqual(session.calls,{clear:1,flushStorage:0,flushCookies:0});
});
test('explicit logout clears only the owned session and preserves account binding and document mappings',async()=>{
  const p=loginPlugin();const own=sessionFixture(),unrelated=sessionFixture();p.yuqueSession=own;p.sessionRemembered=true;
  let requestsClosed=0,windowsClosed=0;p.requestBridge={close:()=>requestsClosed++};p.loginController={close:()=>windowsClosed++};p.client={};
  const before=JSON.stringify(p.data);await p.logout();
  assert.equal(own.calls.clear,1);assert.equal(unrelated.calls.clear,0);
  assert.equal(requestsClosed,1);assert.equal(windowsClosed,1);assert.equal(p.client,null);assert.equal(p.yuqueSession,null);
  assert.equal(p.requestBridge,null);assert.equal(p.loginController,null);assert.equal(p.busy,false);
  assert.equal(JSON.stringify(p.data),before);
});
test('logout cannot clear credentials in the middle of sync or self-test writes',async()=>{
  const p=loginPlugin();const own=sessionFixture();p.yuqueSession=own;p.busy=true;
  await p.logout();assert.equal(own.calls.clear,0);assert.equal(p.yuqueSession,own);assert.equal(p.busy,true);
});
test('startup repairs unsafe vault identifiers without discarding paired records',async()=>{
  const p=loginPlugin(false);p.saved=JSON.parse(JSON.stringify(p.data));p.saved.vaultId='../unsafe';p.commands=[];p.app={vault:{on:()=>({})}};
  await p.onload();assert.match(p.saved.vaultId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(p.saved.state.notes['A/note.md'].id,12);
});
test('startup silently restores only a previously bound account with remembered login',async()=>{
  const p=loginPlugin();p.saved=JSON.parse(JSON.stringify(p.data));p.commands=[];p.app={vault:{on:()=>({})}};
  let restored=0;p.requireClient=async()=>{restored++;p.client={};};const noticeCount=notices.length;
  await p.onload();await p.restorePromise;assert.equal(restored,1);assert.equal(notices.length,noticeCount);
  const disabled=loginPlugin(false);disabled.saved=JSON.parse(JSON.stringify(disabled.data));disabled.commands=[];disabled.app={vault:{on:()=>({})}};
  disabled.requireClient=async()=>{throw Error('must not restore');};await disabled.onload();assert.equal(disabled.restorePromise,undefined);
});
test('checking a remembered session works without opening a login window and still enforces account identity',async()=>{
  const p=loginPlugin();const session=sessionFixture();let partitions=0;
  p.electronRemote=()=>({session:{fromPartition:()=>{partitions++;return session;}}});
  p.requestBridge={request:async()=>({status:200,text:JSON.stringify({data:{id:1,login:'test-user'}})})};
  await p.requireClient();assert.equal(partitions,1);assert.equal(p.loginController,undefined);assert.ok(p.client);
  p.requestBridge={request:async()=>({status:200,text:JSON.stringify({data:{id:2,login:'test-user'}})})};
  await assert.rejects(p.requireClient(),/账号.*不一致/);assert.equal(p.data.accountId,'1');
});
test('a login check finishing after unload cannot restore a client or show a notification',async()=>{
  const p=loginPlugin();p.yuqueSession=sessionFixture();p.sessionRemembered=true;let resolveRequest;
  p.requestBridge={request:()=>new Promise(resolve=>{resolveRequest=resolve;}),close(){}};
  const check=p.requireClient();const rejected=assert.rejects(check,/会话已结束/);
  await Promise.resolve();await Promise.resolve();assert.equal(typeof resolveRequest,'function');
  const noticeCount=notices.length;await p.onunload();
  resolveRequest({status:200,text:JSON.stringify({data:{id:1,login:'test-user'}})});await rejected;
  assert.equal(p.client,null);assert.equal(notices.length,noticeCount);
});
test('repeated login clicks share one opening attempt and an unload cancels the pending window creation',async()=>{
  const p=loginPlugin();let release,attempts=0;p.electronRemote=()=>({});
  p.ensureSession=()=>{attempts++;return new Promise(resolve=>{release=resolve;});};
  const first=p.login();await p.login();assert.equal(attempts,1);
  const noticeCount=notices.length;await p.onunload();release(sessionFixture());await first;
  assert.equal(p.loginController,null);assert.equal(p.openingLogin,false);assert.equal(notices.length,noticeCount);
});
function rememberFixture(cookies) {
  const p=loginPlugin();p.sessionRemembered=true;
  const written=[],getCalls=[];let flushed=0;
  const session={cookies:{get:async options=>{getCalls.push(options);return cookies;},set:async details=>{written.push(details);},flushStore:async()=>{flushed++;}}};
  p.yuqueSession=session;
  const current=()=>!p.unloaded && p.sessionEpoch===0 && p.yuqueSession===session;
  return {p,session,written,getCalls,current,flushed:()=>flushed};
}
test('remembered session cookies retain host-only scope and security flags with a bounded 30-day expiry',async()=>{
  const h=rememberFixture([
    {name:'host-cookie',value:'SECRET_HOST_COOKIE',session:true,hostOnly:true,domain:'www.yuque.com',path:'/private',secure:true,httpOnly:true,sameSite:'strict'},
    {name:'domain-cookie',value:'SECRET_DOMAIN_COOKIE',session:true,hostOnly:false,domain:'.yuque.com',path:'/',secure:true,httpOnly:false,sameSite:'no_restriction'},
  ]);
  const before=Math.floor(Date.now()/1000);await h.p.rememberVerifiedLogin(h.session,h.current);const after=Math.floor(Date.now()/1000);
  assert.deepEqual(h.getCalls,[{url:'https://www.yuque.com'}]);assert.equal(h.written.length,2);
  const [host,domain]=h.written;assert.equal(Object.hasOwn(host,'domain'),false);assert.equal(host.path,'/private');
  assert.equal(host.secure,true);assert.equal(host.httpOnly,true);assert.equal(host.sameSite,'strict');assert.equal(host.value,'SECRET_HOST_COOKIE');
  assert.equal(domain.domain,'.yuque.com');assert.equal(domain.sameSite,'no_restriction');assert.equal(domain.httpOnly,false);
  for(const cookie of h.written){assert.equal(cookie.url,'https://www.yuque.com');assert.ok(cookie.expirationDate>=before+30*86400 && cookie.expirationDate<=after+30*86400);}
  assert.equal(h.flushed(),1);assert.equal(JSON.stringify(h.p.data).includes('SECRET_'),false);assert.equal(JSON.stringify(h.p.logs).includes('SECRET_'),false);
});
test('persistent cookies including expired cookies are not extended and foreign scopes are ignored',async()=>{
  const h=rememberFixture([
    {name:'persistent',value:'unchanged',session:false,hostOnly:true,domain:'www.yuque.com',expirationDate:4102444800},
    {name:'expired',value:'expired',session:false,hostOnly:true,domain:'www.yuque.com',expirationDate:1},
    {name:'foreign',value:'foreign',session:true,hostOnly:false,domain:'.example.com'},
    {name:'subdomain',value:'foreign-subdomain',session:true,hostOnly:false,domain:'.evil.yuque.com'},
  ]);
  await h.p.rememberVerifiedLogin(h.session,h.current);assert.deepEqual(h.written,[]);assert.equal(h.flushed(),0);
});
test('disabled remember-login does not read or rewrite cookies',async()=>{
  const h=rememberFixture([{name:'session-cookie',value:'private',session:true,hostOnly:true,domain:'www.yuque.com'}]);h.p.data.settings.rememberLogin=false;
  await h.p.rememberVerifiedLogin(h.session,h.current);assert.deepEqual(h.getCalls,[]);assert.deepEqual(h.written,[]);
});
test('logout or account-switch epoch changes stop cookie retention before the next set',async()=>{
  const h=rememberFixture([
    {name:'first',value:'private-a',session:true,hostOnly:true,domain:'www.yuque.com'},
    {name:'second',value:'private-b',session:true,hostOnly:true,domain:'www.yuque.com'},
  ]);
  h.session.cookies.set=async details=>{h.written.push(details);h.p.sessionEpoch++;};
  await h.p.rememberVerifiedLogin(h.session,h.current);assert.equal(h.written.length,1);assert.equal(h.flushed(),0);
});
test('cookie get and set failures emit only generic diagnostics and do not fail account validation',async()=>{
  const h=rememberFixture([{name:'session-cookie',value:'SECRET_SESSION_VALUE',session:true,hostOnly:true,domain:'www.yuque.com'}]);
  h.session.cookies.get=async()=>{throw Error('SECRET_GET_VALUE');};await h.p.rememberVerifiedLogin(h.session,h.current);
  assert.ok(h.p.logs.some(line=>line.includes('登录检查已通过，但本机登录保存未完成')));assert.equal(h.p.logs.some(line=>line.includes('SECRET_')),false);
  h.session.cookies.get=async()=>[{name:'session-cookie',value:'SECRET_SESSION_VALUE',session:true,hostOnly:true,domain:'www.yuque.com'}];
  h.session.cookies.set=async()=>{throw Error('SECRET_SET_VALUE');};
  h.p.requestBridge={request:async()=>({status:200,text:JSON.stringify({data:{id:1,login:'test-user'}})})};
  await h.p.requireClient();assert.ok(h.p.client);assert.equal(h.p.logs.some(line=>line.includes('SECRET_')),false);assert.equal(JSON.stringify(h.p.saved).includes('SECRET_'),false);
});
test('account mismatch is rejected before any local cookie-retention writes',async()=>{
  const h=rememberFixture([{name:'session-cookie',value:'private',session:true,hostOnly:true,domain:'www.yuque.com'}]);
  h.p.requestBridge={request:async()=>({status:200,text:JSON.stringify({data:{id:2,login:'test-user'}})})};
  await assert.rejects(h.p.requireClient(),/账号.*不一致/);assert.deepEqual(h.getCalls,[]);assert.deepEqual(h.written,[]);
});
test('logout waits for an already pending cookie set before clearing the owned session',async()=>{
  const h=rememberFixture([{name:'session-cookie',value:'private',session:true,hostOnly:true,domain:'www.yuque.com'}]);
  const order=[];let finishSet;h.session.cookies.set=()=>new Promise(resolve=>{finishSet=()=>{order.push('set-finished');resolve();};});
  h.session.clearStorageData=async()=>{order.push('storage-cleared');};
  const retention=h.p.rememberVerifiedLogin(h.session,h.current);await Promise.resolve();await Promise.resolve();assert.equal(typeof finishSet,'function');
  const logout=h.p.logout();await Promise.resolve();await Promise.resolve();assert.deepEqual(order,[]);
  finishSet();await Promise.all([retention,logout]);assert.deepEqual(order,['set-finished','storage-cleared']);assert.equal(h.p.yuqueSession,null);
});
test('unload with remember disabled clears storage after every pending cookie set settles',async()=>{
  const h=rememberFixture([{name:'session-cookie',value:'private',session:true,hostOnly:true,domain:'www.yuque.com'}]);
  const order=[];let finishSet;h.session.cookies.set=()=>new Promise(resolve=>{finishSet=()=>{order.push('set-finished');resolve();};});
  h.session.clearStorageData=async()=>{order.push('storage-cleared');};
  const retention=h.p.rememberVerifiedLogin(h.session,h.current);await Promise.resolve();await Promise.resolve();assert.equal(typeof finishSet,'function');
  h.p.data.settings.rememberLogin=false;const unloaded=h.p.onunload();await Promise.resolve();await Promise.resolve();assert.deepEqual(order,[]);
  finishSet();await Promise.all([retention,unloaded]);assert.deepEqual(order,['set-finished','storage-cleared']);assert.equal(h.flushed(),0);
});
