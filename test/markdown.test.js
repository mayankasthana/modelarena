const { test } = require('node:test');
const assert = require('node:assert');
const { renderMarkdown } = require('../public/markdown.js');

test('renders headings (# / ## / ###)', () => {
  const out = renderMarkdown('# Title\n## Section\n### Sub');
  assert.ok(out.includes('<h3>Title</h3>'));
  assert.ok(out.includes('<h4>Section</h4>'));
  assert.ok(out.includes('<h5>Sub</h5>'));
});

test('renders bullet and numbered lists', () => {
  const out = renderMarkdown('- one\n- two\n\n1. first');
  assert.ok(out.includes('<ul><li>one</li><li>two</li></ul>'));
  assert.ok(out.includes('<li>first</li>'));
});

test('renders bold and inline code', () => {
  const out = renderMarkdown('a **bold** and `code`');
  assert.ok(out.includes('<b>bold</b>'));
  assert.ok(out.includes('<code>code</code>'));
});

test('renders fenced code blocks as <pre><code>', () => {
  const out = renderMarkdown('```\nlet x = 1;\n```');
  assert.ok(out.includes('<pre><code>let x = 1;</code></pre>'));
});

test('tolerates an unterminated fence at EOF', () => {
  const out = renderMarkdown('```\nopen');
  assert.ok(out.includes('<pre><code>open</code></pre>'));
});

test('escapes HTML so untrusted model output cannot inject markup', () => {
  const out = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
});

test('escapes content INSIDE code fences', () => {
  const out = renderMarkdown('```\n<img onerror=alert(1)>\n```');
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('&lt;img'));
});

test('returns safe empty string for null/blank input', () => {
  assert.strictEqual(renderMarkdown(null), '');
  assert.strictEqual(renderMarkdown(''), '');
});
