// ---------------------------------------------------------------------------
// HTML -> ESC/POS (text-first) renderer for receipt printers.
//
// Unlike the full-page raster path, this converts the HTML into NATIVE ESC/POS
// so text prints as crisp characters (fast, sharp) while special content is
// handled appropriately:
//   - text          -> ESC/POS text with alignment / bold / size mapped from CSS
//   - <hr>          -> a dashed separator line
//   - logos/images  -> captured as a bitmap and printed via raster commands
//                      (works for <img> of any format/origin, incl. data URIs)
//   - QR codes      -> printed with the printer's NATIVE QR command (crisp,
//                      scannable) when marked with a `data-qr` attribute,
//                      e.g. <div data-qr="https://example.com/r/123"></div>
//                      Optional: data-qr-size (1-16), data-qr-ec (L|M|Q|H).
//                      A QR supplied as an <img> still prints fine as a bitmap.
//
// Rendering is done with the same local Chrome the agent already uses, so any
// CSS layout works. The DOM is walked in document order to produce a linear
// token stream, which is then assembled into ESC/POS bytes.
// ---------------------------------------------------------------------------

const escpos = require('./escpos-renderer');

// Extract an ordered token list from the rendered DOM.
// Tokens: {kind:'text',text,align,bold,wMul,hMul} | {kind:'rule'} |
//         {kind:'break'} | {kind:'qr',data,moduleSize,ec,align} |
//         {kind:'image',imgIndex,align}
function extractTokens() {
  const tokens = [];
  let imgIndex = 0;

  const baseFont = parseFloat(getComputedStyle(document.body).fontSize) || 16;
  const BLOCK = new Set(['DIV', 'P', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'THEAD',
    'TBODY', 'TR', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'FIGCAPTION']);

  const styleOf = (el) => {
    const cs = getComputedStyle(el);
    let align = cs.textAlign;
    if (align === 'start' || align === 'justify' || !align) align = 'left';
    if (align === 'end') align = 'right';
    const bold = parseInt(cs.fontWeight, 10) >= 600 || cs.fontWeight === 'bold';
    const ratio = (parseFloat(cs.fontSize) || baseFont) / baseFont;
    let wMul = 1, hMul = 1;
    if (ratio >= 1.8) { wMul = 2; hMul = 2; }
    else if (ratio >= 1.3) { wMul = 1; hMul = 2; }
    return { align, bold, wMul, hMul };
  };

  const collapse = (s) => s.replace(/\s+/g, ' ').trim();

  const isHidden = (el) => {
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  };

  const isBlockish = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'IMG' || el.tagName === 'HR' || el.tagName === 'BR') return true;
    if (el.hasAttribute && el.hasAttribute('data-qr')) return true;
    if (BLOCK.has(el.tagName)) return true;
    const d = getComputedStyle(el).display;
    return d === 'block' || d === 'flex' || d === 'grid' || d === 'table' || d === 'list-item';
  };

  // If `el` is a horizontal CSS flex/grid "row" of simple cells (e.g. a
  // label/value pair laid out side-by-side), return its cells so it can be
  // rendered as one aligned table row. Returns null if it isn't such a row.
  const flexRowCells = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const cs = getComputedStyle(el);
    const isRowLayout =
      (cs.display === 'flex' && !(cs.flexDirection || 'row').startsWith('column')) ||
      (cs.display === 'grid' && (cs.gridTemplateColumns || 'none') !== 'none');
    if (!isRowLayout) return null;

    const kids = Array.from(el.children).filter(k => k.nodeType === 1 && !isHidden(k));
    if (kids.length < 2) return null;

    const cells = [];
    for (const k of kids) {
      // Each cell must be a simple text cell: no nested blocks or special media.
      if (Array.from(k.children).some(isBlockish)) return null;
      if (k.querySelector && k.querySelector('img, [data-qr], hr, table')) return null;
      const kcs = getComputedStyle(k);
      let a = kcs.textAlign;
      if (a === 'start' || a === 'justify' || !a) a = 'left';
      if (a === 'end') a = 'right';
      const bold = parseInt(kcs.fontWeight, 10) >= 600 || kcs.fontWeight === 'bold';
      const text = (k.innerText || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      cells.push({ text, align: a, bold });
    }
    return cells.length >= 2 ? cells : null;
  };

  const walk = (el) => {
    if (el.nodeType !== 1 || isHidden(el)) return;

    if (el.hasAttribute('data-qr')) {
      tokens.push({
        kind: 'qr',
        data: el.getAttribute('data-qr'),
        moduleSize: parseInt(el.getAttribute('data-qr-size'), 10) || 6,
        ec: (el.getAttribute('data-qr-ec') || 'M').toUpperCase(),
        align: styleOf(el).align || 'center'
      });
      return;
    }
    if (el.tagName === 'IMG') {
      el.setAttribute('data-escpos-img', String(imgIndex));
      const parentAlign = styleOf(el.parentElement || el).align;
      tokens.push({ kind: 'image', imgIndex, align: parentAlign });
      imgIndex++;
      return;
    }
    if (el.tagName === 'HR') { tokens.push({ kind: 'rule' }); return; }
    if (el.tagName === 'BR') { tokens.push({ kind: 'break' }); return; }

    // An empty block whose only visual is a top/bottom border is a separator
    // line (e.g. <div style="border-top:1px dashed #000"></div>). Emit a rule.
    {
      const hasText = (el.innerText || '').trim().length > 0;
      const hasSpecial = !!el.querySelector('img, [data-qr], hr, table');
      if (!hasText && !hasSpecial) {
        const cs = getComputedStyle(el);
        const topW = parseFloat(cs.borderTopWidth) || 0;
        const botW = parseFloat(cs.borderBottomWidth) || 0;
        const topOn = cs.borderTopStyle !== 'none' && topW > 0;
        const botOn = cs.borderBottomStyle !== 'none' && botW > 0;
        if (topOn || botOn) {
          tokens.push({ kind: 'rule', style: topOn ? cs.borderTopStyle : cs.borderBottomStyle });
          return;
        }
      }
    }

    if (el.tagName === 'TABLE') {
      const rows = [];
      for (const tr of el.rows) {
        // Skip rows that belong to a nested table.
        if (tr.closest('table') !== el) continue;
        const cells = [];
        for (const td of tr.cells) {
          const cs = getComputedStyle(td);
          let a = (td.getAttribute('align') || cs.textAlign || 'left').toLowerCase();
          if (a === 'start' || a === 'justify' || a === '-moz-left') a = 'left';
          if (a === 'end') a = 'right';
          const bold = parseInt(cs.fontWeight, 10) >= 600 || cs.fontWeight === 'bold';
          const text = (td.innerText || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
          cells.push({ text, align: a, bold });
        }
        if (cells.length) rows.push({ cells });
      }
      if (rows.length) tokens.push({ kind: 'table', rows });
      return;
    }

    // Does this element contain block-level structure or special descendants?
    const hasBlockChildren = Array.from(el.children).some(isBlockish);
    const hasSpecialDescendant = !!el.querySelector('img, [data-qr], hr');

    if (!hasBlockChildren && !hasSpecialDescendant) {
      // Leaf block: emit its rendered text (innerText respects <br> as \n).
      const text = (el.innerText || '').replace(/\u00a0/g, ' ');
      const lines = text.split('\n').map(l => l.replace(/[ \t]+/g, ' ').replace(/\s+$/,'')).filter(l => l.length > 0);
      if (lines.length) {
        const s = styleOf(el);
        tokens.push({ kind: 'text', text: lines.join('\n'), ...s });
      }
      return;
    }

    // Container: recurse, batching consecutive flex rows into aligned tables.
    processChildren(el);
  };

  // Walk a container's children. Consecutive CSS flex/grid "rows" are collected
  // and emitted as a SINGLE table token so their columns align across rows
  // (e.g. the colons in "Order No : 1978" / "Order Time : ..." line up).
  const processChildren = (el) => {
    let flexRun = [];
    const flushFlex = () => {
      if (flexRun.length) {
        tokens.push({ kind: 'table', rows: flexRun.map(cells => ({ cells })) });
        flexRun = [];
      }
    };
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        const t = collapse(node.textContent);
        if (t) { flushFlex(); const s = styleOf(el); tokens.push({ kind: 'text', text: t, ...s }); }
      } else if (node.nodeType === 1) {
        if (isHidden(node)) continue;
        const cells = flexRowCells(node);
        if (cells) flexRun.push(cells);
        else { flushFlex(); walk(node); }
      }
    }
    flushFlex();
  };

  processChildren(document.body);
  return tokens;
}

