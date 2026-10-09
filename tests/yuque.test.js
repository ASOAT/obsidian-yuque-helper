'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { YuqueClient } = require('../yuque');

const mine = { data: { id: 42, login: 'test-user', name: '测试账号' } };
const book = { id: 10, slug: 'notebox-test', name: '测试知识库', userId: 42, ownerLogin: 'test-user', url: 'https://www.yuque.com/test-user/notebox-test' };
const lake = '<!doctype lake><meta name="doc"/><p id="server-card-1">第一版</p>';
const secondLake = '<!doctype lake><meta name="doc"/><p id="server-card-2">第二版</p>';
const html = '<!doctype html><html><body><p>第一版</p></body></html>';
const secondHtml = '<!doctype html><html><body><p>第二版</p></body></html>';
const prepared = { format: 'lake', body: secondLake, html: secondHtml };
const rawDoc = { id: 20, book_id: 10, slug: 'note-test', title: '测试笔记', type: 'Doc', format: 'lake', body: html, body_draft: html, body_asl: lake, body_draft_asl: lake, draft_version: 4 };
const doc = { id: 20, slug: 'note-test' };

function harness(entries, options = {}) {
  const calls = [], cookieCalls = [], logs = [];
  const queue = [...entries];
  const session = {
    cookies: { get: async filter => { cookieCalls.push(filter); return options.cookies || [{ name: 'yuque_ctoken', value: 'private-csrf-value' }]; } },
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      const next = queue.shift();
      assert.notEqual(next, undefined, 'unexpected HTTP request');
      if (next instanceof Error) throw next;
      const value = next.response === undefined ? next : next.response;
      return { status: next.status || 200, text: async () => typeof value === 'string' ? value : JSON.stringify(value) };
    }
  };
  const htmlRenderer = Object.prototype.hasOwnProperty.call(options, 'htmlRenderer') ? options.htmlRenderer : async () => html;
  const client = new YuqueClient({ session, htmlRenderer, logger: value => logs.push(value) });
  return { client, session, calls, cookieCalls, logs, queue };
}

