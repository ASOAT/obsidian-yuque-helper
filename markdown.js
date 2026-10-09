'use strict';

// This converter intentionally leaves Markdown code and math as source text.
// Path resolution and attachment uploads belong to the caller (the vault adapter).
function escaped(text, index) {
  let count = 0;
  while (index > 0 && text[--index] === '\\') count++;
  return count % 2 === 1;
}

function unescapeMarkdown(text) {
  return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

function decodeDestination(text) {
  const value = unescapeMarkdown(text);
  try { return decodeURIComponent(value); } catch { return value; }
}

function splitAnchor(target) {
  const index = target.indexOf('#');
  return index < 0
    ? { path: target, anchor: '' }
    : { path: target.slice(0, index), anchor: target.slice(index + 1) };
}

function escapeLabel(text) {
  return String(text).replace(/[\\\[\]]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

function destination(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || /[\r\n\u0000-\u001f]/.test(url)) return null;
  return '<' + url.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\\/g, '%5C') + '>';
}

function external(target) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target);
}

function frontmatter(source) {
  const opening = /^(?:\uFEFF)?---[ \t]*(?:\r?\n)/.exec(source);
  if (!opening) return source;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const match = closing.exec(source);
  return match ? source.slice(match.index + match[0].length) : source;
}

function fenceAt(source, index) {
  if (index > 0 && source[index - 1] !== '\n') return null;
  const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/.exec(source.slice(index));
  if (!opening || (opening[1][0] === '`' && opening[2].includes('`'))) return null;
  const character = opening[1][0];
  const length = opening[1].length;
  let cursor = index + opening[0].length;
  while (cursor < source.length) {
    const newline = source.indexOf('\n', cursor);
    const end = newline < 0 ? source.length : newline + 1;
    const line = source.slice(cursor, end).replace(/\r?\n$/, '');
    const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
    if (close && close[1][0] === character && close[1].length >= length) {
      return { end, info: opening[2].trim() };
    }
    cursor = end;
  }
  return { end: source.length, info: opening[2].trim() };
}

function delimitedAt(source, index, character, allowedLengths) {
  if (source[index] !== character || escaped(source, index)) return null;
  let length = 1;
  while (source[index + length] === character) length++;
  if (allowedLengths && !allowedLengths.includes(length)) return null;
  let cursor = index + length;
  while (cursor < source.length) {
    const match = source.indexOf(character, cursor);
    if (match < 0) return null;
    let run = 1;
    while (source[match + run] === character) run++;
    if (run === length && (character === '`' || !escaped(source, match))) return match + run;
    cursor = match + run;
  }
  return null;
}

function wikiAt(source, index) {
  const image = source[index] === '!';
  const start = index + (image ? 1 : 0);
  if (source.slice(start, start + 2) !== '[[' || escaped(source, index)) return null;
  for (let cursor = start + 2; cursor < source.length - 1; cursor++) {
    if (source[cursor] === '\n') return null;
    if (source.slice(cursor, cursor + 2) !== ']]' || escaped(source, cursor)) continue;
    const content = source.slice(start + 2, cursor);
    let divider = -1;
    for (let p = 0; p < content.length; p++) {
      if (content[p] === '|' && !escaped(content, p)) { divider = p; break; }
    }
    const target = unescapeMarkdown((divider < 0 ? content : content.slice(0, divider)).trim());
    const alias = divider < 0 ? null : unescapeMarkdown(content.slice(divider + 1).trim());
    return { image, target, alias, end: cursor + 2 };
  }
  return null;
}

function labelAt(source, index) {
  const image = source[index] === '!';
  const start = index + (image ? 1 : 0);
  if (source[start] !== '[' || escaped(source, index)) return null;
  let depth = 1;
  let cursor = start + 1;
  for (; cursor < source.length; cursor++) {
    if (escaped(source, cursor)) continue;
    const codeEnd = delimitedAt(source, cursor, '`');
    if (codeEnd) { cursor = codeEnd - 1; continue; }
    if (source[cursor] === '[') depth++;
    else if (source[cursor] === ']' && --depth === 0) break;
  }
  if (depth !== 0) return null;
  return { image, label: source.slice(start + 1, cursor), end: cursor + 1 };
}