// --- Monospace table layout helpers (Node side) -----------------------------

// Greedy word-wrap to a max character width; hard-splits over-long words.
function wrapText(text, width) {
  if (width <= 0) return [text];
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (let w of words) {
    while (w.length > width) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= width) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  lines.push(cur);
  return lines.length ? lines : [''];
}

function padCell(text, width, align) {
  if (text.length > width) text = text.slice(0, width);
  const slack = width - text.length;
  if (align === 'right') return ' '.repeat(slack) + text;
  if (align === 'center') {
    const left = Math.floor(slack / 2);
    return ' '.repeat(left) + text + ' '.repeat(slack - left);
  }
  return text + ' '.repeat(slack);
}

// Turn structured table rows into aligned monospace text lines.
// Returns [{ text, bold }].
function renderTable(rows, totalWidth) {
  const numCols = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
  if (!numCols) return [];

  const natural = new Array(numCols).fill(0);
  rows.forEach(r => r.cells.forEach((c, j) => { natural[j] = Math.max(natural[j], c.text.length); }));

  const gaps = numCols - 1;
  const widths = natural.slice();
  let used = widths.reduce((a, b) => a + b, 0) + gaps;

  // Pick the widest column as the "flex" column to absorb/shrink slack.
  let flex = 0;
  for (let j = 1; j < numCols; j++) if (natural[j] > natural[flex]) flex = j;

  if (used < totalWidth) widths[flex] += (totalWidth - used);
  else if (used > totalWidth) widths[flex] = Math.max(4, widths[flex] - (used - totalWidth));

  const out = [];
  rows.forEach(r => {
    const rowBold = r.cells.some(c => c.bold);
    const wrapped = [];
    let height = 1;
    for (let j = 0; j < numCols; j++) {
      const cell = r.cells[j];
      const w = wrapText(cell ? cell.text : '', widths[j]);
      wrapped.push(w);
      height = Math.max(height, w.length);
    }
    for (let line = 0; line < height; line++) {
      const parts = [];
      for (let j = 0; j < numCols; j++) {
        const txt = wrapped[j][line] || '';
        const align = (r.cells[j] && r.cells[j].align) || 'left';
        parts.push(padCell(txt, widths[j], align));
      }
      out.push({ text: parts.join(' '), bold: rowBold });
    }
  });
  return out;
}

