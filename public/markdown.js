/**
 * Lightweight, XSS-safe markdown renderer for model output.
 *
 * Escapes ALL input first and only emits our own tags (headings, lists,
 * bold/code, fenced code as <pre>). No raw-HTML passthrough, so untrusted
 * model output can't inject markup. Loaded as a browser global before app.js,
 * and `require`-able from Node so the test suite can exercise the real renderer.
 */
(function (global) {
  function renderMarkdown(md) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (s) => esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    const lines = String(md || '').split('\n');
    let html = '';
    let inList = false;
    let code = null; // non-null = inside a fenced code block
    const close = () => { if (inList) { html += '</ul>'; inList = false; } };
    for (const raw of lines) {
      const line = raw.trim();
      if (code !== null) {
        if (/^```/.test(line)) { html += `<pre><code>${esc(code.join('\n'))}</code></pre>`; code = null; }
        else code.push(line);
        continue;
      }
      if (/^```/.test(line)) { close(); code = []; continue; } // opening fence
      if (!line) { close(); continue; }
      const hstar = line.match(/^\*\*(.+?)\*\*\s*$/);     // **Section**
      const hash = line.match(/^(#{1,4})\s+(.*)$/);        // # / ## / ###
      const b = line.match(/^[-*]\s+(.*)$/);               // - / *  list
      const num = line.match(/^\d+[.)]\s+(.*)$/);          // 1. list
      if (hstar) { close(); html += `<h4>${inline(hstar[1])}</h4>`; }
      else if (hash) { close(); const L = Math.min(hash[1].length + 2, 6); html += `<h${L}>${inline(hash[2])}</h${L}>`; }
      else if (b || num) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(b ? b[1] : num[1])}</li>`; }
      else { close(); html += `<p>${inline(line)}</p>`; }
    }
    if (code !== null) html += `<pre><code>${esc(code.join('\n'))}</code></pre>`; // unterminated fence at EOF
    close();
    return html;
  }

  global.renderMarkdown = renderMarkdown;
  if (typeof module !== 'undefined' && module.exports) module.exports = { renderMarkdown };
})(typeof window !== 'undefined' ? window : globalThis);
