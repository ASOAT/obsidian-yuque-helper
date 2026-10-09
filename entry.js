'use strict';
const {Plugin, PluginSettingTab, Setting, Modal, Notice, TFolder, TFile, Platform, normalizePath} = require('obsidian');
const {randomUUID} = require('node:crypto');
const pathApi = require('node:path').posix;
const {YuqueClient} = require('./yuque');
const {convertMarkdown} = require('./markdown');
const {createPlan, renameState} = require('./sync');
const {executeSync, digest, docBody, preparedBody} = require('./engine');
const {createLoginController, normalBrowserAgent} = require('./login');
const {createRequestBridge} = require('./request');
const {renderMarkdownHtml} = require('./html');
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const MIME = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',bmp:'image/bmp'};
const DEFAULTS = {account:'',selectedFolders:[],syncDeletes:true,rememberLogin:true};
const VALID_VAULT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function remoteApi() {
  try { return require('@electron/remote'); }
  catch { const api = require('electron').remote; if (api) return api; }
  throw new Error('当前 Obsidian 无法打开插件登录窗口。请更新桌面版 Obsidian 后重试。');
}
function safeYuqueUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && (u.hostname === 'www.yuque.com' || u.hostname === 'yuque.com'); } catch { return false; }
}
function listFirstFolders(vault) { return vault.getRoot().children.filter(f=>f instanceof TFolder && !f.name.startsWith('.')).map(f=>f.name).sort(); }
function cleanTarget(target) {
  return String(target).replace(/^<|>$/g,'').split('|')[0];
}

class ReportModal extends Modal {
  constructor(plugin,title,lines) { super(plugin.app); this.title=title; this.lines=lines; }
  onOpen() { this.contentEl.createEl('h2',{text:this.title}); const box=this.contentEl.createEl('pre',{cls:'notebox-yuque-report'}); box.setText(this.lines.join('\n')); }
  onClose() { this.contentEl.empty(); }
}
class PreviewModal extends Modal {
  constructor(plugin,scan,plan) { super(plugin.app); this.plugin=plugin; this.scan=scan; this.plan=plan; }
  onOpen() {
    const {contentEl,plan} = this;
    contentEl.createEl('h2',{text:'同步预览'});
    contentEl.createEl('p',{text:`新增 ${plan.counts.create} · 检查更新 ${plan.counts.update + plan.counts.skip} · 删除 ${plan.counts.delete}`});
    contentEl.createEl('p',{text:'Obsidian 为准。删除仅作用于本插件已配对、且所在文件夹仍被选中的语雀文档。取消勾选文件夹会保留远端内容。'});
    const rows = [...plan.upserts.map(x=>`${x.action==='create'?'新增':'更新'}  ${x.note.path}`), ...plan.removes.map(x=>`删除  ${x.path}`)];
    contentEl.createEl('pre',{cls:'notebox-yuque-report',text:rows.join('\n') || '本地内容未变化。仍会检查远端正文是否被修改。'});
    new Setting(contentEl).addButton(b=>b.setButtonText('开始同步').setCta().onClick(()=>{this.close(); this.plugin.runSync();}));
  }
  onClose() { this.contentEl.empty(); }
}

