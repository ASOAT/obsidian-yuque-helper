'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { installRequestMain } = require('../request-main');

const url = 'https://www.yuque.com/api/mine';
function harness(onEnd) {
  const session = {}, calls = [];
  const net = { request(options) {
    const active = new EventEmitter();
    const call = { options, active, aborted: 0, endArgs: null };
    calls.push(call);
    active.abort = () => { call.aborted++; active.emit('abort'); active.emit('close'); };
    active.end = (...args) => { call.endArgs = args; if (onEnd) onEnd(active, call); };
    return active;
  } };
  return { session, net, calls, bridge: installRequestMain(session, net) };
}
function response(status = 200) {
  const incoming = new EventEmitter();
  incoming.statusCode = status;
  return incoming;
}

test('the installer compiles in an isolated main context without module closures', async () => {
  const install = vm.runInNewContext(`(${installRequestMain.toString()})`, { Buffer, URL, setTimeout, clearTimeout });
  const h = harness(active => {
    const incoming = response();
    active.emit('response', incoming);
    incoming.emit('data', Buffer.from('{"data":{"id":42}}'));
    incoming.emit('end');
  });
  const bridge = install(h.session, h.net);
  const result = await bridge.request({ url });
  assert.equal(result.status, 200);
  assert.equal(result.text, '{"data":{"id":42}}');
  bridge.close();
});

test('an immediately flushed cached response cannot lose its end event', async () => {
  const h = harness(active => {
    const incoming = response();
    const registrations = [];
    const baseOn = incoming.on;
    incoming.on = function(name, listener) {
      registrations.push(name);
      baseOn.call(this, name, listener);
      if (name === 'data') { this.emit('data', Buffer.from('fast')); this.emit('end'); }
      return this;
    };
    active.emit('response', incoming);
    assert.ok(registrations.indexOf('end') < registrations.indexOf('data'));
  });
  assert.deepEqual(await h.bridge.request({ url }), { status: 200, text: 'fast' });
  assert.equal(h.calls[0].endArgs.length, 0);
});

test('delayed multi-chunk Unicode responses preserve their bytes and session', async () => {
  const h = harness(active => {
    setTimeout(() => {
      const incoming = response(201);
      const bytes = Buffer.from('中文与图片');
      active.emit('response', incoming);
      incoming.emit('data', bytes.subarray(0, 2));
      incoming.emit('data', bytes.subarray(2));
      incoming.emit('end');
      active.emit('close');
    }, 3);
  });
  assert.deepEqual(await h.bridge.request({ url, timeoutMs: 100 }), { status: 201, text: '中文与图片' });
  assert.equal(h.calls[0].options.session, h.session);
  assert.equal(h.calls[0].options.useSessionCookies, true);
  assert.equal(h.calls[0].options.redirect, 'error');
});

test('completed upload-side close does not discard a later network response', async () => {
  const h = harness(active => {
    active.writableFinished = true;
    active.emit('close');
    setTimeout(() => {
      const incoming = response(); active.emit('response', incoming);
      incoming.emit('data', Buffer.from('late response')); incoming.emit('end');
    }, 3);
  });
  assert.deepEqual(await h.bridge.request({ url, timeoutMs: 100 }), { status: 200, text: 'late response' });
  assert.equal(h.calls[0].aborted, 0);
});

test('a closed upload with no network outcome remains bounded by the timeout', async () => {
  const h = harness(active => { active.writableFinished = true; active.emit('close'); });
  assert.equal((await h.bridge.request({ url, timeoutMs: 5 })).error.code, 'TIMEOUT');
});

test('Buffer, typed-array, and string request bodies reach net as independent buffers', async () => {
  for (const body of [Buffer.from('payload'), new Uint8Array([1, 2, 3]), '正文']) {
    const h = harness(active => {
      const incoming = response(204);
      active.emit('response', incoming); incoming.emit('end');
    });
    await h.bridge.request({ url: 'https://www.yuque.com/api/docs', method: 'POST', body });
    const sent = h.calls[0].endArgs[0];
    assert.ok(Buffer.isBuffer(sent));
    assert.notEqual(sent, body);
    assert.deepEqual(sent, Buffer.from(body));
  }
});

