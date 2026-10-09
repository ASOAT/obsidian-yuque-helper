'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderMarkdownHtml } = require('../html');

test('Chinese notes, lists and ordinary emphasis render as static HTML', () => {
  const html = renderMarkdownHtml('# 笔记\n\n正文 **加粗** 和 *斜体*。\n\n- 第一项\n- 第二项\n');
  assert.match(html, /<h1>笔记<\/h1>/);
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<ul>\n<li>第一项<\/li>\n<li>第二项<\/li>\n<\/ul>/);
});

test('raw HTML and scripts are escaped and never execute', () => {
  delete globalThis.__noteboxHtmlExecution;
  const source = '<script>globalThis.__noteboxHtmlExecution = 1</script>\n\n<img src="x" onerror="globalThis.__noteboxHtmlExecution=2">';
  const html = renderMarkdownHtml(source);
  assert.equal(globalThis.__noteboxHtmlExecution, undefined);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src="x"'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img'));
});

test('unsafe links and image protocols cannot produce executable HTML attributes', () => {
  const html = renderMarkdownHtml('[bad](javascript:alert(1)) ![bad](data:text/html;base64,PHNjcmlwdD4=) [file](file:///C:/private)');
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('href="file:'));
  assert.ok(!html.includes('src="data:text/html'));
  assert.ok(!html.includes('<script'));
});

test('fenced code preserves language and escapes its content', () => {
  const source = '```javascript\nconsole.log("<script>\" & x");\n```\n';
  const html = renderMarkdownHtml(source);
  assert.match(html, /<pre><code class="language-javascript">/);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&amp; x'));
  assert.ok(!html.includes('<script>'));
});

test('image labels, titles and URL attributes are safely escaped', () => {
  const html = renderMarkdownHtml('![a & "b"](<https://cdn.example.com/a.png?x=1&y=2> "a & \\\"title\\\"")\n\n[site](https://example.com "safe")');
  assert.match(html, /<img src="https:\/\/cdn\.example\.com\/a\.png\?x=1&amp;y=2"/);
  assert.ok(html.includes('alt="a &amp; &quot;b&quot;"'));
  assert.ok(html.includes('title="a &amp; &quot;title&quot;"'));
  assert.ok(html.includes('<a href="https://example.com" title="safe">site</a>'));
});

test('tables retain cell content, structure and alignment', () => {
  const html = renderMarkdownHtml('| 左 | 右 |\n| :--- | ---: |\n| 一 | **二** |');
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<thead>'));
  assert.ok(html.includes('<tbody>'));
  assert.ok(html.includes('<th style="text-align:left">左</th>'));
  assert.ok(html.includes('<td style="text-align:right"><strong>二</strong></td>'));
});

test('inline and block formula source retains LaTeX, underscores and dollar delimiters', () => {
  const inline = '$x_i + y_j + \\frac{a}{b} + \\,$';
  const block = '$$\n\\int_0^1 x\\,dx=1/2\n$$';
  const html = renderMarkdownHtml('公式：' + inline + '\n\n' + block);
  assert.ok(html.includes('>' + inline + '</span>'));
  assert.ok(html.includes('>' + block + '</div>'));
  assert.ok(!html.includes('<em>'));
  assert.ok(!html.includes('<strong>'));
});

test('formula contents are escaped even when they contain HTML-looking text', () => {
  const html = renderMarkdownHtml('$x < y & \\text{<script>} $\n\n$$<img src=x onerror=alert(1)>$$');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('x &lt; y &amp;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('indented and quoted block formulas retain their closing delimiters', () => {
  const indented = renderMarkdownHtml('  $$\nx_i + y_j\n  $$');
  assert.ok(indented.includes('>  $$\nx_i + y_j\n  $$</div>'));
  const quoted = renderMarkdownHtml('> $$\n> \\frac{a}{b}\n> $$');
  assert.ok(quoted.includes('<blockquote>'));
  assert.ok(quoted.includes('>$$\n\\frac{a}{b}\n$$</div>'));
});

test('dollar expressions in code remain code and Dataview JS stays inert', () => {
  delete globalThis.__noteboxDataviewExecution;
  const source = '`$x_i$`\n\n```dataviewjs\nglobalThis.__noteboxDataviewExecution = 1;\nconst formula = "$x_i$";\n```';
  const html = renderMarkdownHtml(source);
  assert.equal(globalThis.__noteboxDataviewExecution, undefined);
  assert.ok(html.includes('<code>$x_i$</code>'));
  assert.ok(html.includes('class="language-dataviewjs"'));
  assert.ok(!html.includes('notebox-math-source'));
});

test('unmatched and escaped dollar delimiters retain readable literal text', () => {
  const html = renderMarkdownHtml('Cost $10\n\n\\$literal\\$');
  assert.ok(html.includes('Cost $10'));
  assert.ok(html.includes('$literal$'));
  assert.ok(!html.includes('notebox-math-source'));
});

test('vendored browser build works in CommonJS with no DOM or browser globals', () => {
  const source = fs.readFileSync(path.join(__dirname, '../vendor/markdown-it.js'), 'utf8');
  assert.match(source.slice(0, 100), /markdown-it 14\.1\.0/);
  const context = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(source, context, { timeout: 3000 });
  const parser = new context.module.exports({ html: false });
  assert.equal(parser.render('# safe'), '<h1>safe</h1>\n');
});

test('renderer rejects non-text input rather than coercing a custom executable object', () => {
  assert.throws(() => renderMarkdownHtml({ toString() { assert.fail('must not call untrusted coercion'); } }), TypeError);
});

test('empty Markdown still supplies a valid blank HTML cache for native documents', () => {
  assert.equal(renderMarkdownHtml(''), '<p></p>\n');
  assert.equal(renderMarkdownHtml('\n \n'), '<p></p>\n');
});