/**
 * Render HTML to an ESC/POS byte buffer suitable for a thermal receipt printer.
 * options: { widthDots (default 576), executablePath, cut (default true) }
 */
async function htmlToEscpos(html, options = {}) {
  const { widthDots = 576, executablePath, cut = true } = options;
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: widthDots, height: 100, deviceScaleFactor: 1 });
    const wrapped =
      `<style>html,body{margin:0;padding:0;background:#fff;color:#000;width:${widthDots}px;` +
      `font-family:monospace;} img{max-width:100%;height:auto;}</style>` + html;
    await page.setContent(wrapped, { waitUntil: 'networkidle0' });

    const tokens = await page.evaluate(extractTokens);

    const { cmd } = escpos;
    const charsPerLine = Math.max(16, Math.floor(widthDots / 12)); // Font A ~12 dots wide
    // ESC t 0 -> select code page PC437 so byte 0xC4 prints as a continuous
    // horizontal line (used for separator rules, matching a thin solid border).
    const parts = [cmd.init(), Buffer.from([0x1b, 0x74, 0x00])];

    for (const t of tokens) {
      switch (t.kind) {
        case 'text': {
          parts.push(cmd.align(t.align));
          if (t.bold) parts.push(cmd.bold(true));
          if (t.wMul > 1 || t.hMul > 1) parts.push(cmd.size(t.wMul, t.hMul));
          parts.push(Buffer.from(t.text + '\n', 'latin1'));
          if (t.wMul > 1 || t.hMul > 1) parts.push(cmd.size(1, 1));
          if (t.bold) parts.push(cmd.bold(false));
          break;
        }
        case 'rule': {
          parts.push(cmd.align('left'));
          // Continuous solid line (PC437 0xC4 '─'); dotted borders use dots.
          const fill = t.style === 'dotted' ? '.' : '\u00c4';
          parts.push(Buffer.from(fill.repeat(charsPerLine) + '\n', 'latin1'));
          break;
        }
        case 'break': {
          parts.push(Buffer.from('\n', 'latin1'));
          break;
        }
        case 'table': {
          parts.push(cmd.align('left'));
          for (const ln of renderTable(t.rows, charsPerLine)) {
            if (ln.bold) parts.push(cmd.bold(true));
            parts.push(Buffer.from(ln.text + '\n', 'latin1'));
            if (ln.bold) parts.push(cmd.bold(false));
          }
          break;
        }
        case 'qr': {
          parts.push(cmd.align(t.align || 'center'));
          parts.push(escpos.escposQrCode(t.data, { moduleSize: t.moduleSize, ec: t.ec }));
          parts.push(Buffer.from('\n', 'latin1'));
          break;
        }
        case 'image': {
          try {
            const handle = await page.$(`[data-escpos-img="${t.imgIndex}"]`);
            if (handle) {
              const png = await handle.screenshot({ type: 'png' });
              parts.push(cmd.align(t.align || 'center'));
              parts.push(escpos.pngToRaster(png, { dither: true }));
              parts.push(Buffer.from('\n', 'latin1'));
            }
          } catch (e) { /* skip an image that fails to capture */ }
          break;
        }
      }
    }

    parts.push(cmd.align('left'));
    parts.push(cmd.feed(4));
    if (cut) parts.push(cmd.cut());
    return Buffer.concat(parts);
  } finally {
    await browser.close();
  }
}

module.exports = { htmlToEscpos };
