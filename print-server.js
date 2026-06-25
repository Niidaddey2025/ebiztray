const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const http = require('http');
const trustManager = require('./trust-manager');
const networkPrintersModule = require('./network-printers');
const escpos = require('./escpos-renderer');
const { htmlToEscpos } = require('./html-to-escpos');

const PORT = process.env.PRINT_AGENT_PORT || 7654;

let approvalCallback = null; // Set by main.js to show dialog

function setApprovalCallback(cb) {
  approvalCallback = cb;
}

// ---------------------------------------------------------------------------
// Printer helpers
// ---------------------------------------------------------------------------
async function listPrinters() {
  if (process.platform === 'win32') {
    // Use PowerShell directly to avoid pdf-to-printer parsing issues in Electron
    return new Promise((resolve, reject) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-Printer | Select-Object Name, DriverName, PortName, PrinterStatus | ConvertTo-Json'
      ], { windowsHide: true }, (err, stdout) => {
        if (err) {
          // Fallback to pdf-to-printer
          try {
            const { getPrinters } = require('pdf-to-printer');
            getPrinters().then(resolve).catch(reject);
          } catch (e) {
            reject(err);
          }
          return;
        }
        try {
          let printers = JSON.parse(stdout.trim());
          if (!Array.isArray(printers)) printers = [printers];
          resolve(printers.map(p => ({
            name: p.Name,
            driver: p.DriverName,
            port: p.PortName,
            status: p.PrinterStatus
          })));
        } catch (parseErr) {
          reject(new Error('Failed to parse printer list: ' + parseErr.message));
        }
      });
    });
  }
  // macOS / Linux: parse `lpstat -p`
  return new Promise((resolve, reject) => {
    execFile('lpstat', ['-p'], (err, stdout) => {
      if (err) return reject(err);
      const printers = stdout
        .split('\n')
        .filter(line => line.startsWith('printer'))
        .map(line => line.split(' ')[1]);
      resolve(printers);
    });
  });
}

