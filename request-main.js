'use strict';

// Compile this function's source in Electron's main context, then bind the
// plugin's isolated session. No response stream or callback crosses remote.
function installRequestMain(session, net) {
  const pending = new Set();
  const origin = 'https://www.yuque.com';
  const maxResponseBytes = 12 * 1024 * 1024;
  let closed = false;

  function failure(code) {
    const messages = {
      INVALID_REQUEST: '请求参数无效。',
      NETWORK_ERROR: '网络请求或响应中断。',
      REDIRECT_BLOCKED: '请求发生重定向，已停止发送。',
      RESPONSE_TOO_LARGE: '响应超过大小限制。',
      TIMEOUT: '请求超时。',
      CLOSED: '请求连接已关闭。'
    };
    return { error: { code, message: messages[code] || messages.NETWORK_ERROR } };
  }

  function parseOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return null;
    const method = options.method || 'GET';
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method) || typeof options.url !== 'string') return null;
    let url;
    try { url = new URL(options.url); } catch (_) { return null; }
    if (url.origin !== origin || url.protocol !== 'https:' || url.hostname !== 'www.yuque.com' ||
        url.username || url.password || (url.port && url.port !== '443') || url.hash ||
        !(url.pathname.startsWith('/api/') || (method === 'GET' && url.pathname === '/dashboard' && !url.search))) return null;

    const headers = {};
    const seen = new Set();
    const suppliedHeaders = options.headers || {};
    if (typeof suppliedHeaders !== 'object' || Array.isArray(suppliedHeaders)) return null;
    for (const name of Object.keys(suppliedHeaders)) {
      const value = suppliedHeaders[name];
      const key = name.toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== 'string' ||
          /[\x00-\x1f\x7f]/.test(value) || value.length > 32768 || seen.has(key) ||
          ['cookie', 'cookie2', 'authorization', 'proxy-authorization', 'set-cookie', 'host', 'content-length'].includes(key)) return null;
      if (key === 'origin' && value !== origin) return null;
      if (key === 'referer') {
        let ref;
        try { ref = new URL(value); } catch (_) { return null; }
        if (ref.origin !== origin || ref.username || ref.password) return null;
      }
      seen.add(key);
      headers[name] = value;
    }

    let body;
    if (options.body !== undefined && options.body !== null) {
      if (method === 'GET') return null;
      if (typeof options.body === 'string') body = Buffer.from(options.body, 'utf8');
      else if (Buffer.isBuffer(options.body) || ArrayBuffer.isView(options.body)) {
        const view = options.body;
        body = Buffer.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      } else if (options.body instanceof ArrayBuffer) body = Buffer.from(new Uint8Array(options.body));
      else return null;
    }
    const requestedTimeout = Number(options.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(30000, Math.max(1, Math.floor(requestedTimeout))) : 30000;
    return { url: url.href, method, headers, body, timeoutMs };
  }

  function request(options) {
    return new Promise(resolve => {
      if (closed) { resolve(failure('CLOSED')); return; }
      let parsed;
      try { parsed = parseOptions(options); } catch (_) { parsed = null; }
      if (!parsed) { resolve(failure('INVALID_REQUEST')); return; }
      let active, timer, settled = false;
      const entry = { stop };
      pending.add(entry);

      function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(entry);
        resolve(result);
      }
      function stop(code) {
        if (settled) return;
        finish(failure(code));
        try { if (active) active.abort(); } catch (_) { /* Outcome already resolved. */ }
      }

      try {
        active = net.request({
          url: parsed.url, method: parsed.method, headers: parsed.headers,
          session, useSessionCookies: true, redirect: 'error'
        });
        timer = setTimeout(() => stop('TIMEOUT'), parsed.timeoutMs);
        active.on('error', error => {
          // With redirect:'error', Electron aborts before emitting 'redirect'.
          // Recognize only its fixed error; never return arbitrary native text.
          const isRedirect = error && error.message === "Attempted to redirect, but redirect policy was 'error'";
          stop(isRedirect ? 'REDIRECT_BLOCKED' : 'NETWORK_ERROR');
        });
        active.on('abort', () => stop('NETWORK_ERROR'));
        active.on('close', () => {
          // Recent Electron releases can auto-close the Writable upload side
          // before the independent network response has arrived.
          if (!settled && active.writableFinished !== true) stop('NETWORK_ERROR');
        });
        active.on('redirect', () => stop('REDIRECT_BLOCKED'));
        active.on('login', (_info, callback) => {
          try { callback(); } catch (_) { stop('NETWORK_ERROR'); }
        });
        active.on('response', response => {
          if (settled) return;
          const status = response.statusCode;
          if (!Number.isInteger(status) || status < 100 || status > 599) { stop('NETWORK_ERROR'); return; }
          const chunks = [];
          let size = 0;
          // Electron explicitly requires 'end' to be installed before 'data'.
          // Cached responses may flush completely when the data listener is added.
          response.on('end', () => {
            if (settled) return;
            try { finish({ status, text: Buffer.concat(chunks).toString('utf8') }); }
            catch (_) { stop('NETWORK_ERROR'); }
          });
          response.on('error', () => stop('NETWORK_ERROR'));
          response.on('aborted', () => stop('NETWORK_ERROR'));
          response.on('close', () => { if (!settled) stop('NETWORK_ERROR'); });
          response.on('data', chunk => {
            if (settled) return;
            try {
              const buffer = Buffer.from(chunk);
              size += buffer.length;
              if (size > maxResponseBytes) { stop('RESPONSE_TOO_LARGE'); return; }
              chunks.push(buffer);
            } catch (_) { stop('NETWORK_ERROR'); }
          });
        });
        if (parsed.body === undefined) active.end();
        else active.end(parsed.body);
      } catch (_) { stop('NETWORK_ERROR'); }
    });
  }

  function close() {
    closed = true;
    for (const entry of [...pending]) entry.stop('CLOSED');
  }

  return { request, close };
}

module.exports = { installRequestMain };
