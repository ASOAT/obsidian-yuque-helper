'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const {normalBrowserAgent,allowedUrl,locationLabel,createLoginController,LOGIN_URL}=require('../login');
const vm=require('node:vm');
function fixture() {
  const order=[],instances=[],logs=[];
  const session=new EventEmitter();
  session.getUserAgent=()=> 'Mozilla/5.0 Chrome/130.0.0.0 Electron/32.1.0 Safari/537.36 obsidian/1.8.10';
  session.setUserAgent=ua=>{session.ua=ua;order.push('session-UA');};
  session.setPermissionRequestHandler=()=>{};session.setPermissionCheckHandler=()=>{};
  class Window extends EventEmitter {
    constructor(options){super();order.push('window');this.options=options;this.webContents=new EventEmitter();this.webContents.session=options.webPreferences.session;this.webContents.getLastWebPreferences=()=>options.webPreferences;this.webContents.setUserAgent=ua=>{this.ua=ua;order.push('window-UA');};this.webContents.setWindowOpenHandler=fn=>{this.openHandler=fn;};this.closed=false;instances.push(this);}
    removeMenu(){}show(){this.shown=true;}focus(){this.focused=true;}isDestroyed(){return this.closed;}close(){this.closed=true;this.emit('closed');}destroy(){this.close();}async loadURL(url){this.url=url;order.push('load');}
  }
  const remote={require:id=>{assert.equal(id,'vm');return {runInThisContext:(source,options)=>{order.push('main-install');return vm.runInThisContext(source,options);}};}};
  const controller=createLoginController({remote,BrowserWindow:Window,session,log:x=>logs.push(x)});logs.length=0;
  return {controller,Window,session,instances,order,logs};
}
test('browser identification removes app tokens and preserves actual Chromium version',()=>{
  assert.equal(normalBrowserAgent('Mozilla/5.0 Chrome/130.0 Electron/32.0 Safari/537.36 Obsidian/1.9.0'),'Mozilla/5.0 Chrome/130.0 Safari/537.36');
});
test('session and window browser identifiers are both set before page loading',async()=>{
  const h=fixture();await h.controller.load();assert.deepEqual(h.order,['session-UA','window','main-install','window-UA','load']);assert.equal(h.session.ua,h.controller.window.ua);assert.equal(h.controller.window.url,'https://www.yuque.com/login');
});
test('login popups preserve opener semantics and share the same temporary session',()=>{
  const h=fixture();const result=h.controller.window.openHandler({url:'https://www.yuque.com/login/callback?token=secret'});
  assert.equal(result.action,'allow');assert.equal(result.overrideBrowserWindowOptions.webPreferences.session,h.session);assert.equal(result.overrideBrowserWindowOptions.webPreferences.nodeIntegration,false);assert.equal(result.overrideBrowserWindowOptions.webPreferences.sandbox,true);assert.equal(h.controller.window.url,undefined);
});
test('initial about:blank popup is allowed but foreign destinations and native schemes are blocked',()=>{
  const h=fixture();assert.equal(h.controller.window.openHandler({url:'about:blank'}).action,'allow');
  for(const url of ['https://www.yuque.com.evil.test/','https://evil.test/?token=secret','yuque://login?token=secret','file:///secret','https://user:password@www.yuque.com/']) assert.equal(h.controller.window.openHandler({url}).action,'deny');
  h.controller.drainLogs();
  assert.equal(h.logs.some(x=>x.includes('secret')||x.includes('password')),false);
});
test('server redirects are guarded without logging their query or fragment',()=>{
  const h=fixture();let blocked=false;h.controller.window.webContents.emit('will-redirect',{preventDefault:()=>{blocked=true;}},'yuque://callback?access_token=secret#secret');h.controller.drainLogs();assert.equal(blocked,true);assert.equal(h.logs.at(-1),'已阻止登录窗口外部跳转：yuque:');
});
test('child windows get the same guards and are closed with the plugin',()=>{
  const h=fixture();const child=new h.Window(h.controller.window.openHandler({url:'https://www.yuque.com/login'}).overrideBrowserWindowOptions);h.controller.window.webContents.emit('did-create-window',child);
  let blocked=false;child.webContents.emit('will-navigate',{preventDefault:()=>{blocked=true;}},'https://evil.test');assert.equal(blocked,true);assert.equal(child.ua,h.session.ua);assert.equal(h.controller.focus(),true);assert.equal(child.focused,true);h.controller.close();assert.equal(child.closed,true);assert.equal(h.controller.window.closed,true);
});
test('an ordinary aborted navigation is not reported as credential failure',()=>{
  const h=fixture();h.controller.window.webContents.emit('did-fail-load',{},-3,'ERR_ABORTED','https://www.yuque.com/login?token=secret',true);h.controller.drainLogs();assert.deepEqual(h.logs,[]);
  h.controller.window.webContents.emit('did-fail-load',{},-105,'ERR_NAME_NOT_RESOLVED','https://www.yuque.com/login?token=secret',true);h.controller.drainLogs();assert.equal(h.logs.at(-1),'登录页面加载失败，错误编号：-105');
});
test('diagnostics use protocol and domain only, and HTTPS host matching is exact',()=>{
  assert.equal(locationLabel('https://www.yuque.com/private-secret?token=secret#secret'),'https://www.yuque.com');assert.equal(allowedUrl('https://www.yuque.com:123/'),false);assert.equal(allowedUrl('https://www.yuque.com/login'),true);
});