test('initialize confirms the authenticated account rather than the requested page owner', async () => {
  const { client } = harness([{ data: { user: { id: 42, login: 'someone-else' } } }]);
  await assert.rejects(client.initialize('test-user'), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(client.account, null);
});

test('missing identity and logged-out HTML stop initialization', async () => {
  for (const reply of [{ data: {} }, '<html>登录</html>']) {
    const { client } = harness([reply, '<html>登录</html>']);
    await assert.rejects(client.initialize('test-user'));
    assert.equal(client.account, null);
  }
});

function dashboard(me, extra = '') {
  const encoded = JSON.stringify(encodeURIComponent(JSON.stringify({ me })));
  return `<html><script>window.appData=JSON.parse(decodeURIComponent(${encoded}));${extra}</script></html>`;
}

test('an unsupported identity endpoint can use literal dashboard JSON without running scripts', async () => {
  const h = harness([{ status: 404, response: {} }, dashboard(mine.data, 'throw new Error("must not run");')]);
  const account = await h.client.initialize('test-user');
  assert.equal(account.id, 42);
  assert.equal(new URL(h.calls[1].url).pathname, '/dashboard');
  assert.equal(h.calls[1].headers.Accept, 'text/html');
});

test('dashboard fallback checks authenticated me, not a public page user', async () => {
  const encoded = JSON.stringify(encodeURIComponent(JSON.stringify({ user: mine.data })));
  const h = harness([{ data: {} }, `<script>JSON.parse(decodeURIComponent(${encoded}));</script>`]);
  await assert.rejects(h.client.initialize('test-user'), { code: 'AUTH_REQUIRED' });
});

test('dashboard identity rejects wrong accounts and executable expressions', async () => {
  const wrong = harness([{ data: {} }, dashboard({ id: 43, login: 'another' })]);
  await assert.rejects(wrong.client.initialize('test-user'), { code: 'ACCOUNT_MISMATCH' });
  const expression = harness([{ data: {} }, '<script>JSON.parse(decodeURIComponent(getIdentity()));</script>']);
  await assert.rejects(expression.client.initialize('test-user'), { code: 'AUTH_REQUIRED' });
});

test('auth and network failures do not probe alternate identity endpoints', async () => {
  for (const response of [{ status: 403, response: {} }, new Error('network')]) {
    const h = harness([response]);
    await assert.rejects(h.client.initialize('test-user'));
    assert.equal(h.calls.length, 1);
  }
});

test('owned books normalize URLs and shared books are not returned', async () => {
  const h = harness([mine, mine, { data: [
    { id: 10, slug: 'notebox-test', name: '测试知识库', user: { id: 42, login: 'test-user' } },
    { id: 11, slug: 'shared', name: '别人的知识库', user: { id: 43, login: 'another' } }
  ] }]);
  await h.client.initialize('test-user');
  const books = await h.client.listBooks();
  assert.equal(books.length, 1);
  assert.equal(books[0].url, book.url);
  assert.equal(h.calls[2].redirect, 'error');
  assert.equal(h.calls[2].credentials, 'include');
  assert.ok(!Object.keys(h.calls[2].headers).some(key => key.toLowerCase() === 'cookie'));
});

test('ambiguous book ownership fails closed', async () => {
  const h = harness([mine, mine, { data: [{ id: 10, slug: 'unknown-owner' }] }]);
  await h.client.initialize('test-user');
  await assert.rejects(h.client.listBooks(), { code: 'INCOMPATIBLE_RESPONSE' });
});

test('pagination follows a shorter server page when an explicit total remains', async () => {
  const h = harness([mine, mine,
    { meta: { total: 3 }, data: [{ id: 10, slug: 'a', user_id: 42 }] },
    { meta: { total: 3 }, data: [{ id: 11, slug: 'b', user_id: 42 }] },
    { meta: { total: 3 }, data: [{ id: 12, slug: 'c', user_id: 42 }] }
  ]);
  await h.client.initialize('test-user');
  assert.equal((await h.client.listBooks()).length, 3);
  assert.deepEqual(h.calls.slice(2).map(call => new URL(call.url).searchParams.get('offset')), ['0', '1', '2']);
});

test('empty pages cannot imply absence while an explicit total remains', async () => {
  const h = harness([mine, mine, { meta: { total: 2 }, data: [] }]);
  await h.client.initialize('test-user');
  await assert.rejects(h.client.listBooks(), { code: 'INCOMPATIBLE_RESPONSE' });
});

test('switching accounts cancels a mutation before upload', async () => {
  const h = harness([mine, { data: { id: 43, login: 'another' } }]);
  await h.client.initialize('test-user');
  await assert.rejects(h.client.createBook('测试', 'test-slug'), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
});

test('creation uses the supplied recoverable slug and private visibility', async () => {
  const h = harness([mine, mine, { data: { id: 10, slug: 'pending-slug', name: '测试', user_id: 42 } }]);
  await h.client.initialize('test-user');
  const created = await h.client.createBook('测试', 'pending-slug');
  const payload = JSON.parse(h.calls[2].body.toString());
  assert.equal(payload.slug, 'pending-slug');
  assert.equal(payload.public, 0);
  assert.equal(payload.user_id, 42);
  assert.equal(created.userId, 42);
  assert.deepEqual(h.cookieCalls, [{ url: 'https://www.yuque.com', name: 'yuque_ctoken' }]);
});

test('edit readback preserves native published and draft sources separately from HTML', async () => {
  const h = harness([mine, mine, { data: rawDoc }]);
  await h.client.initialize('test-user');
  const result = await h.client.readDoc(book, doc);
  assert.equal(result.body, html);
  assert.equal(result.body_draft, html);
  assert.equal(result.body_asl, lake);
  assert.equal(result.body_draft_asl, lake);
  assert.equal(result.format, 'lake');
  assert.equal(result.type, 'Doc');
  assert.equal(result.draft_version, 4);
  assert.equal(new URL(h.calls[2].url).searchParams.get('mode'), 'edit');
  assert.equal(new URL(h.calls[2].url).searchParams.get('merge_dynamic_data'), 'false');
  assert.equal(h.calls[2].headers.Referer, `${book.url}/note-test/edit`);
});

test('wrong or missing document book IDs cancel updates and deletes', async () => {
  for (const value of [{ ...rawDoc, book_id: 999 }, { ...rawDoc, book_id: undefined }]) {
    const h = harness([mine, mine, { data: value }]);
    await h.client.initialize('test-user');
    await assert.rejects(h.client.deleteDoc(book, doc));
    assert.equal(h.calls.some(call => call.method === 'DELETE'), false);
  }
});

test('legacy Markdown, tables, sheets, and unknown types cannot be updated', async () => {
  for (const changes of [{ format: 'markdown' }, { format: 'laketable' }, { format: 'lakesheet' }, { type: 'Sheet' }, { type: undefined }, { format: undefined }]) {
    const h = harness([mine, mine, { data: { ...rawDoc, ...changes } }]);
    await h.client.initialize('test-user');
    await assert.rejects(h.client.updateDoc(book, doc, '新版', prepared), { code: 'UNSUPPORTED_FORMAT' });
    assert.equal(h.calls.some(call => call.method === 'PUT' || call.method === 'POST'), false);
  }
});

test('prepareContent uses native server conversion and preserves its card IDs', async () => {
  const source = '# 第一版\n\n```js\nconst a = 1;\n```';
  const renderCalls = [];
  const h = harness([mine, mine, { data: { content: lake } }], { htmlRenderer: async value => { renderCalls.push(value); return html; } });
  await h.client.initialize('test-user');
  const content = await h.client.prepareContent(source);
  assert.deepEqual(content, { format: 'lake', body: lake, html });
  assert.equal(Object.isFrozen(content), true);
  assert.deepEqual(renderCalls, [source]);
  assert.equal(new URL(h.calls[2].url).pathname, '/api/docs/convert');
  assert.deepEqual(JSON.parse(h.calls[2].body.toString()), { content: source, from: 'markdown', to: 'lake' });
});

test('missing or failed local HTML rendering stops before any converter or document write', async () => {
  for (const renderer of [undefined, async () => { throw new Error('render failed'); }, async () => '<script>bad()</script>', async () => '']) {
    const h = harness([mine], { htmlRenderer: renderer });
    await h.client.initialize('test-user');
    await assert.rejects(h.client.createDoc(book, '测试笔记', 'note-test', '# 第一版'));
    assert.equal(h.calls.length, 1);
  }
});

test('conversion failures and HTML masquerading as Lake never create a document', async () => {
  for (const response of [{ status: 500, response: {} }, { success: false }, { data: {} }, { data: { content: html } }, { data: { content: '<!doctype lake><script>x()</script>' } }]) {
    const h = harness([mine, mine, response]);
    await h.client.initialize('test-user');
    await assert.rejects(h.client.createDoc(book, '测试笔记', 'note-test', '# 第一版'));
    assert.equal(h.calls.filter(call => new URL(call.url).pathname === '/api/docs').length, 0);
  }
});

test('native creation sends private Lake with matching HTML and verifies published canonical source', async () => {
  const h = harness([mine, mine, { data: { content: lake } }, mine, { data: rawDoc }, mine, { data: rawDoc }]);
  await h.client.initialize('test-user');
  const created = await h.client.createDoc(book, '测试笔记', 'note-test', '# 第一版');
  assert.equal(created.body_asl, lake);
  const call = h.calls.find(call => call.method === 'POST' && new URL(call.url).pathname === '/api/docs');
  assert.deepEqual(JSON.parse(call.body.toString()), {
    book_id: 10, title: '测试笔记', slug: 'note-test', type: 'Doc', format: 'lake',
    body: html, body_draft: html, body_asl: lake, body_draft_asl: lake,
    status: 1, public: 0, insert_to_catalog: true, action: 'prependChild', target_uuid: ''
  });
  assert.equal(h.calls.filter(call => new URL(call.url).pathname === '/api/docs/convert').length, 1);
});

test('creation refuses an unexpected format returned by the server', async () => {
  const h = harness([mine, mine, { data: { ...rawDoc, format: 'laketable' } }]);
  await h.client.initialize('test-user');
  await assert.rejects(h.client.createDoc(book, '测试笔记', 'note-test', { format: 'lake', body: lake, html }), { code: 'UNSUPPORTED_FORMAT' });
  assert.equal(h.calls.length, 3);
});

test('native update renames then saves with the current draft version then publishes and verifies', async () => {
  const updated = { ...rawDoc, title: '第二版', body: secondHtml, body_draft: secondHtml, body_asl: secondLake, body_draft_asl: secondLake, draft_version: 6 };
  const h = harness([mine, mine, { data: rawDoc }, mine, { data: { id: 20 } }, { data: { ...rawDoc, title: '第二版', draft_version: 5 } }, mine, { data: { id: 20, draft_version: 6 } }, mine, { data: { id: 20 } }, mine, { data: updated }]);
  await h.client.initialize('test-user');
  const { book_id, ...expectedDoc } = updated;
  assert.deepEqual(await h.client.updateDoc(book, doc, '第二版', prepared), { ...expectedDoc, bookId: 10, url: `${book.url}/note-test` });
  const writes = h.calls.filter(call => call.method === 'PUT');
  assert.deepEqual(writes.map(call => new URL(call.url).pathname), ['/api/docs/20/meta', '/api/docs/20/content', '/api/docs/20/publish']);
  assert.deepEqual(JSON.parse(writes[0].body.toString()), { title: '第二版' });
  assert.deepEqual(JSON.parse(writes[1].body.toString()), {
    body_asl: secondLake, body_html: secondHtml, created_by: 'online', draft_version: 5,
    edit_type: 'Lake', format: 'lake', save_type: 'user', sync_dynamic_data: false, target_uuid: null
  });
  assert.deepEqual(JSON.parse(writes[2].body.toString()), { cover: null, force: false, notify: false, ignoreGlobalMessage: true });
  assert.ok(h.calls.every((call, index) => call.method !== 'PUT' || new URL(h.calls[index - 1].url).pathname === '/api/mine'));
});

test('updating with source Markdown converts once and skips unchanged title metadata', async () => {
  const updated = { ...rawDoc, body_asl: secondLake, body_draft_asl: secondLake, draft_version: 5 };
  const h = harness([mine, mine, { data: rawDoc }, mine, { data: { content: secondLake } }, mine, { data: { id: 20, draft_version: 5 } }, mine, { data: { id: 20 } }, mine, { data: updated }], { htmlRenderer: async () => secondHtml });
  await h.client.initialize('test-user');
  assert.equal((await h.client.updateDoc(book, doc, '测试笔记', '# 第二版')).body_asl, secondLake);
  assert.equal(h.calls.filter(call => new URL(call.url).pathname.endsWith('/meta')).length, 0);
  assert.equal(h.calls.filter(call => new URL(call.url).pathname === '/api/docs/convert').length, 1);
});

test('an absent or noninteger draft version prevents all document writes', async () => {
  for (const version of [undefined, -1, 1.5, '4', Number.MAX_SAFE_INTEGER + 1]) {
    const h = harness([mine, mine, { data: { ...rawDoc, draft_version: version } }]);
    await h.client.initialize('test-user');
    await assert.rejects(h.client.updateDoc(book, doc, '测试笔记', prepared), { code: 'INCOMPATIBLE_RESPONSE' });
    assert.equal(h.calls.some(call => call.method === 'PUT'), false);
  }
});

test('a title or draft-save failure prevents later writes', async () => {
  const title = harness([mine, mine, { data: rawDoc }, mine, { success: false }]);
  await title.client.initialize('test-user');
  await assert.rejects(title.client.updateDoc(book, doc, '第二版', prepared));
  assert.deepEqual(title.calls.filter(call => call.method === 'PUT').map(call => new URL(call.url).pathname), ['/api/docs/20/meta']);
  for (const response of [{ success: false }, { data: { id: 999, draft_version: 5 } }, { data: { id: 20 } }]) {
    const h = harness([mine, mine, { data: rawDoc }, mine, response]);
    await h.client.initialize('test-user');
    await assert.rejects(h.client.updateDoc(book, doc, '测试笔记', prepared));
    assert.deepEqual(h.calls.filter(call => call.method === 'PUT').map(call => new URL(call.url).pathname), ['/api/docs/20/content']);
  }
});

test('rename readback validates its new title, format, and draft version before saving content', async () => {
  for (const changes of [{ title: '其他标题' }, { format: 'laketable', title: '第二版' }, { draft_version: undefined, title: '第二版' }]) {
    const h = harness([mine, mine, { data: rawDoc }, mine, { data: { id: 20 } }, { data: { ...rawDoc, ...changes } }]);
    await h.client.initialize('test-user');
    await assert.rejects(h.client.updateDoc(book, doc, '第二版', prepared));
    assert.deepEqual(h.calls.filter(call => call.method === 'PUT').map(call => new URL(call.url).pathname), ['/api/docs/20/meta']);
  }
});

test('publishing failure stops without retrying and never reports success', async () => {
  const h = harness([mine, mine, { data: rawDoc }, mine, { data: { id: 20, draft_version: 5 } }, mine, { success: false }]);
  await h.client.initialize('test-user');
  await assert.rejects(h.client.updateDoc(book, doc, '测试笔记', prepared), { code: 'API_ERROR' });
  assert.deepEqual(h.calls.filter(call => call.method === 'PUT').map(call => new URL(call.url).pathname), ['/api/docs/20/content', '/api/docs/20/publish']);
  assert.equal(h.queue.length, 0);
});

test('switching accounts between draft-save and publish prevents publishing', async () => {
  const h = harness([mine, mine, { data: rawDoc }, mine, { data: { id: 20, draft_version: 5 } }, { data: { id: 43, login: 'another' } }]);
  await h.client.initialize('test-user');
  await assert.rejects(h.client.updateDoc(book, doc, '测试笔记', prepared), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(h.calls.filter(call => new URL(call.url).pathname.endsWith('/publish')).length, 0);
  assert.equal(h.client.account, null);
});

test('only the exact published canonical Lake and expected title count as success', async () => {
  for (const changes of [
    { body_asl: lake, body_draft_asl: secondLake },
    { body_asl: secondLake.replace('server-card-2', 'different-card-id') },
    { body_asl: undefined, body_draft_asl: secondLake },
    { body_asl: secondLake, title: '其他标题' }
  ]) {
    const h = harness([mine, mine, { data: rawDoc }, mine, { data: { id: 20, draft_version: 5 } }, mine, { data: { id: 20 } }, mine, { data: { ...rawDoc, ...changes } }]);
    await h.client.initialize('test-user');
    await assert.rejects(h.client.updateDoc(book, doc, '测试笔记', prepared));
    assert.equal(h.calls.filter(call => call.method === 'PUT').length, 2);
  }
});

test('published canonical comparison permits only line endings and edge whitespace', async () => {
  const content = { format: 'lake', body: '<!doctype lake>\n<p id="fixed">第二版</p>', html: secondHtml };
  const h = harness([mine, mine, { data: rawDoc }, mine, { data: { id: 20, draft_version: 5 } }, mine, { data: { id: 20 } }, mine, { data: { ...rawDoc, body_asl: ` \r\n${content.body.replace(/\n/g, '\r\n')}\r\n ` } }]);
  await h.client.initialize('test-user');
  assert.equal((await h.client.updateDoc(book, doc, '测试笔记', content)).id, 20);
});

test('publish acknowledgments without an ID still require exact published readback', async () => {
  for (const response of [{}, { data: true }, { success: true }]) {
    const updated = { ...rawDoc, body_asl: secondLake, body_draft_asl: secondLake };
    const h = harness([mine, mine, { data: rawDoc }, mine, { data: { id: 20, draft_version: 5 } }, mine, response, mine, { data: updated }]);
    await h.client.initialize('test-user');
    assert.equal((await h.client.updateDoc(book, doc, '测试笔记', prepared)).body_asl, secondLake);
    const mismatch = harness([mine, mine, { data: rawDoc }, mine, { data: { id: 20, draft_version: 5 } }, mine, response, mine, { data: rawDoc }]);
    await mismatch.client.initialize('test-user');
    await assert.rejects(mismatch.client.updateDoc(book, doc, '测试笔记', prepared), { code: 'READBACK_MISMATCH' });
  }
});

test('an explicitly conflicting publish ID stops before success', async () => {
  const h = harness([mine, mine, { data: rawDoc }, mine, { data: { id: 20, draft_version: 5 } }, mine, { data: { id: 999 } }]);
  await h.client.initialize('test-user');
  await assert.rejects(h.client.updateDoc(book, doc, '测试笔记', prepared), { code: 'INCOMPATIBLE_RESPONSE' });
});

test('HTTP and HTTP-200 business errors stop mutations', async () => {
  const failures = [
    { status: 500, response: { error: 'secret diagnostic' } },
    { data: null, success: false },
    { data: false },
    { code: 403, message: 'private-csrf-value' },
    { status: 403, message: 'private-csrf-value' }
  ];
  for (const failure of failures) {
    const h = harness([mine, mine, { data: rawDoc }, failure]);
    await h.client.initialize('test-user');
    await assert.rejects(h.client.deleteDoc(book, doc), error => !error.message.includes('private-csrf-value') && !error.message.includes('secret diagnostic'));
  }
});

test('a successful DELETE must have a recognizable acknowledgment', async () => {
  const h = harness([mine, mine, { data: rawDoc }, {}]);
  await h.client.initialize('test-user');
  await assert.rejects(h.client.deleteDoc(book, doc), { code: 'INCOMPATIBLE_RESPONSE' });
});

test('attachment upload accepts Yuque CDN and does not log request tokens', async () => {
  const h = harness([mine, mine, { data: { url: 'https://cdn.nlark.com/yuque/0/2026/png/42/test.png' } }]);
  await h.client.initialize('test-user');
  const url = await h.client.uploadImage(Buffer.from([1, 2, 3]), 'test.png', 'image/png');
  assert.match(url, /^https:\/\/cdn\.nlark\.com\//);
  assert.match(h.calls[2].headers['Content-Type'], /^multipart\/form-data; boundary=/);
  assert.ok(h.calls[2].body.includes(Buffer.from([1, 2, 3])));
  assert.ok(h.logs.every(line => !line.includes('private-csrf-value')));
});

test('untrusted attachment URLs and missing CSRF tokens are rejected', async () => {
  for (const url of ['https://evil.test/file.png', 'http://cdn.nlark.com/a.png', 'https://cdn.nlark.com/a.png?ctoken=abc']) {
    const h = harness([mine, mine, { data: { url } }]);
    await h.client.initialize('test-user');
    await assert.rejects(h.client.uploadImage(Buffer.from([1]), 'test.png', 'image/png'));
  }
  const h = harness([mine, mine], { cookies: [] });
  await h.client.initialize('test-user');
  await assert.rejects(h.client.createBook('测试', 'test'), { code: 'AUTH_REQUIRED' });
  assert.equal(h.calls.length, 2);
});

test('Electron net transport uses the supplied session and aborts redirects', async () => {
  let options, request;
  const net = { request: value => {
    options = value;
    request = new EventEmitter();
    request.abort = () => {};
    request.end = () => queueMicrotask(() => request.emit('redirect', 302, 'GET', 'https://evil.test'));
    return request;
  } };
  const session = {};
  const client = new YuqueClient({ net, session });
  await assert.rejects(client.initialize('test-user'), { code: 'REDIRECT_BLOCKED' });
  assert.equal(options.session, session);
  assert.equal(options.useSessionCookies, true);
  assert.equal(options.redirect, 'error');
});