class NoteBoxYuquePlugin extends Plugin {
  async onload() {
    this.unloaded=false;this.sessionEpoch=0;
    if (!Platform.isDesktopApp) { new Notice('Obsidian Yuque Helper 仅支持桌面版。'); return; }
    const saved = await this.loadData();
    if(this.unloaded)return;
    if (saved && (saved.schema !== 1 || !saved.state || !saved.settings)) throw new Error('同步记录格式无法识别，已停止加载以保护配对文档。');
    this.data = saved || {schema:1,vaultId:randomUUID(),settings:{...DEFAULTS},state:{books:{},notes:{},pendingBooks:{},pendingDocs:{},assets:{}}};
    const needsSave=!saved || !VALID_VAULT_ID.test(this.data.vaultId || '') || typeof this.data.settings.rememberLogin!=='boolean';
    if(!VALID_VAULT_ID.test(this.data.vaultId || ''))this.data.vaultId=randomUUID();
    this.data.settings = {...DEFAULTS,...this.data.settings};
    if(typeof this.data.settings.rememberLogin!=='boolean')this.data.settings.rememberLogin=true;
    if(needsSave)await this.save();
    if(this.unloaded)return;
    this.logs=[]; this.busy=false; this.localEpoch=0; this.renameQueue=[];
    this.status=this.addStatusBarItem(); this.status.setText('语雀：未连接');
    this.addSettingTab(new YuqueSettings(this.app,this));
    this.addRibbonIcon('cloud-upload','Obsidian Yuque Helper：同步预览',()=>this.preview());
    this.addCommand({id:'yuque-open-login',name:'打开语雀登录窗口',callback:()=>this.login()});
    this.addCommand({id:'yuque-check-login',name:'检查语雀登录',callback:()=>this.connect()});
    this.addCommand({id:'yuque-sync-preview',name:'预览并手动同步',callback:()=>this.preview()});
    this.addCommand({id:'yuque-connection-test',name:'运行虚构文档连接自检',callback:()=>this.selfTest()});
    this.addCommand({id:'yuque-show-log',name:'查看同步结果',callback:()=>this.showLogs()});
    this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{
      this.localEpoch++;
      if (this.busy) this.renameQueue.push([oldPath,file.path]); else this.applyRename(oldPath,file.path);
    }));
    for (const name of ['create','modify','delete']) this.registerEvent(this.app.vault.on(name,()=>{this.localEpoch++;}));
    this.registerEvent(this.app.vault.on('create',()=>{this.folderRefresh?.();}));
    this.registerEvent(this.app.vault.on('delete',()=>{this.folderRefresh?.();}));
    if(this.data.accountId && this.data.settings.rememberLogin)this.restorePromise=this.restoreLogin();
  }
  async onunload() {
    this.unloaded=true;this.sessionEpoch=(this.sessionEpoch || 0)+1;this.folderRefresh=null;
    const session=this.yuqueSession;
    const remembered=(this.sessionRemembered ?? this.data?.settings?.rememberLogin) && this.data?.settings?.rememberLogin!==false;
    try{this.requestBridge?.close();}catch{}
    try{this.loginController?.close();}catch{}
    this.requestBridge=null;this.loginController=null;this.loginWindow=null;this.yuqueSession=null;this.client=null;
    if(!session)return;
    await Promise.allSettled([...(this.rememberTasks || [])]);
    if(remembered) {
      try{await session.flushStorageData?.();}catch{}
      try{await session.cookies?.flushStore?.();}catch{}
    } else {
      try{await session.clearStorageData();}catch{}
    }
  }
  async save() {
    const snapshot=JSON.parse(JSON.stringify(this.data));
    this.saveQueue=(this.saveQueue || Promise.resolve()).catch(()=>{}).then(()=>this.saveData(snapshot));
    await this.saveQueue;
  }
  log(text) {
    if(this.unloaded)return;
    // Logs contain document paths and outcomes, never cookies, tokens, or request bodies.
    this.logs.push(`${new Date().toLocaleTimeString()}  ${text}`); if(this.logs.length>300) this.logs.shift();
    this.status?.setText(this.busy?'语雀：同步中…':this.client?'语雀：已连接':'语雀：未连接');
  }
  showLogs() { if(this.unloaded)return;this.loginController?.drainLogs();new ReportModal(this,'语雀同步结果',this.logs.length?this.logs:['尚无操作记录。']).open(); }
  fail(error) { if(this.unloaded)return;this.log(error.message || '操作失败。'); new Notice(error.message || '操作失败。',12000); }
  electronRemote() { return remoteApi(); }
  async ensureSession() {
    if(this.unloaded)throw new Error('插件已关闭，操作已停止。');
    if(this.yuqueSession)return this.yuqueSession;
    if(!VALID_VAULT_ID.test(this.data?.vaultId || ''))throw new Error('同步库标识无效，请重新启用插件后再试。');
    const remote=this.electronRemote();
    this.sessionRemembered=this.data.settings.rememberLogin!==false;
    this.partition=this.sessionRemembered
      ? 'persist:obsidian-yuque-helper-'+this.data.vaultId
      : 'obsidian-yuque-helper-'+randomUUID();
    this.yuqueSession=remote.session.fromPartition(this.partition,{cache:false});
    if(this.yuqueSession.getUserAgent && this.yuqueSession.setUserAgent) {
      this.yuqueSession.setUserAgent(normalBrowserAgent(this.yuqueSession.getUserAgent()));
    }
    return this.yuqueSession;
  }
  async restoreLogin() {
    const epoch=this.sessionEpoch;
    try {
      await this.requireClient();
      if(this.unloaded || epoch!==this.sessionEpoch)return;
      this.log(`已恢复语雀登录：${this.data.accountLogin}`);this.folderRefresh?.();
    } catch {
      if(this.unloaded || epoch!==this.sessionEpoch)return;
      this.client=null;this.log('未能自动恢复语雀登录，请在插件窗口重新登录。');
    }
  }
  async rememberVerifiedLogin(session,current) {
    const task=this.persistVerifiedLogin(session,current);
    this.rememberTasks ||= new Set();this.rememberTasks.add(task);
    try{await task;}finally{this.rememberTasks.delete(task);}
  }
  async persistVerifiedLogin(session,current) {
    const enabled=()=>this.data.settings.rememberLogin===true && this.sessionRemembered===true && current();
    if(!enabled())return;
    let cookies,failed=false,written=false;
    try{cookies=await session.cookies.get({url:'https://www.yuque.com'});}
    catch{if(enabled())this.log('登录检查已通过，但本机登录保存未完成，请稍后重新检查登录。');return;}
    if(!Array.isArray(cookies)){if(enabled())this.log('登录检查已通过，但本机登录保存未完成，请稍后重新检查登录。');return;}
    const expirationDate=Math.floor(Date.now()/1000)+30*24*60*60;
    for(const cookie of cookies) {
      if(!enabled())return;
      if(!cookie || cookie.session!==true || cookie.expirationDate!==undefined)continue;
      if(!['www.yuque.com','yuque.com','.yuque.com'].includes(cookie.domain))continue;
      if(cookie.hostOnly && cookie.domain!=='www.yuque.com')continue;
      const details={url:'https://www.yuque.com',name:cookie.name,value:cookie.value,
        path:cookie.path || '/',secure:cookie.secure,httpOnly:cookie.httpOnly,expirationDate};
      if(cookie.sameSite!==undefined)details.sameSite=cookie.sameSite;
      if(!cookie.hostOnly)details.domain=cookie.domain;
      try{await session.cookies.set(details);written=true;}catch{failed=true;}
    }
    if(!enabled())return;
    if(written)try{await session.cookies.flushStore();}catch{failed=true;}
    if(failed && enabled())this.log('登录检查已通过，但本机登录保存未完成，请稍后重新检查登录。');
  }
  async logout() {
    if(this.unloaded)return;
    if(this.busy)return new Notice('请等待当前操作完成后再退出登录。');
    this.busy=true;
    try {
      const session=await this.ensureSession();
      if(this.unloaded)return;
      this.sessionEpoch=(this.sessionEpoch || 0)+1;
      this.requestBridge?.close();this.loginController?.close();
      this.requestBridge=null;this.loginController=null;this.loginWindow=null;this.client=null;
      await Promise.allSettled([...(this.rememberTasks || [])]);
      await session.clearStorageData();
      if(this.unloaded)return;
      this.yuqueSession=null;this.partition=null;this.sessionRemembered=null;
      this.log('已退出语雀登录；知识库和文档配对记录已保留。');
      new Notice('已退出语雀登录。');
    } catch(error) {this.fail(error);}
    finally {this.busy=false;if(!this.unloaded){this.status?.setText(this.client?'语雀：已连接':'语雀：未连接');this.folderRefresh?.();}}
  }
  async login() {
    if(this.unloaded)return;
    if (this.busy) return new Notice('请等待当前操作完成。');
    if(this.openingLogin)return;
    this.openingLogin=true;const epoch=this.sessionEpoch;
    try {
      if (this.loginController?.focus()) return;
      this.loginController?.close();
      const remote=this.electronRemote();
      await this.ensureSession();
      if(this.unloaded || epoch!==this.sessionEpoch)return;
      this.loginController=createLoginController({remote,BrowserWindow:remote.BrowserWindow,session:this.yuqueSession,
        log:message=>this.log(message),onBlocked:()=>{if(!this.unloaded && epoch===this.sessionEpoch)new Notice('语雀尝试跳转到外部应用或其他网站。请留在插件窗口，选择语雀提供的其他登录方式；跳转记录可在“查看结果”中查看。',12000);}});
      this.loginWindow=this.loginController.window;
      await this.loginController.load();
      if(this.unloaded || epoch!==this.sessionEpoch)return;
      new Notice('在新窗口正常登录语雀，完成后回到插件点击“检查登录”。');
    } catch(error) { if(!this.unloaded && epoch===this.sessionEpoch)this.fail(error); }
    finally {this.openingLogin=false;}
  }
  async requireClient() {
    const epoch=this.sessionEpoch;
    const expectedLogin=this.data.settings.account.trim();
    const session=await this.ensureSession();
    const current=()=>!this.unloaded && epoch===this.sessionEpoch && session===this.yuqueSession && expectedLogin===this.data.settings.account.trim();
    if(!current())throw new Error('登录会话已结束，操作已停止。');
    if(!this.requestBridge) {
      this.requestBridge=createRequestBridge({remote:this.electronRemote(),session});
      this.log('请求修复 0.1.4：完整响应在主进程接收。');
    }
    const client=new YuqueClient({session,bridge:this.requestBridge,htmlRenderer:renderMarkdownHtml,logger:message=>this.log(message)});
    const me=await client.initialize(expectedLogin);
    if(!current())throw new Error('登录会话已结束，操作已停止。');
    if(this.data.accountId && String(this.data.accountId)!==String(me.id)) throw new Error('当前语雀账号与已有同步记录不一致，已停止操作。');
    await this.rememberVerifiedLogin(session,current);
    if(!current())throw new Error('登录会话已结束，操作已停止。');
    this.data.accountId=String(me.id); this.data.accountLogin=me.login; await this.save();
    if(!current())throw new Error('登录会话已结束，操作已停止。');
    this.client=client;
    return client;
  }
  async connect() {
    if(this.busy) return new Notice('请等待当前操作完成。');
    try { await this.requireClient(); if(this.unloaded)return;this.log(`已连接：${this.data.accountLogin}`); new Notice('语雀登录检查通过。可以先运行“连接自检”。'); this.folderRefresh?.(); }
    catch(error) {this.client=null;this.fail(error);}
  }
  resolveFile(target,sourcePath) {
    const value=cleanTarget(target); if(!value) return this.app.vault.getAbstractFileByPath(sourcePath);
    const resolved=this.app.metadataCache.getFirstLinkpathDest(value,sourcePath);
    if(resolved) return resolved;
    const candidate=/^\.{1,2}\//.test(value) ? pathApi.normalize(pathApi.join(pathApi.dirname(sourcePath),value)) : value.replace(/^\/+/, '');
    if(candidate==='..' || candidate.startsWith('../')) return null;
    return this.app.vault.getAbstractFileByPath(normalizePath(candidate));
  }
  async scan() {
    const epoch=this.localEpoch;
    const available=listFirstFolders(this.app.vault); const folders=[...new Set(this.data.settings.selectedFolders)].sort();
    if(!folders.length) throw new Error('请先在插件设置中勾选至少一个一级文件夹。');
    if(folders.some(f=>!available.includes(f))) throw new Error('已选择的文件夹不在库中，请重新检查选择；本轮不会删除远端文档。');
    const files=this.app.vault.getMarkdownFiles().filter(f=>String(f.extension).toLowerCase()==='md' && folders.includes(f.path.split('/')[0])).sort((a,b)=>a.path.localeCompare(b.path));
    const notes=[];
    for (const file of files) {
      const source=await this.app.vault.read(file);
      const depMap=new Map();
      // Use the same parser as rendering; this pass resolves dependencies but never uploads.
      await convertMarkdown(source,{sourcePath:file.path,
        resolveLink:ref=>{
          const target=this.resolveFile(ref,file.path);
          const key=target?.path || cleanTarget(ref);
          depMap.set(key,{path:key,isNote:target instanceof TFile && target.extension==='md'});
          return {url:'https://notebox.invalid/dependency'};
        },
        resolveImage:async ref=>{
          const target=this.resolveFile(ref,file.path);
          if(!(target instanceof TFile)) {
            if(IMAGE.test(cleanTarget(ref))) throw new Error(`找不到本地图片：${ref}`);
            return null;
          }
          if(!IMAGE.test(target.path)) return null;
          const bytes=Buffer.from(await this.app.vault.readBinary(target));
          if(bytes.length>20*1024*1024) throw new Error(`图片超过试用版 20MB 限制：${target.path}`);
          depMap.set(target.path,{path:target.path,imageHash:digest(bytes)});
          return {url:'https://notebox.invalid/image'};
        }
      });
      const deps=[...depMap.values()].sort((a,b)=>a.path.localeCompare(b.path));
      notes.push({path:file.path,folder:file.path.split('/')[0],title:file.basename,source,
        calculateHash:async state=>digest(source + '\n' + JSON.stringify(deps.map(d=>({...d,url:d.isNote?state.notes[d.path]?.url || '':undefined}))))});
    }
    if(epoch!==this.localEpoch || JSON.stringify(folders)!==JSON.stringify([...this.data.settings.selectedFolders].sort())) throw new Error('扫描期间本地内容或选择发生变化，请稍后重新预览。');
    return {folders,available,notes,epoch};
  }
  async preview() {
    if(this.busy) return new Notice('请等待当前操作完成。');
    try {
      const scan=await this.scan(); const notes=[];
      for(const note of scan.notes) notes.push({...note,contentHash:await note.calculateHash(this.data.state)});
      const plan=createPlan({selectedFolders:scan.folders,availableFolders:scan.available,scanCompleteFolders:scan.folders,notes,state:this.data.state,allowDeletes:this.data.settings.syncDeletes});
      new PreviewModal(this,scan,plan).open();
    } catch(error) {this.fail(error);}
  }
  async convert(note,state,client) {
    return convertMarkdown(note.source,{sourcePath:note.path,
      resolveLink:target=>{
        const file=this.resolveFile(target,note.path); const record=file && state.notes[file.path];
        return record?.url ? {url:record.url,kind:'note'} : null;
      },
      resolveImage:async target=>{
        const file=this.resolveFile(target,note.path);
        if(!(file instanceof TFile)) {
          if(IMAGE.test(cleanTarget(target))) throw new Error(`找不到本地图片：${target}`);
          return null;
        }
        if(!IMAGE.test(file.path)) return null;
        const bytes=Buffer.from(await this.app.vault.readBinary(file));
        if(bytes.length>20*1024*1024) throw new Error(`图片超过试用版 20MB 限制：${file.path}`);
        const key=digest(bytes);
        if(!state.assets[key]) {
          const url=await client.uploadImage(bytes,file.name,MIME[file.extension.toLowerCase()] || 'application/octet-stream');
          state.assets[key]={url}; await this.save(); this.log(`已上传图片：${file.path}`);
        }
        return {url:state.assets[key].url};
      }
    });
  }
  async runSync() {
    if(this.busy) return;
    if(!this.data.testRun?.completed) return new Notice('请先在插件设置中运行连接自检，全部通过后再同步真实笔记。',10000);
    this.busy=true; this.logs=[];
    try {
      const client=await this.requireClient(); const scan=await this.scan(); this.log('开始同步。');
      const result=await executeSync({state:this.data.state,notes:scan.notes,folders:scan.folders,client,
        allowDeletes:this.data.settings.syncDeletes,saveState:()=>this.save(),log:x=>this.log(x),
        convert:(note,state)=>this.convert(note,state,client),
        canDelete:async()=>this.localEpoch===scan.epoch && JSON.stringify([...this.data.settings.selectedFolders].sort())===JSON.stringify(scan.folders) && scan.folders.every(f=>listFirstFolders(this.app.vault).includes(f))});
      this.log(`完成：新增 ${result.created}，写入 ${result.updated}，未变化 ${result.skipped}，删除 ${result.deleted}，失败 ${result.errors.length}。`);
      result.warnings.forEach(x=>this.log('提示：'+x)); result.errors.forEach(x=>this.log('失败：'+x));
      this.showLogs();
    } catch(error) {this.fail(error);this.showLogs();}
    finally {this.busy=false;if(!this.unloaded){await this.flushRenames();this.status?.setText(this.client?'语雀：已连接':'语雀：未连接');}}
  }
  async applyRename(oldPath,newPath) {
    try {
      this.data.state=renameState(this.data.state,oldPath,newPath);
      if(!oldPath.includes('/') && !newPath.includes('/')) this.data.settings.selectedFolders=this.data.settings.selectedFolders.map(f=>f===oldPath?newPath:f);
      await this.save(); this.folderRefresh?.();
    } catch(error) {this.fail(error);}
  }
  async flushRenames() { for(const args of this.renameQueue.splice(0)) await this.applyRename(...args); }
  async selfTest() {
    if(this.busy) return new Notice('请等待当前操作完成。');
    this.busy=true; this.logs=[];
    try {
      const client=await this.requireClient(); const run=this.data.testRun ||= {slug:'nb-test-'+randomUUID().replace(/-/g,''),name:'Obsidian Yuque Helper 连接测试'}; run.completed=false; await this.save();
      let books=await client.listBooks(); let book=books.find(b=>b.slug===run.slug);
      if(!book) book=await client.createBook(run.name,run.slug);
      run.book=book; await this.save(); this.log(`测试知识库：${book.url}`);
      const docs=await client.listDocs(book); const slug=run.docSlug ||= 'nb-test-'+randomUUID().replace(/-/g,''); await this.save();
      let doc=docs.find(d=>d.slug===slug);
      if(!doc) doc=await client.createDoc(book,'插件自检：第一版',slug,'这是插件生成的虚构测试内容。');
      run.doc=doc; await this.save();
      const png=Buffer.from('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','base64');
      const image=await client.uploadImage(png,'obsidian-yuque-helper-test.png','image/png');
      const body='# 第二版：插件连接测试\n\n中文正文、代码、图片和公式。\n\n```js\nconsole.log("Obsidian Yuque Helper");\n```\n\n$E=mc^2$\n\n$$\n\\int_0^1 x\\,dx=1/2\n$$\n\n![测试图片](<'+image+'>)\n';
      const prepared=await client.prepareContent(body);
      await client.updateDoc(book,doc,'插件自检：第二版',prepared);
      const read=await client.readDoc(book,doc);
      if(read.title!=='插件自检：第二版' || docBody(read)!==preparedBody(prepared)) throw new Error('创建或更新后的正文核验未通过。');
      this.log(`创建、图片上传、第二次更新与读回核验通过：${doc.url}`);
      const deleteSlug=run.deleteSlug ||= 'nb-delete-'+randomUUID().replace(/-/g,''); await this.save();
      let disposable=(await client.listDocs(book)).find(d=>d.slug===deleteSlug);
      if(!disposable && !run.deleteDoc) disposable=await client.createDoc(book,'仅用于删除自检',deleteSlug,'这是一篇可丢弃的插件测试文档。');
      if(disposable) { run.deleteDoc=disposable; await this.save(); await client.deleteDoc(book,disposable); }
      else disposable=run.deleteDoc;
      if((await client.listDocs(book)).some(d=>String(d.id)===String(disposable.id))) throw new Error('删除核验未通过。');
      run.completed=true; delete run.deleteDoc; delete run.deleteSlug; await this.save(); this.log('删除核验通过。测试知识库和第二版文档已保留，供你检查显示效果。');
      new Notice('连接自检通过。可以勾选文件夹，再预览同步。',10000);
    } catch(error) {this.fail(error);}
    finally {this.busy=false;if(!this.unloaded){await this.flushRenames();this.showLogs();this.folderRefresh?.();}}
  }
}

