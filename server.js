const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const app = express();
app.use(express.json({ limit: '25mb' }));

// ---------------------------------------------------------------------------
// Configuration (override via environment variables)
// ---------------------------------------------------------------------------
const PORT = process.env.PRINT_AGENT_PORT || 7654;
const API_KEY = process.env.PRINT_AGENT_KEY || 'replace-this-with-a-long-random-key';
const ALLOWED_ORIGINS = (process.env.PRINT_AGENT_ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(s => s.trim());

// ---------------------------------------------------------------------------
// CORS + auth
// ---------------------------------------------------------------------------
app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Origin not allowed: ' + origin));
  }
}));

function requireApiKey(req, res, next) {
  if (req.headers['x-print-agent-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: missing/invalid x-print-agent-key header' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Printer helpers (platform-specific)
// ---------------------------------------------------------------------------
async function listPrinters() {
  if (process.platform === 'win32') {
    const { getPrinters } = require('pdf-to-printer');
    return await getPrinters();
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
  // macOS / Linux: use CUPS `lp`
  return new Promise((resolve, reject) => {
    execFile('lp', ['-d', printerName, '-n', String(copies), filePath], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// HTML -> PDF (uses a locally installed Chrome/Edge — no bundled Chromium,
// which keeps the packaged executable small and avoids pkg-snapshot issues)
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
// Routes
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/printers', requireApiKey, async (req, res) => {
  try {
    res.json({ printers: await listPrinters() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/print', requireApiKey, async (req, res) => {
  const { printerName, pdfUrl, html, copies } = req.body || {};
  if (!printerName) return res.status(400).json({ error: 'printerName is required' });
  if (!pdfUrl && !html) return res.status(400).json({ error: 'Provide either pdfUrl or html' });

  const tempFile = path.join(os.tmpdir(), `print-${crypto.randomUUID()}.pdf`);

  try {
    if (pdfUrl) {
      const response = await axios.get(pdfUrl, { responseType: 'arraybuffer' });
      fs.writeFileSync(tempFile, response.data);
    } else {
      await htmlToPdf(html, tempFile);
    }

    await printFile(tempFile, printerName, copies || 1);
    res.json({ status: 'sent', printer: printerName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    fs.unlink(tempFile, () => {});
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Print agent listening on http://0.0.0.0:${PORT}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