// Parse inline Markdown destinations without confusing parentheses in file names
// with the closing delimiter; retain the author's optional quoted title.
function markdownAt(source, index) {
  const parsedLabel = labelAt(source, index);
  if (!parsedLabel || source[parsedLabel.end] !== '(') return null;
  const { image, label } = parsedLabel;
  let cursor = parsedLabel.end + 1;
  while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor++;
  let target = '';
  if (source[cursor] === '<') {
    const begin = ++cursor;
    while (cursor < source.length && !(source[cursor] === '>' && !escaped(source, cursor))) {
      if (source[cursor] === '\n' || source[cursor] === '<') return null;
      cursor++;
    }
    if (cursor >= source.length) return null;
    target = source.slice(begin, cursor++);
  } else {
    const begin = cursor;
    let parentheses = 0;
    while (cursor < source.length) {
      const character = source[cursor];
      if (!escaped(source, cursor)) {
        if (character === '(') parentheses++;
        if (character === ')') {
          if (parentheses === 0) break;
          parentheses--;
        }
        if (/\s/.test(character) && parentheses === 0) break;
      }
      cursor++;
    }
    target = source.slice(begin, cursor);
  }
  const titleBegin = cursor;
  while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor++;
  let title = '';
  if (source[cursor] !== ')') {
    const opener = source[cursor];
    if (opener !== '"' && opener !== "'" && opener !== '(') return null;
    const closer = opener === '(' ? ')' : opener;
    cursor++;
    while (cursor < source.length && !(source[cursor] === closer && !escaped(source, cursor))) cursor++;
    if (cursor >= source.length) return null;
    cursor++;
    while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor++;
    title = source.slice(titleBegin, cursor);
  }
  if (source[cursor] !== ')') return null;
  return { image, label, target: decodeDestination(target), title, end: cursor + 1 };
}

function referenceId(label) {
  return unescapeMarkdown(label).trim().replace(/\s+/g, ' ').toLowerCase();
}

function definitionAt(source, index) {
  if (index > 0 && source[index - 1] !== '\n') return null;
  const newline = source.indexOf('\n', index);
  const end = newline < 0 ? source.length : newline + 1;
  const line = source.slice(index, end).replace(/\r?\n$/, '');
  const match = /^ {0,3}\[([^\]\r\n]+)\]:[ \t]*(.+?)[ \t]*$/.exec(line);
  if (!match || match[1].startsWith('^')) return null; // Footnotes use a different grammar.
  const wrapper = `[ref](${match[2]})`;
  const parsed = markdownAt(wrapper, 0);
  if (!parsed || parsed.end !== wrapper.length) return null;
  return { ...parsed, id: referenceId(match[1]), end };
}

function commentEnd(source, index) {
  if (source.slice(index, index + 2) !== '%%' || escaped(source, index)) return null;
  let close = source.indexOf('%%', index + 2);
  while (close >= 0 && escaped(source, close)) close = source.indexOf('%%', close + 2);
  return close >= 0 ? close + 2 : null;
}

function definitionsIn(source) {
  const definitions = new Map();
  for (let index = 0; index < source.length;) {
    const fence = fenceAt(source, index);
    const protectedEnd = fence ? fence.end : delimitedAt(source, index, '`') || delimitedAt(source, index, '$', [1, 2]) || commentEnd(source, index);
    if (protectedEnd) { index = protectedEnd; continue; }
    const definition = definitionAt(source, index);
    if (definition) {
      if (!definitions.has(definition.id)) definitions.set(definition.id, definition);
      index = definition.end;
    } else index++;
  }
  return definitions;
}