class YuqueSettings extends PluginSettingTab {
  constructor(app,plugin) { super(app,plugin);this.plugin=plugin; }
  display() {
    const el=this.containerEl; const p=this.plugin; el.empty(); p.folderRefresh=()=>this.display();
    el.createEl('h2',{text:'Obsidian Yuque Helper（试用版）'});
    el.createEl('p',{text:'单向、手动、桌面同步。只把选中文件夹中的 Markdown（.md）笔记同步为文档；图片仅在被笔记引用时上传。首次打开登录窗口，检查登录并运行连接自检。支持记住登录，也可随时退出。'});
    new Setting(el).setName('语雀个人路径').setDesc('例如 your-name。已有配对记录时应继续使用同一账号。').addText(t=>t.setValue(p.data.settings.account).onChange(async value=>{if(!p.busy){p.data.settings.account=value.trim();p.sessionEpoch=(p.sessionEpoch || 0)+1;p.client=null;await p.save();}}));
    new Setting(el).setName('登录与连接').setDesc(p.client?'已连接 '+p.data.accountLogin:'尚未连接；浏览器中的现有登录不会自动共享。')
      .addButton(b=>b.setButtonText('打开登录窗口').onClick(()=>p.login()))
      .addButton(b=>b.setButtonText('检查登录').onClick(()=>p.connect()))
      .addButton(b=>b.setButtonText('退出登录').onClick(()=>p.logout()));
    new Setting(el).setName('记住登录').setDesc('默认开启。本机最长记住 30 天，语雀登录仍有效时会自动恢复；服务端使登录失效时需要重新登录。更改此选项在下次重载插件或重启 Obsidian 后生效；关闭后会在结束当前会话时清除登录。')
      .addToggle(t=>t.setValue(p.data.settings.rememberLogin).onChange(async value=>{
        if(p.busy)return new Notice('请等待当前操作完成后再修改登录设置。');
        p.data.settings.rememberLogin=value;await p.save();
      }));
    new Setting(el).setName('连接自检').setDesc('只使用插件生成的虚构内容，测试建库、文档更新、图片和删除。测试结果保留在独立知识库。')
      .addButton(b=>b.setButtonText('运行连接自检').onClick(()=>p.selfTest()));
    el.createEl('h3',{text:'选择一级文件夹'});
    for(const folder of listFirstFolders(p.app.vault)) {
      const paired=p.data.state.books[folder];
      new Setting(el).setName(folder).setDesc(paired?`已配对：${paired.name || folder}；仅同步 .md 笔记。`:'首次同步时新建私有知识库；仅同步 .md 笔记，根目录笔记不在范围内。')
        .addToggle(t=>t.setValue(p.data.settings.selectedFolders.includes(folder)).onChange(async value=>{
          if(p.busy) return new Notice('同步期间请等待操作完成后再修改选择。');
          p.data.settings.selectedFolders=p.data.settings.selectedFolders.filter(x=>x!==folder);if(value)p.data.settings.selectedFolders.push(folder);await p.save();
        }));
    }
    new Setting(el).setName('同步删除').setDesc('本地删除已配对笔记后，将对应语雀文档移入回收站。取消勾选文件夹会保留远端内容。')
      .addToggle(t=>t.setValue(p.data.settings.syncDeletes).onChange(async value=>{if(!p.busy){p.data.settings.syncDeletes=value;await p.save();}}));
    new Setting(el).setName('手动同步').addButton(b=>b.setButtonText('预览同步').setCta().onClick(()=>p.preview())).addButton(b=>b.setButtonText('查看结果').onClick(()=>p.showLogs()));
    el.createEl('p',{text:'图片可从库内任意文件夹按引用读取，无需勾选附件文件夹；未引用图片、PDF、Canvas 和其他非 .md 文件不会作为文档同步。Markdown 图片、双链接和数学公式支持转换。Dataview 等动态内容以代码保存并提示；未同步或不存在的目标笔记不会生成虚假链接。网页接口可能变化，失败会显示原因并停止相关操作。'});
  }
  hide() { this.plugin.folderRefresh=null; }
}
module.exports=NoteBoxYuquePlugin;
module.exports._test={safeYuqueUrl,cleanTarget,listFirstFolders,PreviewModal,ReportModal,YuqueSettings};
