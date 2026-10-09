'use strict';
const {installRequestMain}=require('./request-main');

function createRequestBridge({remote,session}) {
  if(!session || !remote?.require || !remote.net?.request) {
    throw new Error('当前 Obsidian 无法建立语雀请求连接，请更新桌面版。');
  }
  try {
    // Only this plugin's trusted, self-contained source is compiled. Never page code.
    const install=remote.require('vm').runInThisContext('('+installRequestMain.toString()+')',
      {filename:'notebox-yuque-request-main.js'});
    const bridge=install(session,remote.net);
    if(typeof bridge?.request!=='function' || typeof bridge.close!=='function') throw new Error('Invalid bridge');
    return bridge;
  } catch (_) {
    throw new Error('无法建立语雀请求连接，请重新启用插件后再试。');
  }
}

module.exports={createRequestBridge};
