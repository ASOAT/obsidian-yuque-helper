'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { convertMarkdown } = require('../markdown');

const doc = name => ({ url: `https://www.yuque.com/test/book/${encodeURIComponent(name)}`, kind: 'note' });

test('multiple wikilinks become document links, and headings do not invent anchors', async () => {
  const targets = [];
  const result = await convertMarkdown('[[A]] / [[B#标题|别名]] / [[#本页标题]] / [[B#^block|段落]]', {
    sourcePath: '01Notes/current.md',
    resolveLink: target => { targets.push(target); return doc(target); }
  });
  assert.deepEqual(targets, ['A', 'B', '01Notes/current.md', 'B']);
  assert.match(result.markdown, /^\[A\]\(<https:\/\/www\.yuque\.com\/test\/book\/A>\)/);
  assert.match(result.markdown, /\[别名\]\(<https:\/\/www\.yuque\.com\/test\/book\/B>\)/);
  assert.equal(result.markdown.includes('#标题'), false);
  assert.equal(result.warnings.length, 3);
});

test('code fences, inline code, escaped wikilinks and math are preserved without resolution', async () => {
  const source = '\\[[Literal]]\n`[[Inline]] %%kept%%` and ``![[double`tick.png]]``\n' +
    '$[[math]]$\n$$\n![[math.png]] + \\int_0^1 x dx\n$$\n' +
    '```markdown\n[[Fence]]\n![[fence.png]]\n%%keep%%\n```\n' +
    '~~~js\n[[tilde]]\n~~~\n';
  const result = await convertMarkdown(source, {
    resolveLink: () => { assert.fail('literal code must not be resolved'); },
    resolveImage: () => { assert.fail('literal images must not be uploaded'); }
  });
  assert.equal(result.markdown, source);
  assert.deepEqual(result.warnings, []);
});

test('leading YAML and comments are removed while code comments survive', async () => {
  const source = '\uFEFF---\r\ntags: [x]\r\n---\r\n正文 %%private\ncomment%% 保留\n`%%code%%`';
  const result = await convertMarkdown(source);
  assert.equal(result.markdown, '正文  保留\n`%%code%%`');
  assert.equal((await convertMarkdown('---\n# No closing YAML')).markdown, '---\n# No closing YAML');
  assert.equal((await convertMarkdown('# Title\n---\nText')).markdown, '# Title\n---\nText');
});

test('wiki and inline local images upload, remote and data images never upload', async () => {
  const images = [];
  const source = '![[image.png|320]] ![caption](../img/photo%20one(1).png "a title") ' +
    '![web](https://example.com/a.png) ![data](data:image/png;base64,AAAA)';
  const result = await convertMarkdown(source, {
    resolveImage: async target => { images.push(target); return { url: 'https://cdn.example.com/' + encodeURIComponent(target) }; }
  });
  assert.deepEqual(images, ['image.png', '../img/photo one(1).png']);
  assert.match(result.markdown, /!\[image\.png\]\(<https:\/\/cdn\.example\.com\/image\.png>\)/);
  assert.match(result.markdown, /!\[caption\]\(<https:\/\/cdn\.example\.com\/.*> "a title"\)/);
  assert.ok(result.markdown.endsWith('![web](https://example.com/a.png) ![data](data:image/png;base64,AAAA)'));
  assert.deepEqual(result.warnings, []);
});

test('angle destinations and escaped delimiters resolve without corrupting labels', async () => {
  const paths = [];
  const result = await convertMarkdown('[label [nested]](<../note one.md#Section> "title") ![a\\]b](pic\\(one\\).png)', {
    resolveLink: path => { paths.push(path); return doc('note'); },
    resolveImage: async path => { paths.push(path); return { url: 'https://cdn.example.com/pic(one).png' }; }
  });
  assert.deepEqual(paths, ['../note one.md', 'pic(one).png']);
  assert.equal(result.markdown, '[label [nested]](<https://www.yuque.com/test/book/note> "title") ![a\\]b](<https://cdn.example.com/pic(one).png>)');
  assert.equal(result.warnings.length, 1);
});

test('ordinary local note links resolve; external schemes stay untouched', async () => {
  const paths = [];
  const result = await convertMarkdown('[note](./A%20B.md) [self](#Heading) [site](https://example.com) [mail](mailto:x@example.com)', {
    sourcePath: '02Projects/current.md',
    resolveLink: target => { paths.push(target); return doc(target); }
  });
  assert.deepEqual(paths, ['./A B.md', '02Projects/current.md']);
  assert.ok(result.markdown.includes('[site](https://example.com) [mail](mailto:x@example.com)'));
  assert.equal(result.warnings.length, 1);
});

