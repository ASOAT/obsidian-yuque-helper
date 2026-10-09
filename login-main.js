'use strict';
// Self-contained local code, compiled in Electron MAIN. No website strings or renderer callbacks.
function installLoginMain(window,session,userAgent) {
  const windows=new Set(),records=[];
  const record=message=>{records.push(message);if(records.length>100)records.shift();};
  const allowed=(value,blank=false)=>{
    if(blank && value==='about:blank')return true;
    try{const u=new URL(value);return u.protocol==='https:' && !u.username && !u.password && (!u.port || u.port==='443') && ['www.yuque.com','yuque.com'].includes(u.hostname);}catch{return false;}
  };
  const label=value=>{try{const u=new URL(value);return u.protocol+(['https:','http:'].includes(u.protocol)&&u.hostname?'//'+u.hostname:'');}catch{return '无法识别的地址';}};
  const preferences={session,nodeIntegration:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true};
  const windowOptions={width:1060,height:780,title:'Obsidian Yuque Helper：请在此登录',show:true,webPreferences:preferences};
  function wire(win) {
    if(windows.has(win))return;
    const wc=win.webContents,config=wc.getLastWebPreferences();
    if(wc.session!==session || config.nodeIntegration!==false || config.contextIsolation!==true || config.sandbox!==true || config.webSecurity===false)throw new Error('登录窗口隔离设置不一致，已停止打开。');
    windows.add(win);win.removeMenu();wc.setUserAgent(userAgent);
    // Replace app routing ONLY on the explicitly owned, isolated login window.
    // Do not modify BrowserWindow listeners, global app hooks, or any Obsidian window.
    let removed=0;
    for(const name of ['will-navigate','will-frame-navigate','will-redirect']){
      removed+=wc.listenerCount(name);wc.removeAllListeners(name);
    }
    record('登录修复 0.1.3：接管插件窗口，替换默认导航处理 '+removed+' 项。');
    const guard=(event,url,_inPlace,isMainFrame)=>{
      const target=event.url || url,frame=event.isMainFrame ?? isMainFrame;
      const permitted=frame===false ? (target==='about:blank' || /^https:\/\//i.test(target)) : allowed(target,true);
      if(!permitted){event.preventDefault();record('已阻止登录窗口外部跳转：'+label(target));}
      else if(frame!==false)record('登录窗口允许导航：'+label(target));
    };
    wc.on('will-navigate',guard);wc.on('will-frame-navigate',guard);wc.on('will-redirect',guard);
    wc.on('did-navigate',(_event,url)=>record('登录窗口已进入：'+label(url)));
    wc.on('did-finish-load',()=>record('登录窗口页面加载完成。'));
    wc.on('did-fail-load',(_event,code,_description,_url,isMainFrame)=>{
      if(isMainFrame!==false && code!==-3)record('登录页面加载失败，错误编号：'+Number(code));
    });
    wc.setWindowOpenHandler(({url})=>{
      if(!allowed(url,true)){record('已阻止登录窗口外部弹窗：'+label(url));return {action:'deny'};}
      record('保留同一登录会话的语雀弹窗：'+label(url));
      return {action:'allow',outlivesOpener:false,overrideBrowserWindowOptions:windowOptions};
    });
    wc.on('did-create-window',child=>wire(child));
    win.on('closed',()=>windows.delete(win));
  }
  wire(window);
  session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  session.setPermissionCheckHandler(()=>false);
  const denyDownload=event=>event.preventDefault();session.on('will-download',denyDownload);
  return {
    drainLogs:()=>records.splice(0),hasWindows:()=>windows.size>0,
    focus:()=>{const live=[...windows].reverse().find(w=>!w.isDestroyed());if(!live)return false;live.show();live.focus();return true;},
    close:()=>{
      for(const win of [...windows])if(!win.isDestroyed())win.destroy();
      session.removeListener('will-download',denyDownload);
      session.setPermissionRequestHandler(null);session.setPermissionCheckHandler(null);
    }
  };
}
module.exports={installLoginMain};