function referenceAt(source, index, definitions) {
  const parsedLabel = labelAt(source, index);
  if (!parsedLabel) return null;
  let cursor = parsedLabel.end;
  let id = referenceId(parsedLabel.label);
  if (source[cursor] === '[') {
    const start = ++cursor;
    while (cursor < source.length && !(source[cursor] === ']' && !escaped(source, cursor))) {
      if (source[cursor] === '[' || source[cursor] === '\n') return null;
      cursor++;
    }
    if (cursor >= source.length) return null;
    id = referenceId(source.slice(start, cursor)) || id;
    cursor++;
  }
  const definition = definitions.get(id);
  return definition ? { ...definition, ...parsedLabel, end: cursor } : null;
}

async function convertMarkdown(input, options = {}) {
  const source = frontmatter(String(input));
  const definitions = definitionsIn(source);
  const warnings = new Set();
  const output = [];
  const warn = message => warnings.add(message);
  const resolveLink = options.resolveLink || (() => null);
  const resolveImage = options.resolveImage || (async () => null);

  async function note(target, label, title = '', embed = false) {
    const { path, anchor } = splitAnchor(target);
    const resolved = await resolveLink(path || options.sourcePath || '');
    const url = resolved && destination(resolved.url);
    if (anchor) warn(`笔记定位“${target}”转换为文档链接，标题或段落定位未同步。`);
    if (embed) warn(`嵌入笔记“${target}”转换为链接，未展开内容。`);
    if (!url) {
      warn(`未能解析笔记或附件链接“${target}”${resolved && resolved.reason ? '：' + resolved.reason : '。'}`);
      return label;
    }
    return `[${label}](${url}${title})`;
  }

  async function image(target, label, title = '', wiki = false) {
    if (external(target)) {
      if (wiki) {
        const url = destination(target);
        if (url) return `![${label}](${url})`;
        warn(`图片“${target}”使用了不支持的地址协议。`);
        return label;
      }
      return null; // Existing external Markdown images are preserved byte-for-byte.
    }
    const resolved = await resolveImage(target);
    const url = resolved && destination(resolved.url);
    if (url) return `![${label}](${url}${title})`;
    if (resolved) warn(`图片“${target}”没有可用的网页地址。`);
    return note(target, label, title, true);
  }

  for (let index = 0; index < source.length;) {
    const fence = fenceAt(source, index);
    if (fence) {
      if (/^dataview(?:js)?(?:\s|$)/i.test(fence.info)) {
        warn('Dataview 查询保留为代码；语雀不会运行动态查询。');
      }
      output.push(source.slice(index, fence.end));
      index = fence.end;
      continue;
    }
    const codeEnd = delimitedAt(source, index, '`');
    const mathEnd = delimitedAt(source, index, '$', [1, 2]);
    if (codeEnd || mathEnd) {
      const end = codeEnd || mathEnd;
      output.push(source.slice(index, end));
      index = end;
      continue;
    }
    const removedCommentEnd = commentEnd(source, index);
    if (removedCommentEnd) { index = removedCommentEnd; continue; }
    const definition = definitionAt(source, index);
    if (definition) {
      output.push(source.slice(index, definition.end));
      index = definition.end;
      continue;
    }
    const wiki = wikiAt(source, index);
    if (wiki) {
      const alias = wiki.image && /^\d+(?:x\d+)?$/.test(wiki.alias || '') ? null : wiki.alias;
      const label = escapeLabel(alias || wiki.target.replace(/\.md(?=#|$)/i, ''));
      output.push(wiki.image
        ? await image(wiki.target, label, '', true)
        : await note(wiki.target, label));
      index = wiki.end;
      continue;
    }
    const markdown = markdownAt(source, index) || referenceAt(source, index, definitions);
    if (markdown) {
      if (external(markdown.target)) output.push(source.slice(index, markdown.end));
      else if (markdown.image) {
        output.push(await image(markdown.target, markdown.label, markdown.title) || source.slice(index, markdown.end));
      } else output.push(await note(markdown.target, markdown.label, markdown.title));
      index = markdown.end;
      continue;
    }
    output.push(source[index++]);
  }
  return { markdown: output.join(''), warnings: Array.from(warnings) };
}

module.exports = { convertMarkdown };
