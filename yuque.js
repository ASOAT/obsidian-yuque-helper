'use strict';

const { Buffer } = require('buffer');
const { randomBytes } = require('crypto');
const { installRequestMain } = require('./request-main');

const ORIGIN = 'https://www.yuque.com';
const RESPONSE_LIMIT = 12 * 1024 * 1024;
const IMAGE_LIMIT = 50 * 1024 * 1024;
const PAGE_SIZE = 100;

class YuqueError extends Error {
  constructor(message, code = 'YUQUE_ERROR', status) {
    super(message);
    this.name = 'YuqueError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function fail(message, code = 'INCOMPATIBLE_RESPONSE') {
  throw new YuqueError(message, code);
}

function positiveId(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(`语雀返回的${label}无效。`);
  return number;
}

function segment(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(value) || value === '.' || value === '..') {
    fail(`${label}无效。`, 'INVALID_INPUT');
  }
  return value;
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`语雀${label}响应格式发生变化，已停止操作。`);
  return value;
}

function entity(response, label) {
  const data = Object.prototype.hasOwnProperty.call(response, 'data') ? response.data : response;
  return record(data, label);
}

function pageItems(response, keys) {
  const data = response.data;
  if (Array.isArray(data)) return data;
  for (const container of [data, response]) {
    if (!container || typeof container !== 'object') continue;
    for (const key of keys) if (Array.isArray(container[key])) return container[key];
  }
  fail('语雀列表响应格式发生变化，已停止操作。');
}

function titleText(value) {
  if (typeof value !== 'string' || !value.trim()) fail('文档或知识库名称不能为空。', 'INVALID_INPUT');
  return value;
}

function lakeBody(value) {
  if (typeof value !== 'string' || !/^\s*<!doctype lake>\s*</i.test(value) ||
      /<script(?:\s|>|\/)/i.test(value) || value.includes('\0') || Buffer.byteLength(value) > RESPONSE_LIMIT) {
    fail('语雀没有返回有效的原生文档正文，已停止操作。', 'INCOMPATIBLE_CONTENT');
  }
  return value;
}

function safeHtml(value) {
  if (typeof value !== 'string' || !value.trim() || /<script(?:\s|>|\/)/i.test(value) ||
      value.includes('\0') || Buffer.byteLength(value) > RESPONSE_LIMIT) {
    fail('无法生成安全的文档显示内容，已停止操作。', 'INVALID_CONTENT');
  }
  return value;
}

function comparableBody(value) {
  return value.replace(/\r\n?/g, '\n').trim();
}

