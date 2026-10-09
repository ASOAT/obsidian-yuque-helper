'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { installLoginMain } = require('../login-main');

const USER_AGENT = 'Mozilla/5.0 Chrome/132.0.0.0 Safari/537.36';

class FakeSession extends EventEmitter {
  constructor() { super(); this.userAgent = USER_AGENT; }
  setUserAgent(value) { this.userAgent = value; }
  getUserAgent() { return this.userAgent; }
  setPermissionCheckHandler(value) { this.checkPermission = value; }
  setPermissionRequestHandler(value) { this.requestPermission = value; }
  setDevicePermissionHandler(value) { this.devicePermission = value; }
}

class FakeContents extends EventEmitter {
  constructor(session, overrides = {}) {
    super(); this.session = session; this.destroyed = false; this.currentUrl = 'about:blank';
    this.preferences = {
      session, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      contextIsolation: true, sandbox: true, webSecurity: true, ...overrides,
    };
  }
  getLastWebPreferences() { return this.preferences; }
  setUserAgent(value) { this.userAgent = value; }
  getUserAgent() { return this.userAgent || this.session.getUserAgent(); }
  setWindowOpenHandler(value) { this.openWindow = value; }
  getURL() { return this.currentUrl; }
  isLoading() { return false; }
  isDestroyed() { return this.destroyed; }
}

class FakeWindow extends EventEmitter {
  constructor(session, overrides) {
    super(); this.webContents = new FakeContents(session, overrides);
    this.destroyed = false; this.shown = 0; this.focused = 0; this.closed = 0;
  }
  removeMenu() { this.menuRemoved = true; }
  isDestroyed() { return this.destroyed; }
  show() { this.shown++; }
  focus() { this.focused++; }
  close() {
    if (this.destroyed) return;
    this.closed++; this.destroyed = true; this.webContents.destroyed = true; this.emit('closed');
  }
  destroy() { this.close(); }
}

function cancellable(url, isMainFrame = true) {
  return { url, isMainFrame, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}

function compileInstaller() {
  // A real @electron/remote renderer callback cannot synchronously cancel these
  // events. Running the serialized factory catches references to renderer scope.
  return vm.runInThisContext(`(${installLoginMain.toString()})`, { filename: 'notebox-login-main-test.js' });
}

function harness() {
  const session = new FakeSession();
  const window = new FakeWindow(session);
  let external = 0;
  const hostGuard = event => { external++; event.preventDefault(); };
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) window.webContents.on(name, hostGuard);
  const controller = compileInstaller()(window, session, USER_AGENT);
  return { session, window, controller, external: () => external };
}

test('main-process installer replaces inherited host guards before normal Yuque navigation', () => {
  const h = harness();
  for (const name of ['will-navigate', 'will-redirect']) {
    const event = cancellable('https://www.yuque.com/dashboard');
    h.window.webContents.emit(name, event, event.url);
    assert.equal(event.defaultPrevented, false);
  }
  const frame = cancellable('https://www.yuque.com/dashboard');
  h.window.webContents.emit('will-frame-navigate', frame, frame.url, false, true);
  assert.equal(frame.defaultPrevented, false);
  assert.equal(h.external(), 0);
});

test('foreign top-level HTTPS and custom-scheme navigation are synchronously blocked', () => {
  const h = harness();
  for (const url of ['https://example.com/login', 'yuque://login', 'http://www.yuque.com/login', 'https://www.yuque.com.evil.test/login']) {
    for (const name of ['will-navigate', 'will-redirect']) {
      const event = cancellable(url);
      h.window.webContents.emit(name, event, url);
      assert.equal(event.defaultPrevented, true, `${name}: ${url}`);
    }
  }
  assert.equal(h.external(), 0);
});

test('popup handler returns its verdict synchronously and retains a secure shared session', () => {
  const h = harness();
  for (const url of ['https://www.yuque.com/login', 'about:blank']) {
    const verdict = h.window.webContents.openWindow({ url, frameName: 'auth' });
    assert.equal(verdict.action, 'allow');
    assert.equal(typeof verdict.then, 'undefined');
    const preferences = verdict.overrideBrowserWindowOptions.webPreferences;
    assert.equal(preferences.session, h.session);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.webSecurity, true);
  }
  assert.equal(h.window.webContents.openWindow({ url: 'https://example.com/login' }).action, 'deny');
  assert.equal(h.window.webContents.openWindow({ url: 'yuque://login' }).action, 'deny');
});