test('redirects abort without following or returning the private URL', async () => {
  const h = harness(active => active.emit('redirect', 302, 'GET', 'https://elsewhere.test/?token=secret'));
  const result = await h.bridge.request({ url: url + '?ctoken=secret' });
  assert.equal(result.error.code, 'REDIRECT_BLOCKED');
  assert.equal(h.calls[0].aborted, 1);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('Electron redirect:error failures produce a sanitized redirect outcome', async () => {
  const h = harness(active => active.emit('error', new Error("Attempted to redirect, but redirect policy was 'error'")));
  assert.equal((await h.bridge.request({ url })).error.code, 'REDIRECT_BLOCKED');
  assert.equal(h.calls[0].aborted, 1);
});

test('request failures, early closes, aborted bodies, and response errors always resolve', async () => {
  const behaviors = [
    active => active.emit('error', new Error('secret network details')),
    active => active.emit('close'),
    active => { const incoming = response(); active.emit('response', incoming); incoming.emit('aborted'); },
    active => { const incoming = response(); active.emit('response', incoming); incoming.emit('error', new Error('secret response')); },
    active => { const incoming = response(); active.emit('response', incoming); incoming.emit('close'); }
  ];
  for (const behavior of behaviors) {
    const h = harness(behavior);
    const result = await h.bridge.request({ url, timeoutMs: 100 });
    assert.equal(result.error.code, 'NETWORK_ERROR');
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('timeout aborts outstanding requests and returns a plain error envelope', async () => {
  const h = harness();
  const result = await h.bridge.request({ url, timeoutMs: 5 });
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal(h.calls[0].aborted, 1);
});

test('responses above 12 MiB stop before retaining the oversized chunk', async () => {
  const h = harness(active => {
    const incoming = response(); active.emit('response', incoming);
    incoming.emit('data', Buffer.alloc(12 * 1024 * 1024));
    incoming.emit('data', Buffer.from([1]));
    incoming.emit('end');
  });
  const result = await h.bridge.request({ url });
  assert.equal(result.error.code, 'RESPONSE_TOO_LARGE');
  assert.equal(h.calls[0].aborted, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'text'));
});

test('only the bound Yuque API and exact GET dashboard can be requested', async () => {
  const bad = [
    { url: 'http://www.yuque.com/api/mine' },
    { url: 'https://yuque.com/api/mine' },
    { url: 'https://www.yuque.com.evil.test/api/mine' },
    { url: 'https://user:secret@www.yuque.com/api/mine' },
    { url: 'https://www.yuque.com:444/api/mine' },
    { url: 'https://www.yuque.com/login' },
    { url: 'https://www.yuque.com/dashboard?token=secret' },
    { url: 'https://www.yuque.com/dashboard', method: 'POST' },
    { url, method: 'PATCH' },
    { url, body: 'GET must be bodyless' }
  ];
  const h = harness();
  for (const options of bad) assert.equal((await h.bridge.request(options)).error.code, 'INVALID_REQUEST');
  assert.equal(h.calls.length, 0);
  const valid = harness(active => { const incoming = response(); active.emit('response', incoming); incoming.emit('end'); });
  assert.equal((await valid.bridge.request({ url: 'https://www.yuque.com/dashboard' })).status, 200);
});

test('header injection, manual auth, wrong origin, and duplicate names are refused', async () => {
  const h = harness();
  for (const headers of [
    { Accept: 'text/html\r\nCookie: secret' },
    { 'Bad\nName': 'a' },
    { Cookie: 'secret' },
    { Authorization: 'secret' },
    { Host: 'evil.test' },
    { Origin: 'https://evil.test' },
    { Referer: 'https://evil.test/' },
    { Accept: 'a', accept: 'b' }
  ]) assert.equal((await h.bridge.request({ url, headers })).error.code, 'INVALID_REQUEST');
  assert.equal(h.calls.length, 0);
});

test('HTTP errors retain only the status and body for the higher-level API parser', async () => {
  const h = harness(active => { const incoming = response(403); active.emit('response', incoming); incoming.emit('data', Buffer.from('{"code":403}')); incoming.emit('end'); });
  assert.deepEqual(await h.bridge.request({ url }), { status: 403, text: '{"code":403}' });
});

test('close aborts every pending request and permanently closes the bridge', async () => {
  const h = harness();
  const first = h.bridge.request({ url, timeoutMs: 5000 });
  const second = h.bridge.request({ url, timeoutMs: 5000 });
  h.bridge.close(); h.bridge.close();
  assert.equal((await first).error.code, 'CLOSED');
  assert.equal((await second).error.code, 'CLOSED');
  assert.deepEqual(h.calls.map(call => call.aborted), [1, 1]);
  assert.equal((await h.bridge.request({ url })).error.code, 'CLOSED');
  assert.equal(h.calls.length, 2);
});

test('HTTP authentication callbacks are cancelled without supplying credentials', async () => {
  let credentialArgs;
  const h = harness(active => {
    active.emit('login', { host: 'proxy' }, (...args) => { credentialArgs = args; });
    active.emit('error', new Error('authentication unavailable'));
  });
  assert.equal((await h.bridge.request({ url })).error.code, 'NETWORK_ERROR');
  assert.deepEqual(credentialArgs, []);
});