test('note embeds become static links with an explicit warning', async () => {
  const result = await convertMarkdown('![[Other Note#Heading|引用]]', {
    resolveImage: async () => null,
    resolveLink: target => { assert.equal(target, 'Other Note'); return doc('other'); }
  });
  assert.equal(result.markdown, '[引用](<https://www.yuque.com/test/book/other>)');
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.some(message => message.includes('未展开')));
});

test('unresolved notes remain readable and aliases cannot inject a new link', async () => {
  const result = await convertMarkdown('[[Missing|a\\]b]] and [normal](missing.md)', { resolveLink: () => null });
  assert.equal(result.markdown, 'a\\]b and normal');
  assert.equal(result.warnings.length, 2);
});

test('attachment upload failures propagate so caller cannot mark a partial upload successful', async () => {
  await assert.rejects(convertMarkdown('![[missing.png]]', {
    resolveImage: async () => { throw new Error('Image not found'); }
  }), /Image not found/);
});

test('Dataview is retained visibly as source code with a warning', async () => {
  const source = '```dataview\nTABLE file.name\nFROM "01Notes"\n```\n```dataviewjs\ndv.pages();\n```';
  const result = await convertMarkdown(source);
  assert.equal(result.markdown, source);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /不会运行/);
});

test('code in link labels survives while the link destination is converted', async () => {
  const result = await convertMarkdown('[`code ]` label](note.md)', { resolveLink: () => doc('note') });
  assert.equal(result.markdown, '[`code ]` label](<https://www.yuque.com/test/book/note>)');
});

test('unterminated fences are protected, malformed links are left untouched', async () => {
  const source = 'Broken [text](unclosed\n```js\n[[literal]]\n![[literal.png]]';
  const result = await convertMarkdown(source, {
    resolveLink: () => { assert.fail('malformed input must remain literal'); },
    resolveImage: () => { assert.fail('unterminated fence must stay code'); }
  });
  assert.equal(result.markdown, source);
});

test('returned destinations cannot inject angle brackets, newlines or unsafe schemes', async () => {
  const good = await convertMarkdown('[[A|safe]]', { resolveLink: () => ({ url: 'https://example.com/a<b>c' }) });
  assert.equal(good.markdown, '[safe](<https://example.com/a%3Cb%3Ec>)');
  for (const url of ['javascript:alert(1)', 'https://example.com\nnext']) {
    const result = await convertMarkdown('[[A]]', { resolveLink: () => ({ url }) });
    assert.equal(result.markdown, 'A');
    assert.equal(result.warnings.length, 1);
  }
});

test('full, collapsed and shortcut reference images resolve through their definitions', async () => {
  const images = [];
  const source = '![first][PIC] ![pic][] ![pic]\n\n[pic]: <../photo one.png> "Picture"\n';
  const result = await convertMarkdown(source, {
    resolveImage: async path => { images.push(path); return { url: 'https://cdn.example.com/photo.png' }; }
  });
  assert.deepEqual(images, ['../photo one.png', '../photo one.png', '../photo one.png']);
  assert.equal(result.markdown.split('https://cdn.example.com/photo.png').length - 1, 3);
  assert.match(result.markdown, /!\[first\]\(<https:\/\/cdn\.example\.com\/photo\.png> "Picture"\)/);
  assert.deepEqual(result.warnings, []);
});

test('reference note links resolve and remote references keep their source', async () => {
  const source = '[Local][note] ![Remote][web]\n\n[note]: A.md#Heading\n[web]: https://example.com/img.png\n';
  const result = await convertMarkdown(source, {
    resolveLink: target => { assert.equal(target, 'A.md'); return doc('A'); },
    resolveImage: () => { assert.fail('remote reference images must not upload'); }
  });
  assert.ok(result.markdown.startsWith('[Local](<https://www.yuque.com/test/book/A>) ![Remote][web]'));
  assert.equal(result.warnings.length, 1);
});

test('definitions inside code/comments cannot turn ordinary brackets into a link', async () => {
  const source = '[ref]\n```markdown\n[ref]: missing.md\n```\n%%\n[ref]: hidden.md\n%%\n';
  const result = await convertMarkdown(source, {
    resolveLink: () => { assert.fail('hidden reference definitions must not be used'); }
  });
  assert.equal(result.markdown, '[ref]\n```markdown\n[ref]: missing.md\n```\n\n');
});