function dashboardIdentity(html) {
  // Read only literal JSON serialization from the server response. Never execute scripts.
  const pattern = /JSON\.parse\(\s*decodeURIComponent\(\s*("(?:\\.|[^"\\])*")\s*\)\s*\)/g;
  let match, found;
  while ((match = pattern.exec(html)) !== null) {
    let appData;
    try { appData = JSON.parse(decodeURIComponent(JSON.parse(match[1]))); } catch (_) { continue; }
    if (!appData || typeof appData !== 'object' || !appData.me) continue;
    const me = record(appData.me, '当前账号');
    if (!me.id || !me.login) continue;
    const account = { id: positiveId(me.id, '账号 ID'), login: segment(me.login, '语雀账号'), name: typeof me.name === 'string' ? me.name : me.login };
    if (found && (found.id !== account.id || found.login !== account.login)) fail('语雀页面包含冲突的账号信息，已停止操作。');
    found = account;
  }
  if (!found) fail('无法确认当前语雀账号，请先在登录窗口完成登录。', 'AUTH_REQUIRED');
  return found;
}

// These /api endpoints belong to the Yuque website, not its supported OpenAPI.
// No retries or fallback writes: uncertain writes must be recovered by the sync engine.
class YuqueClient {
  constructor({ session, bridge, net, logger, htmlRenderer, timeoutMs = 30000 } = {}) {
    if (!session || (!bridge?.request && !net?.request && typeof session.fetch !== 'function')) {
      fail('当前 Obsidian 无法使用独立语雀登录窗口，请更新桌面版。', 'UNSUPPORTED_RUNTIME');
    }
    this.session = session;
    // Production passes a bridge compiled in main; native net is for local callers.
    this.bridge = bridge || (net?.request ? installRequestMain(session, net) : null);
    this.logger = logger;
    this.htmlRenderer = htmlRenderer;
    this.timeoutMs = Math.max(1000, Math.min(120000, Number(timeoutMs) || 30000));
    this.account = null;
    this.expectedLogin = null;
  }

  _log(message) {
    try { if (typeof this.logger === 'function') this.logger(message); } catch (_) { /* Logging cannot affect requests. */ }
  }

  async initialize(accountSlug) {
    this.account = null;
    this.expectedLogin = segment(accountSlug, '语雀个人路径');
    const account = await this._identity();
    if (account.login !== this.expectedLogin) {
      fail(`登录账号与设置中的 ${this.expectedLogin} 不一致，请重新登录。`, 'ACCOUNT_MISMATCH');
    }
    this.account = account;
    return { ...account };
  }

  async _identity() {
    try {
      const response = await this._request('GET', '/api/mine');
      const data = entity(response, '账号');
      const user = record(data.user || data.me || data, '账号');
      if (!user.login || !user.id) fail('语雀账号接口缺少身份字段。');
      return { id: positiveId(user.id, '账号 ID'), login: segment(user.login, '语雀账号'), name: typeof user.name === 'string' ? user.name : user.login };
    } catch (error) {
      // One evidenced, read-only fallback for website versions without this endpoint.
      // Auth, network, and other business failures do not trigger alternate requests.
      if (!(error instanceof YuqueError) || !((error.code === 'HTTP_ERROR' && error.status === 404) || error.code === 'INCOMPATIBLE_RESPONSE')) throw error;
      const result = await this._wire('GET', '/dashboard', undefined, `${ORIGIN}/dashboard`, undefined, true);
      return dashboardIdentity(result.text);
    }
  }

  _ready() {
    if (!this.account || !this.expectedLogin) fail('请先登录并验证语雀账号。', 'AUTH_REQUIRED');
  }

  async _confirmAccount() {
    this._ready();
    const current = await this._identity();
    if (current.id !== this.account.id || current.login !== this.expectedLogin) {
      this.account = null;
      fail('语雀登录账号已改变，已停止同步，请重新验证账号。', 'ACCOUNT_MISMATCH');
    }
  }

  _book(raw, assumedOwned = false) {
    this._ready();
    raw = record(raw, '知识库');
    const id = positiveId(raw.id, '知识库 ID');
    const slug = segment(raw.slug, '知识库路径');
    const ownerId = raw.user_id ?? raw.userId ?? raw.user?.id;
    const namespace = typeof raw.namespace === 'string' ? raw.namespace.split('/')[0] : null;
    const ownerLogin = raw.ownerLogin || raw.user?.login || raw.login || namespace;
    if (ownerId !== undefined && positiveId(ownerId, '知识库拥有者 ID') !== this.account.id) return null;
    if (ownerLogin && ownerLogin !== this.account.login) return null;
    if (!assumedOwned && ownerId === undefined && !ownerLogin) {
      fail('无法确认知识库拥有者，已停止操作。');
    }
    return {
      id, slug, name: typeof raw.name === 'string' ? raw.name : slug,
      userId: this.account.id, ownerLogin: this.account.login,
      url: `${ORIGIN}/${this.account.login}/${slug}`,
      public: raw.public, items_count: raw.items_count
    };
  }

  _boundBook(book) {
    const normalized = this._book(book);
    if (!normalized) fail('只能同步当前账号拥有的知识库。', 'OWNERSHIP_MISMATCH');
    return normalized;
  }

  _doc(raw, book, fallback = {}) {
    raw = record(raw, '文档');
    const id = positiveId(raw.id ?? raw.doc_id, '文档 ID');
    const actualBookId = raw.book_id ?? raw.bookId ?? raw.book?.id;
    if (actualBookId !== undefined && positiveId(actualBookId, '文档知识库 ID') !== book.id) {
      fail('文档不属于已配对知识库，已停止操作。', 'OWNERSHIP_MISMATCH');
    }
    const slug = segment(raw.slug ?? fallback.slug, '文档路径');
    return {
      id, slug, title: typeof raw.title === 'string' ? raw.title : (fallback.title || slug),
      bookId: book.id, url: `${book.url}/${slug}`,
      type: raw.type, format: raw.format,
      ...(typeof raw.body === 'string' ? { body: raw.body } : {}),
      ...(typeof raw.body_draft === 'string' ? { body_draft: raw.body_draft } : {}),
      ...(typeof raw.body_asl === 'string' ? { body_asl: raw.body_asl } : {}),
      ...(typeof raw.body_draft_asl === 'string' ? { body_draft_asl: raw.body_draft_asl } : {}),
      ...(raw.draft_version !== undefined ? { draft_version: raw.draft_version } : {}),
      ...(raw.updated_at !== undefined ? { updated_at: raw.updated_at } : {})
    };
  }

  async _pages(path, keys, normalize) {
    const all = [];
    const ids = new Set();
    let offset = 0;
    for (let page = 0; page < 100; page += 1) {
      const response = await this._request('GET', `${path}${path.includes('?') ? '&' : '?'}offset=${offset}&limit=${PAGE_SIZE}`);
      const items = pageItems(response, keys);
      for (const raw of items) {
        const item = normalize(raw);
        if (!item) continue;
        if (ids.has(item.id)) fail('语雀列表分页重复，无法确认完整列表。');
        ids.add(item.id);
        all.push(item);
      }
      const total = response.meta?.total ?? response.data?.total;
      const hasTotal = (typeof total === 'number' || (typeof total === 'string' && /^\d+$/.test(total))) && Number.isSafeInteger(Number(total)) && Number(total) >= 0;
      offset += items.length;
      if (hasTotal && Number(total) <= offset) return all;
      if (hasTotal && !items.length) fail('语雀列表返回不完整，已停止操作。');
      if (!hasTotal && items.length < PAGE_SIZE) return all;
    }
    fail('语雀列表过大，已停止操作。');
  }

  async listBooks() {
    await this._confirmAccount();
    return this._pages('/api/mine/books', ['books', 'repos'], raw => this._book(raw));
  }

  async createBook(name, requestedSlug) {
    await this._confirmAccount();
    const slug = segment(requestedSlug || `notebox-${randomBytes(10).toString('hex')}`, '知识库路径');
    const response = await this._request('POST', '/api/books', {
      name: titleText(name), slug, user_id: this.account.id,
      description: '由 Obsidian Yuque Helper 建立。', public: 0, type: 'Book', repo_type: 'Book'
    });
    const book = this._book(entity(response, '新建知识库'), true);
    if (!book) fail('新建知识库的拥有者与当前账号不一致。', 'OWNERSHIP_MISMATCH');
    if (book.slug !== slug) fail('语雀返回的知识库路径与请求不一致，请检查后再同步。');
    return book;
  }

  async listDocs(bookInput) {
    await this._confirmAccount();
    const book = this._boundBook(bookInput);
    return this._pages(`/api/docs?book_id=${book.id}`, ['docs'], raw => this._doc(raw, book));
  }

  _preparedContent(content) {
    if (!content || typeof content !== 'object' || Array.isArray(content) || content.format !== 'lake') {
      fail('文档正文必须先转换为语雀原生格式。', 'INVALID_INPUT');
    }
    return Object.freeze({ format: 'lake', body: lakeBody(content.body), html: safeHtml(content.html) });
  }

  async prepareContent(markdown) {
    this._ready();
    if (typeof markdown !== 'string') fail('文档正文必须是文本。', 'INVALID_INPUT');
    if (typeof this.htmlRenderer !== 'function') {
      fail('当前插件无法生成文档显示内容，请重新启用插件。', 'UNSUPPORTED_RUNTIME');
    }
    // Render first, so local rendering failures cannot leave a remote write behind.
    const html = safeHtml(await this.htmlRenderer(markdown));
    await this._confirmAccount();
    const response = await this._request('POST', '/api/docs/convert', {
      content: markdown, from: 'markdown', to: 'lake'
    });
    const converted = entity(response, '正文转换');
    return this._preparedContent({ format: 'lake', body: converted.content, html });
  }

  _lakeDoc(doc, requireVersion = false) {
    if (doc.type !== 'Doc' || doc.format !== 'lake') {
      fail('已配对文档不是支持的语雀文档格式，已停止更新。', 'UNSUPPORTED_FORMAT');
    }
    if (requireVersion && (!Number.isSafeInteger(doc.draft_version) || doc.draft_version < 0)) {
      fail('语雀文档缺少有效的草稿版本，已停止更新。');
    }
    return doc;
  }

  _verifyPublished(doc, content, title) {
    this._lakeDoc(doc);
    if (doc.title !== title || comparableBody(lakeBody(doc.body_asl)) !== comparableBody(content.body)) {
      fail('语雀发布后的正文或标题与本次同步不一致，已停止后续操作。', 'READBACK_MISMATCH');
    }
    return doc;
  }

  async createDoc(bookInput, title, slug, body = '') {
    this._ready();
    const book = this._boundBook(bookInput);
    title = titleText(title);
    slug = segment(slug, '文档路径');
    const content = typeof body === 'string' ? await this.prepareContent(body) : this._preparedContent(body);
    await this._confirmAccount();
    const response = await this._request('POST', '/api/docs', {
      book_id: book.id, title, slug, type: 'Doc', format: 'lake',
      body: content.html, body_draft: content.html,
      body_asl: content.body, body_draft_asl: content.body,
      status: 1, public: 0, insert_to_catalog: true,
      action: 'prependChild', target_uuid: ''
    }, book.url);
    const doc = this._lakeDoc(this._doc(entity(response, '新建文档'), book));
    if (doc.slug !== slug) fail('语雀返回的文档路径与请求不一致，请检查后再同步。');
    await this._confirmAccount();
    return this._verifyPublished(await this._readDoc(book, doc), content, title);
  }

  async _readDoc(book, docInput) {
    const id = positiveId(docInput.id, '文档 ID');
    const referer = docInput.slug ? `${book.url}/${segment(docInput.slug, '文档路径')}/edit` : book.url;
    const response = await this._request('GET', `/api/docs/${id}?book_id=${book.id}&mode=edit&merge_dynamic_data=false&include_contributors=true&include_like=true&include_hits=true`, undefined, referer);
    const raw = entity(response, '文档详情');
    // A missing book ID must not authorize an update or deletion.
    if (raw.book_id === undefined && raw.bookId === undefined && raw.book?.id === undefined) {
      fail('语雀文档详情缺少所属知识库，已停止操作。');
    }
    const doc = this._doc(raw, book);
    if (doc.id !== id) fail('语雀返回的文档 ID 与配对记录不一致。');
    if (docInput.slug && doc.slug !== docInput.slug) fail('已配对文档的路径发生变化，请检查配对记录。');
    return doc;
  }

  async readDoc(bookInput, docInput) {
    await this._confirmAccount();
    return this._readDoc(this._boundBook(bookInput), docInput);
  }

  async updateDoc(bookInput, docInput, title, body) {
    await this._confirmAccount();
    const book = this._boundBook(bookInput);
    let current = this._lakeDoc(await this._readDoc(book, docInput), true);
    title = titleText(title);
    const content = typeof body === 'string' ? await this.prepareContent(body) : this._preparedContent(body);
    if (current.title !== title) {
      await this._confirmAccount();
      const renamed = entity(await this._request('PUT', `/api/docs/${current.id}/meta`, { title }, current.url), '标题更新');
      if (positiveId(renamed.id, '文档 ID') !== current.id) fail('更新标题后的文档 ID 与配对记录不一致。');
      // Metadata may advance the server's draft revision. Do not reuse a stale version.
      current = this._lakeDoc(await this._readDoc(book, current), true);
      if (current.title !== title) fail('语雀返回的标题与本次更新不一致，已停止保存正文。', 'READBACK_MISMATCH');
    }
    await this._confirmAccount();
    const saved = entity(await this._request('PUT', `/api/docs/${current.id}/content`, {
      body_asl: content.body, body_html: content.html, created_by: 'online',
      draft_version: current.draft_version, edit_type: 'Lake', format: 'lake',
      save_type: 'user', sync_dynamic_data: false, target_uuid: null
    }, `${current.url}/edit`), '草稿保存');
    if (positiveId(saved.id, '文档 ID') !== current.id || !Number.isSafeInteger(saved.draft_version) || saved.draft_version < 0) {
      fail('无法确认语雀草稿保存结果，已停止发布。');
    }
    await this._confirmAccount();
    const published = await this._request('PUT', `/api/docs/${current.id}/publish`, {
      cover: null, force: false, notify: false, ignoreGlobalMessage: true
    }, `${current.url}/edit`);
    // The native publish endpoint has no guaranteed response fields. Published
    // source readback below is the required proof; inspect IDs only when supplied.
    const publishedDoc = published.data && typeof published.data === 'object' ? published.data : published;
    if (Object.prototype.hasOwnProperty.call(publishedDoc, 'id') && positiveId(publishedDoc.id, '文档 ID') !== current.id) {
      fail('发布后的文档 ID 与配对记录不一致。');
    }
    await this._confirmAccount();
    return this._verifyPublished(await this._readDoc(book, current), content, title);
  }

  async deleteDoc(bookInput, docInput, canDelete) {
    await this._confirmAccount();
    const book = this._boundBook(bookInput);
    const current = await this._readDoc(book, docInput);
    if(canDelete && !(await canDelete())) fail('本地内容发生变化，已停止删除。', 'LOCAL_CHANGED');
    await this._request('DELETE', `/api/docs/${current.id}?book_id=${book.id}`, undefined, current.url);
    return true;
  }

  async uploadImage(bytes, name, mime) {
    await this._confirmAccount();
    if (!/^image\/(png|jpeg|gif|webp|svg\+xml|bmp|avif)$/.test(mime || '')) fail('不支持这种图片格式。', 'INVALID_INPUT');
    const file = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (!file.length || file.length > IMAGE_LIMIT) fail('图片为空或超过 50 MB。', 'INVALID_INPUT');
    const filename = String(name || 'image').split(/[\\/]/).pop().replace(/[\r\n"\x00]/g, '_');
    const boundary = `----NoteBox${randomBytes(16).toString('hex')}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`, 'utf8'),
      file, Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const csrf = await this._csrf();
    const query = new URLSearchParams({ attachable_type: 'User', attachable_id: String(this.account.id), type: 'image', ctoken: csrf });
    const response = await this._request('POST', `/api/upload/attach?${query}`, body, `${ORIGIN}/dashboard`, `multipart/form-data; boundary=${boundary}`);
    const result = entity(response, '图片上传');
    const rawUrl = result.url || result.attachment?.url;
    let url;
    try { url = new URL(rawUrl); } catch (_) { fail('语雀没有返回有效的图片地址。'); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
        !(host === 'cdn.nlark.com' || host === 'yuque.com' || host.endsWith('.yuque.com')) ||
        url.searchParams.has('ctoken') || url.searchParams.has('_yuque_session')) {
      fail('语雀返回的图片地址不在已验证的图片域名中。');
    }
    return url.href;
  }

  async _csrf() {
    if (!this.session.cookies?.get) fail('当前登录窗口无法确认语雀请求令牌。', 'UNSUPPORTED_RUNTIME');
    const cookies = await this.session.cookies.get({ url: ORIGIN, name: 'yuque_ctoken' });
    const values = [...new Set(cookies.filter(cookie => cookie.name === 'yuque_ctoken' && cookie.value).map(cookie => cookie.value))];
    if (values.length !== 1 || /[\r\n]/.test(values[0])) fail('登录状态已失效，请在语雀窗口重新登录。', 'AUTH_REQUIRED');
    return values[0];
  }

  async _wire(method, path, payload, referer, contentType, dashboard = false) {
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || !(url.pathname.startsWith('/api/') || (dashboard && method === 'GET' && url.pathname === '/dashboard' && !url.search))) fail('请求地址无效。', 'INVALID_INPUT');
    const headers = { Accept: dashboard ? 'text/html' : 'application/json', 'X-Requested-With': 'XMLHttpRequest', Referer: referer };
    const write = !['GET', 'HEAD'].includes(method);
    if (write) {
      headers['X-CSRF-Token'] = await this._csrf();
      headers.Origin = ORIGIN;
    }
    let body;
    if (payload !== undefined) {
      headers['Content-Type'] = contentType || 'application/json';
      body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
    }
    const label = `${method} ${url.pathname}`;
    this._log(`开始请求：${label}`);
    const result = this.bridge
      ? await this._bridgeRequest(url.href, method, headers, body, label)
      : await this._fetchRequest(url.href, method, headers, body, label);
    if (!Number.isInteger(result.status)) fail(`无法确认语雀请求状态（${label}）。`);
    this._log(`收到完整响应：${label}，状态 ${result.status}，${Buffer.byteLength(result.text)} 字节。`);
    if (result.status === 401 || result.status === 403) fail('语雀拒绝请求，请重新登录并检查知识库权限。', 'AUTH_REQUIRED');
    if (result.status < 200 || result.status >= 300) throw new YuqueError(`语雀请求失败（${result.status}，${label}）。`, 'HTTP_ERROR', result.status);
    return result;
  }

  async _request(method, path, payload, referer = `${ORIGIN}/dashboard`, contentType) {
    const label = `${method} ${new URL(path, ORIGIN).pathname}`;
    const write = !['GET', 'HEAD'].includes(method);
    const result = await this._wire(method, path, payload, referer, contentType);
    if (!result.text.trim()) {
      if (method === 'DELETE' || result.status === 204) return {};
      fail(`语雀返回了空响应（${label}）。`);
    }
    let response;
    try { response = JSON.parse(result.text); } catch (_) { fail(`语雀返回了非 JSON 响应，请重新登录（${label}）。`, 'INCOMPATIBLE_RESPONSE'); }
    record(response, '请求');
    if (response.success === false || response.ok === false || response.error || (write && response.data === false) ||
        (Array.isArray(response.errors) && response.errors.length) ||
        (typeof response.status === 'number' && response.status >= 400) ||
        (typeof response.status === 'string' && ['error', 'failed', 'failure'].includes(response.status.toLowerCase())) ||
        (response.code !== undefined && ![0, 200, '0', '200', 'SUCCESS', 'success'].includes(response.code))) {
      fail(`语雀未接受操作（${label}），同步已停止。`, 'API_ERROR');
    }
    if (method === 'DELETE' && !Object.prototype.hasOwnProperty.call(response, 'data') && response.success !== true && response.ok !== true) {
      fail(`无法确认语雀删除操作的响应（${label}）。`);
    }
    return response;
  }

  async _bridgeRequest(url, method, headers, body, label) {
    let result;
    try { result = await this.bridge.request({url, method, headers, body, timeoutMs:this.timeoutMs}); }
    catch (_) { throw new YuqueError(`语雀请求连接中断（${label}），请重新启用插件。`, 'NETWORK_ERROR'); }
    if (!result || typeof result !== 'object') fail(`无法读取语雀响应（${label}）。`);
    if (result.error) {
      const advice = method === 'GET' ? '请稍后重新检查登录。' : '请先检查是否已写入再重试。';
      const messages = {
        TIMEOUT: `语雀请求超时（${label}），${advice}`,
        NETWORK_ERROR: `语雀网络请求或响应中断（${label}），${advice}`,
        REDIRECT_BLOCKED: `语雀请求发生重定向（${label}），请在插件窗口重新登录。`,
        RESPONSE_TOO_LARGE: `语雀响应过大（${label}），已停止操作。`,
        CLOSED: `语雀请求连接已关闭（${label}），请重新启用插件。`,
        INVALID_REQUEST: `语雀请求参数无效（${label}），已停止操作。`
      };
      const code = Object.prototype.hasOwnProperty.call(messages, result.error.code) ? result.error.code : 'NETWORK_ERROR';
      // Raw network messages can contain URLs or credentials; never surface them.
      throw new YuqueError(messages[code], code);
    }
    if (typeof result.text !== 'string') fail(`无法读取语雀响应正文（${label}）。`);
    if (Buffer.byteLength(result.text) > RESPONSE_LIMIT) fail('语雀响应过大，已停止操作。', 'RESPONSE_TOO_LARGE');
    return result;
  }

  async _fetchRequest(url, method, headers, body, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.session.fetch(url, { method, headers, body, credentials: 'include', redirect: 'error', signal: controller.signal });
      const text = await response.text();
      if (Buffer.byteLength(text) > RESPONSE_LIMIT) fail('语雀响应过大，已停止操作。', 'RESPONSE_TOO_LARGE');
      return { status: response.status, text };
    } catch (error) {
      if (error instanceof YuqueError) throw error;
      throw new YuqueError(`语雀请求${controller.signal.aborted ? '超时' : '失败'}（${label}），请先检查是否已写入再重试。`, controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR');
    } finally { clearTimeout(timer); }
  }
}

module.exports = { YuqueClient, YuqueError };
