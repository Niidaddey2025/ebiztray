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
const remotePrintersModule = require('./remote-printers');
const escpos = require('./escpos-renderer');
const { htmlToEscpos } = require('./html-to-escpos');

const PORT = process.env.PRINT_AGENT_PORT || 7654;

// Build a lookup object { pcName: { pcName, username, password } } from the
// persisted remote-credentials list.
function getRemoteCredentialsMap() {
  const map = {};
  for (const c of trustManager.getRemoteCredentials()) {
    if (c.pcName) map[c.pcName] = c;
  }
  return map;
}

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
// Send RAW bytes (e.g. ESC/POS) straight to a locally-installed printer,
// bypassing the printer driver's page rendering. This is the local equivalent
// of streaming to a network receipt printer on port 9100 and is what makes
// `render: 'text'` produce identical, crisp output on a locally-attached
// thermal printer (e.g. Epson TM-T20III) instead of a reflowed A4 PDF.
//
// Windows: use the spooler's RAW datatype via winspool (WritePrinter).
// macOS/Linux: use CUPS raw passthrough (`lp -o raw`).
// ---------------------------------------------------------------------------
function printRawToLocalPrinter(bytes, printerName, copies = 1) {
  const numCopies = Math.max(1, copies || 1);
  const rawFile = path.join(os.tmpdir(), `EbizTray-raw-${crypto.randomUUID()}.bin`);
  fs.writeFileSync(rawFile, bytes);

  if (process.platform === 'win32') {
    const ps1File = path.join(os.tmpdir(), `EbizTray-raw-${crypto.randomUUID()}.ps1`);
    fs.writeFileSync(ps1File, RAW_PRINT_PS1, 'utf8');

    const cleanup = () => {
      fs.unlink(rawFile, () => {});
      fs.unlink(ps1File, () => {});
    };

    const sendOnce = () => new Promise((resolve, reject) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', ps1File, '-PrinterName', printerName, '-FilePath', rawFile
      ], { windowsHide: true }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || '').trim() || 'Raw print failed'));
        resolve();
      });
    });

    return (async () => {
      try {
        for (let i = 0; i < numCopies; i++) await sendOnce();
      } finally {
        cleanup();
      }
    })();
  }

  // macOS / Linux: CUPS raw passthrough.
  return new Promise((resolve, reject) => {
    execFile('lp', ['-d', printerName, '-o', 'raw', '-n', String(numCopies), rawFile], (err) => {
      fs.unlink(rawFile, () => {});
      if (err) return reject(err);
      resolve();
    });
  });
}

