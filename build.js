'use strict';
// Bundle the plugin and all required notices into the one file Obsidian loads.
const fs = require('node:fs');
const path = require('node:path');
const ids = ['entry', 'engine', 'sync', 'markdown', 'yuque', 'login', 'login-main',
  'request', 'request-main', 'html', 'vendor/markdown-it'];
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
const notices = ['LICENSE', 'THIRD_PARTY_NOTICES.md'].map(name =>
  fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n\n').replace(/\*\//g, '* /');
const modules = ids.map(id => `${JSON.stringify('./' + id)}: function(module, exports, require) {\n${fs.readFileSync(path.join(__dirname, id + '.js'), 'utf8')}\n}`).join(',\n');
const bundle = `/*! ${manifest.name} ${manifest.version}\n${notices}\n*/\nconst __nativeRequire = require;\nconst __factories = {\n${modules}\n};\nconst __cache = {};\nfunction __load(id) {\n if (!__factories[id]) return __nativeRequire(id);\n if (__cache[id]) return __cache[id].exports;\n const m = {exports: {}}; __cache[id] = m;\n __factories[id](m, m.exports, __load); return m.exports;\n}\nmodule.exports = __load('./entry');\n`;
fs.writeFileSync(path.join(__dirname, 'main.js'), bundle);
console.log(`Built ${manifest.name} ${manifest.version} (${Buffer.byteLength(bundle)} bytes)`);