async function printFile(filePath, printerName, copies) {
  if (process.platform === 'win32') {
    const { print } = require('pdf-to-printer');
    await print(filePath, { printer: printerName, copies });
    return;
  }
  return new Promise((resolve, reject) => {
    execFile('lp', ['-d', printerName, '-n', String(copies), filePath], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// HTML -> PDF
// ---------------------------------------------------------------------------
function findLocalChrome() {
  if (process.env.PRINT_AGENT_CHROME_PATH && fs.existsSync(process.env.PRINT_AGENT_CHROME_PATH)) {
    return process.env.PRINT_AGENT_CHROME_PATH;
  }
  const candidates = {
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium'
    ]
  }[process.platform] || [];

  const found = candidates.find(p => fs.existsSync(p));
  if (!found) {
    throw new Error('No local Chrome/Edge found. Set PRINT_AGENT_CHROME_PATH to a browser executable.');
  }
  return found;
}

async function htmlToPdf(html, outputPath) {
  const puppeteer = require('puppeteer-core');
  const executablePath = findLocalChrome();
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({ path: outputPath, format: 'A4', printBackground: true });
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// HTML -> PNG sized for a receipt printer (used to rasterize HTML into an
// ESC/POS bitmap). widthDots is the printer's printable width in dots, which
// at deviceScaleFactor=1 maps 1:1 to CSS pixels.
// ---------------------------------------------------------------------------
async function htmlToReceiptPng(html, widthDots = 576) {
  const puppeteer = require('puppeteer-core');
  const executablePath = findLocalChrome();
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: widthDots, height: 10, deviceScaleFactor: 1 });
    // White background so transparent areas threshold to white (no dots).
    const wrapped = `<style>html,body{margin:0;padding:0;background:#fff;width:${widthDots}px;}</style>` + html;
    await page.setContent(wrapped, { waitUntil: 'networkidle0' });
    return await page.screenshot({ type: 'png', fullPage: true });
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Shared print job: prepares the document, then fans it out to every requested
// local printer AND network (IP) printer simultaneously.
//
// Network targets may be one of two kinds, set per-target via `type`:
//   - 'document' (default) : full-page printers (laser/inkjet). The HTML/PDF is
//                            rendered to A4 PDF, then converted to the printer's
//                            page language (PostScript/PCL) by network-printers.
//   - 'receipt'            : thermal/ESC-POS receipt printers (e.g. Epson
//                            TM-T20III). Content is emitted as ESC/POS, either
//                            from `text`, from `html` rasterized to the receipt
//                            width, or from verbatim `escposBase64`.
//
// Accepts:
//   printerName     - single local printer name (back-compat)
//   printers        - array of local printer names
//   networkPrinters - array of network targets, each:
//                     { ip, port, protocol, name, type, language,
//                       widthDots, cut, align, bold, text, escposBase64 }
//   pdfUrl | html   - the document for local + 'document' network printers
//   text            - default text content for 'receipt' targets
//   copies          - number of copies (default 1)
//
// Returns { status, results } where results is a per-target array of
//   { printer, type: 'local'|'network', status: 'sent'|'failed', error? }
// ---------------------------------------------------------------------------
async function doPrintJob({ printerName, printers, networkPrinters, pdfUrl, html, text, copies }) {
  const localTargets = printers || (printerName ? [printerName] : []);
  const netTargets = Array.isArray(networkPrinters) ? networkPrinters : [];

  if (localTargets.length === 0 && netTargets.length === 0) {
    const err = new Error('printerName, printers[] or networkPrinters[] is required');
    err.statusCode = 400;
    throw err;
  }

  const numCopies = copies || 1;
  const isReceipt = (t) => t && (t.type === 'receipt' || t.type === 'escpos');
  const docNetTargets = netTargets.filter(t => !isReceipt(t));
  const receiptTargets = netTargets.filter(t => isReceipt(t));

  // A rendered PDF is needed for local printers and 'document' network printers.
  const needsPdf = localTargets.length > 0 || docNetTargets.length > 0;
  if (needsPdf && !pdfUrl && !html) {
    const err = new Error('Provide either pdfUrl or html for document/local printers');
    err.statusCode = 400;
    throw err;
  }

  const tempFiles = [];
  const pdfFile = needsPdf ? path.join(os.tmpdir(), `EbizTray-${crypto.randomUUID()}.pdf`) : null;
  if (pdfFile) tempFiles.push(pdfFile);

  // Cache rendered receipt output per (render-mode + width) so identical
  // targets don't re-render the same HTML.
  const receiptHtmlCache = new Map();

  // Build the ESC/POS byte stream for a single receipt target.
  //
  // For HTML, the default render mode is 'text': the HTML is converted to
  // native ESC/POS (crisp text, logos as bitmaps, QR via native command).
  // Set target.render = 'image' to rasterize the whole receipt as one bitmap.
  async function buildReceiptBytes(target) {
    const opts = {
      cut: target.cut !== false,
      align: target.align,
      bold: target.bold === true
    };
    if (target.escposBase64) {
      return Buffer.from(target.escposBase64, 'base64');
    }
    const targetText = target.text != null ? target.text : text;
    if (targetText != null && targetText !== '') {
      return escpos.escposFromText(targetText, opts);
    }
    if (html) {
      const widthDots = target.widthDots || 576;
      const mode = target.render === 'image' ? 'image' : 'text';
      const cacheKey = `${mode}:${widthDots}`;
      if (!receiptHtmlCache.has(cacheKey)) {
        if (mode === 'image') {
          const png = await htmlToReceiptPng(html, widthDots);
          receiptHtmlCache.set(cacheKey, escpos.escposFromPng(png, opts));
        } else {
          receiptHtmlCache.set(cacheKey, await htmlToEscpos(html, {
            widthDots,
            executablePath: findLocalChrome(),
            cut: opts.cut
          }));
        }
      }
      return receiptHtmlCache.get(cacheKey);
    }
    throw new Error('Receipt target requires text, html, or escposBase64');
  }

  try {
    if (pdfFile) {
      if (pdfUrl) {
        const response = await axios.get(pdfUrl, { responseType: 'arraybuffer' });
        fs.writeFileSync(pdfFile, response.data);
      } else {
        await htmlToPdf(html, pdfFile);
      }
    }

    const jobs = [
      ...localTargets.map(name => ({
        type: 'local',
        label: name,
        run: () => printFile(pdfFile, name, numCopies)
      })),
      ...docNetTargets.map(target => ({
        type: 'network',
        label: target.name || `${target.ip}${target.port ? ':' + target.port : ''}`,
        run: () => networkPrintersModule.printToNetworkPrinter(pdfFile, target, numCopies)
      })),
      ...receiptTargets.map(target => ({
        type: 'network',
        label: target.name || `${target.ip}:${target.port || 9100} (receipt)`,
        run: async () => {
          const bytes = await buildReceiptBytes(target);
          return networkPrintersModule.printRawBytes(bytes, target.ip, target.port || 9100, numCopies);
        }
      }))
    ];

    // Print to every target simultaneously.
    const settled = await Promise.allSettled(jobs.map(job => job.run()));

    const results = settled.map((result, i) => ({
      printer: jobs[i].label,
      type: jobs[i].type,
      status: result.status === 'fulfilled' ? 'sent' : 'failed',
      error: result.status === 'rejected' ? result.reason.message : undefined
    }));

    return { status: 'sent', results };
  } finally {
    tempFiles.forEach(f => fs.unlink(f, () => {}));
  }
}

// ---------------------------------------------------------------------------
// Origin trust check middleware
// ---------------------------------------------------------------------------
async function checkTrust(origin) {
  if (!origin) return true; // Local requests (no origin header) are trusted
  if (trustManager.isTrusted(origin)) return true;

  // Ask the user for approval via Electron dialog
  if (approvalCallback) {
    const approved = await approvalCallback(origin);
    if (approved) {
      trustManager.trustOrigin(origin);
      return true;
    }
  }
  return false;
}

function requireTrust(req, res, next) {
  const origin = req.headers.origin || req.headers.referer;
  let parsedOrigin = null;
  // Browsers send Origin: "null" for file:// pages, which is not a valid URL.
  if (origin && origin !== 'null') {
    try {
      parsedOrigin = new URL(origin).origin;
    } catch (e) {
      parsedOrigin = null;
    }
  }

  checkTrust(parsedOrigin).then(trusted => {
    if (!trusted) {
      return res.status(403).json({ error: 'Origin not trusted. User denied access.' });
    }
    next();
  }).catch(err => {
    res.status(500).json({ error: err.message });
  });
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// Private Network Access (PNA): a public/HTTPS site reaching a private LAN IP
// (this agent) is gated by Chrome. The preflight carries
// `Access-Control-Request-Private-Network: true`; we must echo back
// `Access-Control-Allow-Private-Network: true` or the request is blocked with
// "Permission was denied for this request to access the local address space".
// This header must be present BEFORE the cors() middleware answers OPTIONS.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Private-Network', 'true');
  next();
});

// CORS: allow any origin to attempt (trust check happens at route level)
app.use(cors({
  origin: true,
  credentials: true,
  allowedHeaders: ['Content-Type', 'Access-Control-Request-Private-Network'],
  methods: ['GET', 'POST', 'OPTIONS']
}));

app.use(express.json({ limit: '25mb' }));

app.get('/health', async (req, res) => {
  try {
    const printers = await listPrinters();
    res.json({ status: 'ok', version: '1.0.0', name: 'EbizTray', printers });
  } catch (err) {
    res.json({ status: 'ok', version: '1.0.0', name: 'EbizTray', printers: [], error: err.message });
  }
});

// Serve the printers dashboard page (installed + network printers).
app.get(['/', '/printers.html'], (req, res) => {
  const file = path.join(__dirname, 'printers.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send('printers.html not found');
});

// Serve the test client pages (combined + split local/network).
['test-client.html', 'test-local.html', 'test-network.html'].forEach(name => {
  app.get('/' + name, (req, res) => {
    const file = path.join(__dirname, name);
    if (fs.existsSync(file)) return res.sendFile(file);
    res.status(404).send(name + ' not found');
  });
});

app.get('/printers', requireTrust, async (req, res) => {
  try {
    res.json({ printers: await listPrinters() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Discover printers reachable over the local network by IP address.
// Optional query params: mdns=0/1, scan=0/1, mdnsTimeout, scanTimeout
app.get('/network-printers', requireTrust, async (req, res) => {
  try {
    const opts = {};
    if (req.query.mdns !== undefined) opts.mdns = req.query.mdns !== '0' && req.query.mdns !== 'false';
    if (req.query.scan !== undefined) opts.scan = req.query.scan !== '0' && req.query.scan !== 'false';
    if (req.query.mdnsTimeout) opts.mdnsTimeout = parseInt(req.query.mdnsTimeout, 10);
    if (req.query.scanTimeout) opts.scanTimeout = parseInt(req.query.scanTimeout, 10);
    res.json({ printers: await networkPrintersModule.discoverNetworkPrinters(opts) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/print', requireTrust, async (req, res) => {
  const { printerName, printers, networkPrinters, pdfUrl, html, text, copies } = req.body || {};

  try {
    const result = await doPrintJob({ printerName, printers, networkPrinters, pdfUrl, html, text, copies });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  const origin = req.headers.origin || null;

  // Check trust on connection
  const trusted = await checkTrust(origin);
  if (!trusted) {
    ws.send(JSON.stringify({ type: 'error', message: 'Origin not trusted. Connection denied.' }));
    ws.close();
    return;
  }

  ws.send(JSON.stringify({ type: 'connected', message: 'EbizTray connected. Origin trusted.' }));

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'listPrinters': {
          const printers = await listPrinters();
          ws.send(JSON.stringify({ type: 'printers', id: msg.id, printers }));
          break;
        }

        case 'discoverNetworkPrinters': {
          const opts = msg.options || {};
          const printers = await networkPrintersModule.discoverNetworkPrinters(opts);
          ws.send(JSON.stringify({ type: 'networkPrinters', id: msg.id, printers }));
          break;
        }

        case 'print': {
          const { printerName, printers, networkPrinters, pdfUrl, html, text, copies } = msg;
          try {
            const result = await doPrintJob({ printerName, printers, networkPrinters, pdfUrl, html, text, copies });
            ws.send(JSON.stringify({ type: 'printResult', id: msg.id, ...result }));
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', id: msg.id, message: err.message }));
          }
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', id: msg.id, message: 'Unknown message type: ' + msg.type }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON: ' + err.message }));
    }
  });
});

function startServer() {
  return new Promise((resolve) => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`EbizTray listening on http://0.0.0.0:${PORT}`);
      resolve(PORT);
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

module.exports = {
  startServer,
  stopServer,
  setApprovalCallback
};
