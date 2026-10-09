'use strict';
const {installLoginMain}=require('./login-main');
const LOGIN_URL='https://www.yuque.com/login';
function normalBrowserAgent(value) {
  return String(value).replace(/\b(?:obsidian|Electron)\/[^\s]+/gi,'').replace(/\s{2,}/g,' ').trim();
}
function allowedUrl(value,blank=false) {
  if(blank && value==='about:blank') return true;
  try {const url=new URL(value);return url.protocol==='https:' && !url.username && !url.password && (!url.port || url.port==='443') && ['www.yuque.com','yuque.com'].includes(url.hostname);}catch{return false;}
}
function locationLabel(value) {
  // Login URLs often contain secrets. Diagnostics intentionally include NO path, query, or fragment.
  try {const url=new URL(value);return url.protocol+(['https:','http:'].includes(url.protocol) && url.hostname?'//'+url.hostname:'');}catch{return '无法识别的地址';}
}
function createLoginController({remote,BrowserWindow,session,log=()=>{},onBlocked=()=>{},onClosed=()=>{}}) {
  if(!remote?.require)throw new Error('无法在当前 Obsidian 中建立独立登录处理，请更新桌面版。');
  const userAgent=normalBrowserAgent(session.getUserAgent());session.setUserAgent(userAgent);
  const window=new BrowserWindow({width:1060,height:780,title:'Obsidian Yuque Helper：请在此登录',show:true,webPreferences:{session,nodeIntegration:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  let main;
  try{
    const install=remote.require('vm').runInThisContext('('+installLoginMain.toString()+')',{filename:'notebox-yuque-login-main.js'});
    main=install(window,session,userAgent);
  }catch(error){if(!window.isDestroyed())window.destroy();throw error;}
  let timer,closed=false,lastBlocked=0;
  const drain=()=>{
    try{
      const lines=main.drainLogs();
      for(const line of lines){log(line);if(line.startsWith('已阻止') && Date.now()-lastBlocked>3000){lastBlocked=Date.now();onBlocked();}}
      if(!main.hasWindows() && !closed){closed=true;clearInterval(timer);onClosed();}
      return lines;
    }catch{return [];}
  };
  drain();timer=setInterval(drain,350);timer.unref?.();
  return {window,userAgent,load:()=>window.loadURL(LOGIN_URL),focus:()=>main.focus(),drainLogs:drain,
    close:()=>{clearInterval(timer);main.close();drain();}};
}
module.exports={LOGIN_URL,normalBrowserAgent,allowedUrl,locationLabel,createLoginController};