// Windows: print raw ESC/POS bytes to a printer that is installed on a
// remote PC by running the RAW printing script on that PC via Invoke-Command.
// This avoids the server's SMB/OpenPrinter credential issues because the
// printer is opened locally on the remote PC.
function printRawToRemotePrinter(bytes, pcName, printerName, credentials, copies = 1) {
  const numCopies = Math.max(1, copies || 1);
  const host = String(pcName || '').replace(/^\\+/, '');
  if (!host) return Promise.reject(new Error('Remote PC name is required'));
  if (!printerName) return Promise.reject(new Error('Remote printer name is required'));
  if (!credentials || !credentials.username || !credentials.password) {
    return Promise.reject(new Error('Credentials are required for remote raw printing'));
  }

  const ps1File = path.join(os.tmpdir(), `EbizTray-remote-raw-${crypto.randomUUID()}.ps1`);
  fs.writeFileSync(ps1File, REMOTE_RAW_PRINT_PS1, 'utf8');

  const cleanup = () => {
    fs.unlink(ps1File, () => {});
  };

  const user = remotePrintersModule.normalizeRemoteUsername(credentials.username, host);
  const safeUser = String(user || '').replace(/'/g, "''");
  const safePass = String(credentials.password || '').replace(/'/g, "''");
  const safeHost = host.replace(/'/g, "''");
  const safePrinter = String(printerName || '').replace(/'/g, "''");
  const safePath = ps1File.replace(/'/g, "''");
  const b64 = bytes.toString('base64');

  const cmd =
    remotePrintersModule.psCredentialString(user, credentials.password) +
    `Invoke-Command -ComputerName '${safeHost}' -Credential $cred -FilePath '${safePath}' -ArgumentList '${b64}', '${safePrinter}', ${numCopies}`;

  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd
    ], { windowsHide: true }, (err, stdout, stderr) => {
      cleanup();
      if (err) return reject(new Error((stderr || err.message || '').trim() || 'Remote raw print failed'));
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Check whether a locally-installed printer is online/ready.
//
// Windows: query Get-Printer's PrinterStatus + Win32_Printer.WorkOffline.
// macOS/Linux: parse `lpstat -p` (disabled => offline).
//
// Returns { found, online, status }. NOTE: for some USB thermal printers the
// OS keeps reporting "Normal" until a job actually fails, so a powered-off USB
// printer may still appear online. Network printers are checked reliably via a
// TCP probe instead.
// ---------------------------------------------------------------------------
function checkLocalPrinterOnline(printerName) {
  if (!printerName) return Promise.resolve({ found: false, online: false, status: 'no-name' });

  if (process.platform !== 'win32') {
    return new Promise((resolve) => {
      execFile('lpstat', ['-p', printerName], (err, stdout) => {
        if (err) return resolve({ found: false, online: false, status: 'not-found' });
        const disabled = /disabled/i.test(stdout);
        resolve({ found: true, online: !disabled, status: disabled ? 'disabled' : 'idle' });
      });
    });
  }

  const safe = String(printerName).replace(/'/g, "''");
  const cmd =
    `try { ` +
    `$p = Get-Printer -Name '${safe}' -ErrorAction Stop; ` +
    `$w = Get-CimInstance Win32_Printer -Filter "Name='${safe}'" -ErrorAction SilentlyContinue; ` +
    `$offline = $false; ` +
    `if ("$($p.PrinterStatus)" -match 'Offline|Error|NotAvailable|Paused') { $offline = $true }; ` +
    `if ($w -and $w.WorkOffline) { $offline = $true }; ` +
    `[pscustomobject]@{ found=$true; online=(-not $offline); status="$($p.PrinterStatus)" } | ConvertTo-Json -Compress ` +
    `} catch { [pscustomobject]@{ found=$false; online=$false; status='not-found' } | ConvertTo-Json -Compress }`;

  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true }, (err, stdout) => {
        if (err) return resolve({ found: false, online: false, status: 'check-failed' });
        try {
          const o = JSON.parse(String(stdout).trim());
          resolve({ found: !!o.found, online: !!o.online, status: o.status || 'unknown' });
        } catch (e) {
          resolve({ found: false, online: false, status: 'parse-failed' });
        }
      });
  });
}

// Resolve the online status of a single print target (local, network, remote).
async function getTargetStatus(kind, target) {
  if (kind === 'network') {
    const online = await networkPrintersModule.checkNetworkPrinterOnline(target).catch(() => false);
    return { found: true, online, status: online ? 'online' : 'offline' };
  }
  if (kind === 'remote') {
    const online = await remotePrintersModule.checkComputerOnline(target.pcName).catch(() => false);
    return { found: online, online, status: online ? 'online' : 'offline' };
  }
  return checkLocalPrinterOnline(target.name).catch(() => ({ found: false, online: false, status: 'check-failed' }));
}

// Build a per-target online-status report for the requested printers.
async function getPrintersStatus({ printerName, printers, networkPrinters, remotePrinters }) {
  const localTargets = (printers || (printerName ? [printerName] : []))
    .map(t => (typeof t === 'string' ? { name: t } : t))
    .filter(t => t && t.name);
  const netTargets = Array.isArray(networkPrinters) ? networkPrinters : [];
  const remoteTargets = (Array.isArray(remotePrinters) ? remotePrinters : [])
    .filter(t => t && t.pcName && t.name);

  const local = await Promise.all(localTargets.map(async t => ({
    printer: t.name, type: 'local', ...(await getTargetStatus('local', t))
  })));
  const network = await Promise.all(netTargets.map(async t => ({
    printer: t.name || `${t.ip}:${t.port || 9100}`, type: 'network', ...(await getTargetStatus('network', t))
  })));
  const remote = await Promise.all(remoteTargets.map(async t => ({
    printer: `${t.pcName}\\${t.name}`, type: 'remote', pcName: t.pcName,
    ...(await getTargetStatus('remote', t))
  })));

  return { results: [...local, ...network, ...remote] };
}

// PowerShell script that streams a file's bytes to a printer using the Windows
// spooler RAW datatype (winspool WritePrinter). Written to a temp .ps1 and
// invoked per print job.
const RAW_PRINT_PS1 = `param([Parameter(Mandatory=$true)][string]$PrinterName, [Parameter(Mandatory=$true)][string]$FilePath)
$ErrorActionPreference = 'Stop'
$code = @"
using System;
using System.Runtime.InteropServices;
public class EbizRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
  }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool WritePrinter(IntPtr hPrinter, byte[] buf, int count, out int written);
  public static void Send(string printerName, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printerName, out h, IntPtr.Zero)) throw new Exception("OpenPrinter failed for '" + printerName + "': " + Marshal.GetLastWin32Error());
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = "EbizTray Receipt";
      di.pDatatype = "RAW";
      if (!StartDocPrinter(h, 1, ref di)) throw new Exception("StartDocPrinter failed: " + Marshal.GetLastWin32Error());
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter failed: " + Marshal.GetLastWin32Error());
        int written;
        if (!WritePrinter(h, bytes, bytes.Length, out written)) throw new Exception("WritePrinter failed: " + Marshal.GetLastWin32Error());
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
Add-Type -TypeDefinition $code
$bytes = [System.IO.File]::ReadAllBytes($FilePath)
[EbizRawPrinter]::Send($PrinterName, $bytes)
`;

// PowerShell script that is sent to a remote computer to print raw receipt
// bytes locally. The bytes are base64-encoded because Invoke-Command only
// accepts serialisable argument values.
const REMOTE_RAW_PRINT_PS1 = `param([Parameter(Mandatory=$true)][string]$Base64Bytes, [Parameter(Mandatory=$true)][string]$PrinterName, [int]$Copies = 1)
$ErrorActionPreference = 'Stop'
$code = @"
using System;
using System.Runtime.InteropServices;
public class EbizRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
  }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool WritePrinter(IntPtr hPrinter, byte[] buf, int count, out int written);
  public static void Send(string printerName, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printerName, out h, IntPtr.Zero)) throw new Exception("OpenPrinter failed for '" + printerName + "': " + Marshal.GetLastWin32Error());
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = "EbizTray Receipt";
      di.pDatatype = "RAW";
      if (!StartDocPrinter(h, 1, ref di)) throw new Exception("StartDocPrinter failed: " + Marshal.GetLastWin32Error());
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter failed: " + Marshal.GetLastWin32Error());
        int written;
        if (!WritePrinter(h, bytes, bytes.Length, out written)) throw new Exception("WritePrinter failed: " + Marshal.GetLastWin32Error());
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
Add-Type -TypeDefinition $code
$bytes = [Convert]::FromBase64String($Base64Bytes)
for ($i = 0; $i -lt $Copies; $i++) {
  [EbizRawPrinter]::Send($PrinterName, $bytes)
}
`;

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
//   checkOnline     - when true (default), each target is checked for
//                     reachability BEFORE printing. Offline targets are NOT
//                     printed to and are reported with status 'offline'.
//
// Returns { status, results } where results is a per-target array of
//   { printer, type: 'local'|'network', status: 'sent'|'offline'|'failed',
//     online, printerStatus?, error? }
// ---------------------------------------------------------------------------
async function doPrintJob({ printerName, printers, networkPrinters, remotePrinters, pdfUrl, html, text, copies, checkOnline = true }) {
  // Local targets may be a plain printer name (string) or an object carrying
  // receipt options, e.g. { name, type:'receipt', render:'text', widthDots }.
  const localTargets = (printers || (printerName ? [printerName] : []))
    .map(t => (typeof t === 'string' ? { name: t } : t))
    .filter(t => t && t.name);
  const netTargets = Array.isArray(networkPrinters) ? networkPrinters : [];
  // Remote targets are printers attached to another PC on the LAN and shared,
  // addressed as \\pcName\name. Each: { pcName, name, type, render, widthDots }.
  const remoteTargets = (Array.isArray(remotePrinters) ? remotePrinters : [])
    .filter(t => t && t.pcName && t.name);

  if (localTargets.length === 0 && netTargets.length === 0 && remoteTargets.length === 0) {
    const err = new Error('printerName, printers[], networkPrinters[] or remotePrinters[] is required');
    err.statusCode = 400;
    throw err;
  }

  const numCopies = copies || 1;
  // A target is a thermal/ESC-POS receipt if it is explicitly typed as one, or
  // (for local printers) if a receipt `render` mode is requested.
  const isReceipt = (t) => t && (t.type === 'receipt' || t.type === 'escpos' ||
    t.render === 'text' || t.render === 'image');
  const docNetTargets = netTargets.filter(t => !isReceipt(t));
  const receiptTargets = netTargets.filter(t => isReceipt(t));
  const localReceiptTargets = localTargets.filter(isReceipt);
  const localDocTargets = localTargets.filter(t => !isReceipt(t));
  const remoteReceiptTargets = remoteTargets.filter(isReceipt);
  const remoteDocTargets = remoteTargets.filter(t => !isReceipt(t));

  // Build a flat list of targets (with role metadata) so we can check each
  // one's online status before doing any rendering or printing.
  const targetMeta = [
    ...localDocTargets.map(target => ({
      kind: 'local', role: 'localDoc', target, label: target.name
    })),
    ...localReceiptTargets.map(target => ({
      kind: 'local', role: 'localReceipt', target, label: `${target.name} (receipt)`
    })),
    ...docNetTargets.map(target => ({
      kind: 'network', role: 'netDoc', target,
      label: target.name || `${target.ip}${target.port ? ':' + target.port : ''}`
    })),
    ...receiptTargets.map(target => ({
      kind: 'network', role: 'netReceipt', target,
      label: target.name || `${target.ip}:${target.port || 9100} (receipt)`
    })),
    ...remoteDocTargets.map(target => ({
      kind: 'remote', role: 'remoteDoc', target, label: `${target.pcName}\\${target.name}`
    })),
    ...remoteReceiptTargets.map(target => ({
      kind: 'remote', role: 'remoteReceipt', target, label: `${target.pcName}\\${target.name} (receipt)`
    }))
  ];

  // Pre-flight: resolve online status for every target. When checkOnline is
  // disabled, every target is optimistically treated as online.
  const statuses = checkOnline
    ? await Promise.all(targetMeta.map(m => getTargetStatus(m.kind, m.target)))
    : targetMeta.map(() => ({ found: true, online: true, status: 'unchecked' }));

  const isDocRole = (role) => role === 'localDoc' || role === 'netDoc' || role === 'remoteDoc';
  // A rendered PDF is only needed if at least one ONLINE document target exists.
  const needsPdf = targetMeta.some((m, i) => isDocRole(m.role) && statuses[i].online);
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

    // Authenticate to a remote PC before printing if credentials are stored.
    const runWithRemoteAuth = async (m, fn) => {
      const cred = trustManager.getRemoteCredential(m.target.pcName);
      if (!cred) return fn();
      let authErr;
      try {
        authErr = await remotePrintersModule.authenticateRemotePc(m.target.pcName, cred.username, cred.password);
      } catch (e) {
        authErr = e;
      }
      if (authErr) throw new Error('Remote authentication failed: ' + authErr.message);
      try {
        return await fn();
      } finally {
        await remotePrintersModule.clearRemoteSession(m.target.pcName).catch(() => {});
      }
    };

    // The actual print action for a single target, by role.
    const runFor = async (m) => {
      switch (m.role) {
        case 'localDoc':
          return printFile(pdfFile, m.target.name, numCopies);
        case 'localReceipt':
          return buildReceiptBytes(m.target)
            .then(bytes => printRawToLocalPrinter(bytes, m.target.name, numCopies));
        case 'netDoc':
          return networkPrintersModule.printToNetworkPrinter(pdfFile, m.target, numCopies);
        case 'netReceipt':
          return buildReceiptBytes(m.target)
            .then(bytes => networkPrintersModule.printRawBytes(bytes, m.target.ip, m.target.port || 9100, numCopies));
        case 'remoteDoc':
          return runWithRemoteAuth(m, () => printFile(pdfFile, remotePrintersModule.uncName(m.target.pcName, m.target.name), numCopies));
        case 'remoteReceipt':
          return buildReceiptBytes(m.target).then(bytes => {
            const cred = trustManager.getRemoteCredential(m.target.pcName);
            // If we know the local printer name on the remote PC and have
            // credentials, run the raw print on the remote PC itself to avoid
            // OpenPrinter/SMB credential issues from the server.
            const remotePrinterName = m.target.displayName || m.target.name;
            if (cred && remotePrinterName) {
              return printRawToRemotePrinter(bytes, m.target.pcName, remotePrinterName, cred, numCopies);
            }
            return runWithRemoteAuth(m, () => printRawToLocalPrinter(bytes, remotePrintersModule.uncName(m.target.pcName, m.target.name), numCopies));
          });
        default:
          throw new Error('Unknown target role: ' + m.role);
      }
    };

    // Print to every ONLINE target simultaneously; offline targets are skipped.
    const settled = await Promise.allSettled(targetMeta.map((m, i) =>
      statuses[i].online ? runFor(m) : Promise.reject(Object.assign(
        new Error(statuses[i].found === false ? 'Printer not found' : 'Printer offline'),
        { offline: true }
      ))
    ));

    const results = settled.map((result, i) => {
      const offline = result.status === 'rejected' && result.reason && result.reason.offline;
      return {
        printer: targetMeta[i].label,
        type: targetMeta[i].kind,
        status: result.status === 'fulfilled' ? 'sent' : (offline ? 'offline' : 'failed'),
        online: statuses[i].online,
        printerStatus: statuses[i].status,
        error: result.status === 'rejected' && !offline ? result.reason.message : undefined
      };
    });

    // Overall status: 'offline' if nothing could be sent because every target
    // was offline; otherwise 'sent' (some/all succeeded) or 'failed'.
    const anySent = results.some(r => r.status === 'sent');
    const allOffline = results.length > 0 && results.every(r => r.status === 'offline');
    const overall = allOffline ? 'offline' : (anySent ? 'sent' : 'failed');

    return { status: overall, results };
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
['test-client.html', 'test-local.html', 'test-network.html', 'test-remote.html'].forEach(name => {
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

// Discover shared printers on remote PCs on the LAN.
// Query: ?computers=PC1,PC2 (or repeated). If omitted, uses the persisted known list.
app.get('/remote-printers', requireTrust, async (req, res) => {
  let computers;
  if (req.query.computers) {
    computers = Array.isArray(req.query.computers)
      ? req.query.computers
      : req.query.computers.split(',').map(c => c.trim()).filter(Boolean);
  } else {
    computers = trustManager.getRemoteComputers();
  }
  try {
    const credentialsMap = getRemoteCredentialsMap();
    const results = await remotePrintersModule.listRemotePrintersForComputers(computers, credentialsMap);
    res.json({ computers, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read/write the persisted list of known remote computers.
app.get('/remote-computers', requireTrust, async (req, res) => {
  res.json({ computers: trustManager.getRemoteComputers() });
});

app.post('/remote-computers', requireTrust, async (req, res) => {
  const { computers } = req.body || {};
  const cleaned = trustManager.setRemoteComputers(computers);
  res.json({ computers: cleaned });
});

// Read/write the persisted list of remote PC credentials (used in workgroups).
app.get('/remote-credentials', requireTrust, async (req, res) => {
  res.json({ credentials: trustManager.getRemoteCredentials() });
});

app.post('/remote-credentials', requireTrust, async (req, res) => {
  const { credentials } = req.body || {};
  const cleaned = trustManager.setRemoteCredentials(credentials);
  res.json({ credentials: cleaned });
});

// Report the online/reachability status of the requested printers WITHOUT
// printing anything. Body: { printerName | printers[], networkPrinters[], remotePrinters[] }.
app.post('/printer-status', requireTrust, async (req, res) => {
  const { printerName, printers, networkPrinters, remotePrinters } = req.body || {};
  try {
    res.json(await getPrintersStatus({ printerName, printers, networkPrinters, remotePrinters }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/print', requireTrust, async (req, res) => {
  const { printerName, printers, networkPrinters, remotePrinters, pdfUrl, html, text, copies, checkOnline } = req.body || {};

  try {
    const result = await doPrintJob({ printerName, printers, networkPrinters, remotePrinters, pdfUrl, html, text, copies, checkOnline });
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

        case 'discoverRemotePrinters': {
          const computers = msg.computers || trustManager.getRemoteComputers();
          const credentialsMap = getRemoteCredentialsMap();
          const results = await remotePrintersModule.listRemotePrintersForComputers(computers, credentialsMap);
          ws.send(JSON.stringify({ type: 'remotePrinters', id: msg.id, computers, results }));
          break;
        }

        case 'listRemoteComputers': {
          ws.send(JSON.stringify({ type: 'remoteComputers', id: msg.id, computers: trustManager.getRemoteComputers() }));
          break;
        }

        case 'setRemoteComputers': {
          const cleaned = trustManager.setRemoteComputers(msg.computers);
          ws.send(JSON.stringify({ type: 'remoteComputers', id: msg.id, computers: cleaned }));
          break;
        }

        case 'listRemoteCredentials': {
          ws.send(JSON.stringify({ type: 'remoteCredentials', id: msg.id, credentials: trustManager.getRemoteCredentials() }));
          break;
        }

        case 'setRemoteCredentials': {
          const cleaned = trustManager.setRemoteCredentials(msg.credentials);
          ws.send(JSON.stringify({ type: 'remoteCredentials', id: msg.id, credentials: cleaned }));
          break;
        }

        case 'printerStatus': {
          const { printerName, printers, networkPrinters, remotePrinters } = msg;
          const status = await getPrintersStatus({ printerName, printers, networkPrinters, remotePrinters });
          ws.send(JSON.stringify({ type: 'printerStatus', id: msg.id, ...status }));
          break;
        }

        case 'print': {
          const { printerName, printers, networkPrinters, remotePrinters, pdfUrl, html, text, copies, checkOnline } = msg;
          try {
            const result = await doPrintJob({ printerName, printers, networkPrinters, remotePrinters, pdfUrl, html, text, copies, checkOnline });
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