test('child popup receives the same synchronous guards and inherited host handlers are removed', () => {
  const h = harness();
  const child = new FakeWindow(h.session);
  let external = 0;
  child.webContents.on('will-navigate', event => { external++; event.preventDefault(); });
  h.window.webContents.emit('did-create-window', child, { url: 'https://www.yuque.com/login' });
  const allowed = cancellable('https://www.yuque.com/dashboard');
  child.webContents.emit('will-navigate', allowed, allowed.url);
  assert.equal(allowed.defaultPrevented, false);
  assert.equal(external, 0);
  const denied = cancellable('https://example.com');
  child.webContents.emit('will-navigate', denied, denied.url);
  assert.equal(denied.defaultPrevented, true);
  assert.equal(child.webContents.userAgent, USER_AGENT);
  assert.equal(typeof child.webContents.openWindow, 'function');
});

test('owned-window removal leaves the main Obsidian window and its host guard untouched', () => {
  const session = new FakeSession();
  const obsidian = new FakeWindow(session);
  let intercepted = 0;
  const original = event => { intercepted++; event.preventDefault(); };
  obsidian.webContents.on('will-navigate', original);
  compileInstaller()(new FakeWindow(session), session, USER_AGENT);
  assert.equal(obsidian.webContents.listeners('will-navigate')[0], original);
  const event = cancellable('https://www.yuque.com');
  obsidian.webContents.emit('will-navigate', event, event.url);
  assert.equal(intercepted, 1);
  assert.equal(event.defaultPrevented, true);
});

test('third-party HTTPS CAPTCHA iframe may navigate while native-app iframe navigation is blocked', () => {
  const h = harness();
  const captcha = cancellable('https://captcha.example.test/challenge', false);
  h.window.webContents.emit('will-frame-navigate', captcha, captcha.url, false, false);
  assert.equal(captcha.defaultPrevented, false);
  const native = cancellable('yuque://login', false);
  h.window.webContents.emit('will-frame-navigate', native, native.url, false, false);
  assert.equal(native.defaultPrevented, true);
});

test('session downloads and permission checks are denied synchronously in main', () => {
  const h = harness();
  const event = cancellable('https://www.yuque.com/file');
  h.session.emit('will-download', event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.session.checkPermission(h.window.webContents, 'openExternal', 'https://www.yuque.com'), false);
  let result;
  h.session.requestPermission(h.window.webContents, 'camera', value => { result = value; });
  assert.equal(result, false);
});

test('Node-enabled window is rejected before its host navigation guard is removed', () => {
  const session = new FakeSession();
  const window = new FakeWindow(session, { nodeIntegration: true });
  const original = event => event.preventDefault();
  window.webContents.on('will-navigate', original);
  assert.throws(() => compileInstaller()(window, session, USER_AGENT));
  assert.equal(window.webContents.listeners('will-navigate')[0], original);
});

test('wrong-session window is rejected before its host navigation guard is removed', () => {
  const expectedSession = new FakeSession();
  const window = new FakeWindow(new FakeSession());
  const original = event => event.preventDefault();
  window.webContents.on('will-navigate', original);
  assert.throws(() => compileInstaller()(window, expectedSession, USER_AGENT));
  assert.equal(window.webContents.listeners('will-navigate')[0], original);
});

test('log draining exposes no navigation credential, path, query, or fragment', () => {
  const h = harness();
  const event = cancellable('https://example.com/SECRET_PATH?token=SECRET_QUERY#SECRET_FRAGMENT');
  h.window.webContents.emit('will-navigate', event, event.url);
  const text = JSON.stringify(h.controller.drainLogs());
  assert.equal(text.includes('SECRET_PATH'), false);
  assert.equal(text.includes('SECRET_QUERY'), false);
  assert.equal(text.includes('SECRET_FRAGMENT'), false);
  assert.deepEqual(h.controller.drainLogs(), []);
});

test('focus and close lifecycle covers every owned popup without closing unrelated windows', () => {
  const h = harness();
  const unrelated = new FakeWindow(h.session);
  const child = new FakeWindow(h.session);
  h.window.webContents.emit('did-create-window', child, { url: 'https://www.yuque.com/login' });
  assert.equal(h.controller.hasWindows(), true);
  assert.equal(h.controller.focus(), true);
  assert.ok(child.focused + h.window.focused > 0);
  h.controller.close();
  assert.equal(h.window.closed, 1);
  assert.equal(child.closed, 1);
  assert.equal(unrelated.closed, 0);
  assert.equal(h.controller.hasWindows(), false);
});
