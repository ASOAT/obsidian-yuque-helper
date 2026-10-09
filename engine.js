'use strict';
const {createHash, randomUUID} = require('node:crypto');
const {createPlan} = require('./sync');
const digest = value => createHash('sha256').update(value).digest('hex');
const normalized = value => String(value).replace(/\r\n/g, '\n').trim();
const docBody = doc => {
  if (doc?.format === 'lake') {
    if (doc.type !== 'Doc' || typeof doc.body_asl !== 'string') throw new Error('语雀没有返回可核验的已发布正文，已停止该文档。');
    return normalized(doc.body_asl);
  }
  if (!doc || typeof doc.body !== 'string') throw new Error('语雀没有返回可核验的 Markdown 正文，已停止该文档。');
  if (doc.format && doc.format !== 'markdown') throw new Error('远端文档格式不受支持，已停止覆盖。');
  return normalized(doc.body);
};
const preparedBody = content => {
  if (typeof content === 'string') return normalized(content);
  if (content?.format === 'lake' && typeof content.body === 'string') return normalized(content.body);
  throw new Error('无法确认准备写入的正文，已停止该文档。');
};
const sameId = (a,b) => String(a) === String(b);
class PersistenceError extends Error {}

async function executeSync(options) {
  const {state, notes, folders, client, convert, log = () => {}, allowDeletes = true} = options;
  state.books ||= {}; state.notes ||= {}; state.pendingBooks ||= {}; state.pendingDocs ||= {}; state.assets ||= {};
  const save = async () => { try { await options.saveState(state); } catch { throw new PersistenceError('无法保存同步记录，已停止操作。'); } };
  const result = {created:0, updated:0, skipped:0, deleted:0, errors:[], warnings:[], deletionBlocked:false};
  let books = await client.listBooks();
  for (const folder of folders) {
    if (state.books[folder]) {
      if (!books.some(b => sameId(b.id, state.books[folder].id))) throw new Error(`找不到已配对的知识库「${folder}」，请先在语雀检查它。`);
      continue;
    }
    const pending = state.pendingBooks[folder] ||= {slug:'nb-' + randomUUID().replace(/-/g,'')};
    await save();
    let book = books.find(b => b.slug === pending.slug);
    if (!book) book = await client.createBook(folder, pending.slug);
    if (!book?.id || !book.slug) throw new Error('创建知识库后未返回有效编号。');
    state.books[folder] = {...book, folder}; delete state.pendingBooks[folder]; await save(); books.push(book);
    log(`已配对知识库：${folder}`);
  }
  const lists = new Map();
  const listDocs = async book => {
    if (!lists.has(String(book.id))) lists.set(String(book.id), await client.listDocs(book));
    return lists.get(String(book.id));
  };
  // Persist a random slug BEFORE creating, so an ambiguous network failure can be recovered by slug.
  for (const note of notes) {
    if (state.notes[note.path]) continue;
    try {
      const book = state.books[note.folder];
      const pending = state.pendingDocs[note.path] ||= {slug:'nb-' + randomUUID().replace(/-/g,''), folder:note.folder};
      if (pending.folder !== note.folder) throw new Error('这篇笔记有未完成的跨库移动，请先恢复原路径再重试。');
      await save();
      const docs = await listDocs(book);
      let doc = docs.find(d => d.slug === pending.slug);
      if (!doc) { doc = await client.createDoc(book, note.title, pending.slug, '同步准备中。'); docs.push(doc); }
      if (!doc?.id || !doc.slug || !doc.url) throw new Error('创建文档后未返回有效编号和网址。');
      state.notes[note.path] = {id:doc.id,slug:doc.slug,url:doc.url,title:doc.title,bookId:book.id,folder:note.folder,hash:null,bodyHash:null};
      delete state.pendingDocs[note.path]; await save(); result.created++; log(`已创建：${note.path}`);
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      result.errors.push(`${note.path}：${error.message}`);
    }
  }
  // All target URLs now exist, so cross-note links can be converted in one pass.
  for (const note of notes) {
    const record = state.notes[note.path];
    if (!record) continue;
    try {
      if (record.folder !== note.folder) throw new Error('本地文件夹与配对知识库不一致，已停止覆盖。');
      const book = state.books[note.folder];
      const contentHash = await note.calculateHash(state);
      const remote = await client.readDoc(book, record);
      const remoteHash = digest(docBody(remote));
      if (record.hash === contentHash && record.bodyHash === remoteHash && remote.title === note.title) { result.skipped++; continue; }
      const rendered = await convert(note, state);
      result.warnings.push(...(rendered.warnings || []).map(w => `${note.path}：${w}`));
      // Convert once, then compare the exact native representation that was sent.
      const prepared = client.prepareContent ? await client.prepareContent(rendered.markdown) : rendered.markdown;
      const expected = preparedBody(prepared);
      await client.updateDoc(book, record, note.title, prepared);
      const verified = await client.readDoc(book, record);
      if (docBody(verified) !== expected || verified.title !== note.title) throw new Error('语雀读回的标题或正文与本地不一致，未标记为同步成功。');
      record.hash = contentHash; record.bodyHash = digest(docBody(verified)); record.title = note.title;
      await save(); result.updated++; log(`已核验：${note.path}`);
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      result.errors.push(`${note.path}：${error.message}`);
    }
  }
  const plan = createPlan({selectedFolders:folders, availableFolders:folders, scanCompleteFolders:folders, notes:notes.map(n=>({path:n.path,folder:n.folder,title:n.title,contentHash:state.notes[n.path]?.hash})), state, allowDeletes});
  if (plan.removes.length && (result.errors.length || !(await options.canDelete()))) {
    result.deletionBlocked = true; log('本轮有失败或本地内容发生变化，已跳过全部删除。');
    return result;
  }
  for (const item of plan.removes) {
    try {
      if(!(await options.canDelete())) {result.deletionBlocked=true;log('本地内容发生变化，已跳过后续删除。');break;}
      const record = state.notes[item.path];
      const book = state.books[record.folder];
      if (!book || !sameId(book.id, record.bookId)) throw new Error('知识库配对记录不一致，已停止删除。');
      const current = await client.listDocs(book);
      if(!(await options.canDelete())) {result.deletionBlocked=true;log('本地内容发生变化，已跳过后续删除。');break;}
      if (current.some(d=>sameId(d.id,record.id))) await client.deleteDoc(book, record, options.canDelete);
      const after = await client.listDocs(book);
      if (after.some(d=>sameId(d.id,record.id))) throw new Error('删除后文档仍在知识库中，未清除配对记录。');
      delete state.notes[item.path]; await save(); result.deleted++; log(`已移入语雀回收站：${item.path}`);
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      if(error.code==='LOCAL_CHANGED') {result.deletionBlocked=true;log('本地内容发生变化，已跳过后续删除。');break;}
      result.errors.push(`${item.path}：${error.message}`);
    }
  }
  return result;
}
module.exports = {executeSync, digest, normalized, docBody, preparedBody, PersistenceError};
