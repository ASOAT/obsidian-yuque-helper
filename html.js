'use strict';

const MarkdownIt = require('./vendor/markdown-it');

const renderer = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false
});

function escaped(source, index) {
  let slashes = 0;
  while (index > 0 && source[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}

// The HTML field is a safe cache, not the source of rich math rendering.
// Retain the complete LaTeX literally; Yuque's native converter produces Lake
// formula cards from the original Markdown separately.
function inlineMathSource(state, silent) {
  const start = state.pos;
  if (state.src[start] !== '$') return false;
  const size = state.src[start + 1] === '$' ? 2 : 1;
  if (state.src[start + size] === '$') return false;
  let cursor = start + size;
  while (cursor < state.posMax) {
    const match = state.src.indexOf('$', cursor);
    if (match < 0 || match >= state.posMax) return false;
    let run = 1;
    while (state.src[match + run] === '$') run++;
    if (run === size && !escaped(state.src, match)) {
      if (!silent) {
        const token = state.push('notebox_math_source', '', 0);
        token.content = state.src.slice(start, match + run);
      }
      state.pos = match + run;
      return true;
    }
    cursor = match + run;
  }
  return false;
}

function blockMathSource(state, startLine, endLine, silent) {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const begin = state.bMarks[startLine] + state.tShift[startLine];
  const first = state.src.slice(begin, state.eMarks[startLine]);
  if (!first.startsWith('$$') || first[2] === '$') return false;
  let closeLine = -1;
  for (let line = startLine; line < endLine; line++) {
    const lineBegin = state.bMarks[line] + state.tShift[line];
    const lineEnd = state.eMarks[line];
    if (line > startLine && lineBegin < lineEnd && state.sCount[line] < state.blkIndent) break;
    const text = state.src.slice(lineBegin, lineEnd);
    let cursor = line === startLine ? 2 : 0;
    while ((cursor = text.indexOf('$$', cursor)) >= 0) {
      if (!escaped(text, cursor) && text[cursor - 1] !== '$' && text[cursor + 2] !== '$' &&
          !text.slice(cursor + 2).trim()) {
        closeLine = line;
        break;
      }
      cursor += 2;
    }
    if (closeLine >= 0) break;
  }
  if (closeLine < 0) return false;
  if (silent) return true;
  const token = state.push('notebox_math_block_source', '', 0);
  // getLines follows Markdown's list/blockquote indentation instead of retaining
  // their marker characters as part of the formula.
  token.content = state.getLines(startLine, closeLine + 1, state.blkIndent, false);
  token.block = true;
  token.map = [startLine, closeLine + 1];
  state.line = closeLine + 1;
  return true;
}

renderer.inline.ruler.before('escape', 'notebox_math_source', inlineMathSource);
renderer.block.ruler.before('fence', 'notebox_math_block_source', blockMathSource,
  { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
renderer.renderer.rules.notebox_math_source = (tokens, index) =>
  '<span class="notebox-math-source">' + renderer.utils.escapeHtml(tokens[index].content) + '</span>';
renderer.renderer.rules.notebox_math_block_source = (tokens, index) =>
  '<div class="notebox-math-source">' + renderer.utils.escapeHtml(tokens[index].content) + '</div>\n';

function renderMarkdownHtml(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('Markdown source must be a string');
  return renderer.render(markdown) || '<p></p>\n';
}

module.exports = { renderMarkdownHtml };
