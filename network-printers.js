// ---------------------------------------------------------------------------
// Network printer support
//
// This module discovers printers that are reachable over the local network
// (by IP address) and sends print jobs directly to them, without the printer
// having to be installed as a local/OS printer.
//
// Discovery uses two complementary strategies:
//   1. mDNS / Bonjour  - finds printers advertising IPP / RAW / LPD services.
//   2. TCP subnet scan - probes the local /24 subnet(s) for the common
//                        printing ports (9100 RAW/JetDirect, 631 IPP, 515 LPD).
//
// Printing supports two protocols:
//   - raw  (port 9100) : stream the PDF bytes straight to the printer socket
//                        (JetDirect / PDL-datastream). Works for most modern
//                        network laser printers that accept PDF/PostScript/PCL.
//   - ipp  (port 631)  : Internet Printing Protocol via the `ipp` library.
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// Common printing ports and the protocol they map to.
const PORT_PROTOCOL = {
  9100: 'raw', // RAW / JetDirect / PDL-datastream
  631: 'ipp',  // Internet Printing Protocol
  515: 'lpd'   // Line Printer Daemon
};

const DEFAULT_SCAN_PORTS = [9100, 631, 515];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the list of local IPv4 /24 subnets the machine is connected to.
 * e.g. [{ base: '192.168.1', address: '192.168.1.20' }]
 */
function getLocalSubnets() {
  const ifaces = os.networkInterfaces();
  const subnets = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const parts = iface.address.split('.');
        if (parts.length === 4) {
          subnets.push({ base: parts.slice(0, 3).join('.'), address: iface.address });
        }
      }
    }
  }
  return subnets;
}

/**
 * Attempt a TCP connection to host:port. Resolves true if the port is open
 * within `timeout` ms, false otherwise.
 */
function probePort(host, port, timeout = 400) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Run an array of async task factories with a bounded concurrency.
 */
async function runPool(tasks, concurrency = 64) {
  const results = [];
  let index = 0;
  const workers = new Array(Math.min(concurrency, tasks.length)).fill(null).map(async () => {
    while (index < tasks.length) {
      const current = index++;
      results[current] = await tasks[current]();
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Discovery: mDNS / Bonjour
// ---------------------------------------------------------------------------

/**
 * Discover printers advertising over mDNS/Bonjour.
 * Returns array of { name, ip, port, protocol, source: 'mdns' }.
 */
function discoverMdns(timeout = 3000) {
  return new Promise((resolve) => {
    let Bonjour;
    try {
      Bonjour = require('bonjour-service').Bonjour;
    } catch (e) {
      // Library not available - skip mDNS discovery gracefully.
      return resolve([]);
    }

    const bonjour = new Bonjour();
    const found = new Map(); // key: ip:port

    // Service types that printers commonly advertise.
    const serviceTypes = [
      { type: 'pdl-datastream', protocol: 'raw' }, // port 9100
      { type: 'ipp', protocol: 'ipp' },            // port 631
      { type: 'ipps', protocol: 'ipp' },           // port 631 (TLS)
      { type: 'printer', protocol: 'lpd' }         // port 515
    ];

    const browsers = [];

    const addService = (service, protocol) => {
      const ips = (service.addresses || []).filter(a => net.isIPv4(a));
      const ip = ips[0];
      if (!ip) return;
      const port = service.port || null;
      const key = `${ip}:${port}`;
      if (found.has(key)) return;
      found.set(key, {
        name: service.name || `${ip}`,
        ip,
        port,
        protocol,
        source: 'mdns'
      });
    };

    for (const { type, protocol } of serviceTypes) {
      try {
        const browser = bonjour.find({ type }, (service) => addService(service, protocol));
        browsers.push(browser);
      } catch (e) {
        // ignore individual browser failures
      }
    }

    setTimeout(() => {
      try { browsers.forEach(b => b && b.stop && b.stop()); } catch (e) { /* noop */ }
      try { bonjour.destroy(); } catch (e) { /* noop */ }
      resolve(Array.from(found.values()));
    }, timeout);
  });
}

// ---------------------------------------------------------------------------
// Discovery: TCP subnet scan
// ---------------------------------------------------------------------------

/**
 * Scan local /24 subnet(s) for open printing ports.
 * Returns array of { name, ip, port, protocol, source: 'scan' }.
 */
async function discoverScan(ports = DEFAULT_SCAN_PORTS, timeout = 400) {
  const subnets = getLocalSubnets();
  if (subnets.length === 0) return [];

  const targets = [];
  const seenHosts = new Set();
  for (const subnet of subnets) {
    if (seenHosts.has(subnet.base)) continue;
    seenHosts.add(subnet.base);
    for (let host = 1; host <= 254; host++) {
      const ip = `${subnet.base}.${host}`;
      if (ip === subnet.address) continue; // skip self
      for (const port of ports) {
        targets.push({ ip, port });
      }
    }
  }

  const tasks = targets.map(({ ip, port }) => async () => {
    const open = await probePort(ip, port, timeout);
    return open ? { ip, port } : null;
  });

  const probed = await runPool(tasks, 128);

  // Keep the first (lowest) open port per IP, preferring 9100 > 631 > 515.
  const byIp = new Map();
  const preference = { 9100: 0, 631: 1, 515: 2 };
  for (const result of probed) {
    if (!result) continue;
    const existing = byIp.get(result.ip);
    if (!existing || (preference[result.port] ?? 9) < (preference[existing.port] ?? 9)) {
      byIp.set(result.ip, result);
    }
  }

  return Array.from(byIp.values()).map(({ ip, port }) => ({
    name: `Network printer (${ip})`,
    ip,
    port,
    protocol: PORT_PROTOCOL[port] || 'raw',
    source: 'scan'
  }));
}

// ---------------------------------------------------------------------------
// Combined discovery
// ---------------------------------------------------------------------------

/**
 * Discover network printers using both mDNS and a TCP subnet scan.
 * Options:
 *   - mdns        : run mDNS discovery (default true)
 *   - scan        : run subnet scan     (default true)
 *   - mdnsTimeout : ms to listen for mDNS responses (default 3000)
 *   - scanTimeout : ms per-port TCP probe timeout    (default 400)
 *   - ports       : ports to scan (default [9100, 631, 515])
 */
async function discoverNetworkPrinters(options = {}) {
  const {
    mdns = true,
    scan = true,
    mdnsTimeout = 3000,
    scanTimeout = 400,
    ports = DEFAULT_SCAN_PORTS
  } = options;

  const jobs = [];
  if (mdns) jobs.push(discoverMdns(mdnsTimeout).catch(() => []));
  if (scan) jobs.push(discoverScan(ports, scanTimeout).catch(() => []));

  const results = (await Promise.all(jobs)).flat();

  // Merge by IP. mDNS entries (which carry real names) take precedence.
  const byIp = new Map();
  for (const printer of results) {
    const existing = byIp.get(printer.ip);
    if (!existing) {
      byIp.set(printer.ip, printer);
    } else if (existing.source === 'scan' && printer.source === 'mdns') {
      byIp.set(printer.ip, printer);
    }
  }

  return Array.from(byIp.values()).sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

// ---------------------------------------------------------------------------
// Ghostscript: convert the rendered PDF into a page language the printer
// understands. Older network lasers (e.g. HP LaserJet P3010) have no PDF
// interpreter on port 9100 — they need PostScript or PCL.
// ---------------------------------------------------------------------------

let cachedGsPath; // undefined = not looked up yet, null = not found

function findGhostscript() {
  if (cachedGsPath !== undefined) return cachedGsPath;

  if (process.env.PRINT_AGENT_GS_PATH && fs.existsSync(process.env.PRINT_AGENT_GS_PATH)) {
    return (cachedGsPath = process.env.PRINT_AGENT_GS_PATH);
  }

  if (process.platform === 'win32') {
    // Search the standard install locations: C:\Program Files\gs\gs*\bin\gswin64c.exe
    const roots = [
      'C:\\Program Files\\gs',
      'C:\\Program Files (x86)\\gs'
    ];
    for (const root of roots) {
      try {
        if (!fs.existsSync(root)) continue;
        const versions = fs.readdirSync(root).sort().reverse();
        for (const v of versions) {
          for (const exe of ['gswin64c.exe', 'gswin32c.exe']) {
            const candidate = path.join(root, v, 'bin', exe);
            if (fs.existsSync(candidate)) return (cachedGsPath = candidate);
          }
        }
      } catch (e) { /* ignore */ }
    }
    return (cachedGsPath = null);
  }

  // macOS / Linux: rely on `gs` being on PATH.
  return (cachedGsPath = 'gs');
}

// Ghostscript output device per target language.
const GS_DEVICE = {
  postscript: 'ps2write',
  pcl: 'ljet4',     // PCL5 for HP LaserJet-class printers
  pclxl: 'pxlmono'  // PCL6 / PCL-XL monochrome
};

/**
 * Convert a PDF file to the requested page language using Ghostscript.
 * Returns the path to a temp output file (caller must delete it).
 */
function convertPdf(pdfPath, language) {
  return new Promise((resolve, reject) => {
    const gs = findGhostscript();
    if (!gs) {
      return reject(new Error(
        'Ghostscript not found. Install it from https://ghostscript.com/releases/gsdnld.html ' +
        'or set PRINT_AGENT_GS_PATH. (Needed to print to laser printers over raw/9100.)'
      ));
    }
    const device = GS_DEVICE[language] || GS_DEVICE.postscript;
    const ext = language === 'postscript' ? 'ps' : 'prn';
    const outPath = path.join(os.tmpdir(), `EbizTray-${crypto.randomUUID()}.${ext}`);

    const args = [
      '-dNOPAUSE', '-dBATCH', '-dSAFER', '-q',
      `-sDEVICE=${device}`,
      `-sOutputFile=${outPath}`,
      pdfPath
    ];

    execFile(gs, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err) => {
      if (err) return reject(new Error(`Ghostscript conversion failed: ${err.message}`));
      if (!fs.existsSync(outPath)) return reject(new Error('Ghostscript produced no output'));
      resolve(outPath);
    });
  });
}

// ---------------------------------------------------------------------------
// Printing: RAW / JetDirect (port 9100)
// ---------------------------------------------------------------------------

/**
 * Stream raw bytes to a printer socket, once per copy (sequentially).
 */
function printRawBytes(data, ip, port = 9100, copies = 1, timeout = 30000) {
  const sendOnce = () => new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };
    socket.setTimeout(timeout);
    socket.once('error', finish);
    socket.once('timeout', () => finish(new Error(`Connection to ${ip}:${port} timed out`)));
    socket.connect(port, ip, () => {
      socket.write(data, (err) => {
        if (err) return finish(err);
        // Give the printer a moment to read, then close cleanly.
        socket.end();
      });
    });
    socket.once('close', () => finish());
  });

  return (async () => {
    for (let i = 0; i < Math.max(1, copies); i++) {
      await sendOnce();
    }
  })();
}

function printRaw(filePath, ip, port = 9100, copies = 1, timeout = 30000) {
  return printRawBytes(fs.readFileSync(filePath), ip, port, copies, timeout);
}

// ---------------------------------------------------------------------------
// Printing: IPP (port 631)
// ---------------------------------------------------------------------------

function printIpp(filePath, ip, port = 631, copies = 1) {
  return new Promise((resolve, reject) => {
    let ipp;
    try {
      ipp = require('ipp');
    } catch (e) {
      return reject(new Error('IPP printing requires the "ipp" package to be installed.'));
    }

    const data = fs.readFileSync(filePath);
    const printer = ipp.Printer(`http://${ip}:${port}/ipp/print`);

    const msg = {
      'operation-attributes-tag': {
        'requesting-user-name': 'EbizTray',
        'job-name': 'EbizTray-job',
        'document-format': 'application/pdf'
      },
      'job-attributes-tag': {
        copies: Math.max(1, copies)
      },
      data
    };

    printer.execute('Print-Job', msg, (err, res) => {
      if (err) return reject(err);
      if (res && res.statusCode && !String(res.statusCode).startsWith('successful')) {
        return reject(new Error(`IPP printer responded: ${res.statusCode}`));
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Send a rendered PDF document to a network printer.
//
// target = { ip, port, protocol, language }
//   protocol : 'raw' (9100) | 'ipp' (631) | 'lpd' (515)
//   language : for raw/lpd laser printers, the page language to convert the
//              PDF into before streaming:
//                'postscript' (default) - PDF -> PostScript via Ghostscript
//                'pcl' | 'pclxl'        - PDF -> PCL via Ghostscript
//                'pdf'                  - send the PDF bytes verbatim (only for
//                                         printers with a built-in PDF interpreter)
// ---------------------------------------------------------------------------
async function printToNetworkPrinter(filePath, target, copies = 1) {
  const { ip } = target || {};
  if (!ip) throw new Error('Network printer target requires an "ip"');

  let { port, protocol, language } = target;
  // Infer protocol from port (or vice versa) when one is missing.
  if (!protocol && port) protocol = PORT_PROTOCOL[port] || 'raw';
  if (!protocol) protocol = 'raw';
  if (!port) {
    port = protocol === 'ipp' ? 631 : protocol === 'lpd' ? 515 : 9100;
  }

  // IPP: let the printer's own engine interpret the PDF.
  if (protocol === 'ipp') {
    return printIpp(filePath, ip, port, copies);
  }

  // raw / lpd: stream bytes to port 9100. Convert PDF -> printer language
  // unless the caller explicitly asks to send the PDF as-is.
  const streamPort = protocol === 'lpd' ? 9100 : (port || 9100);
  const lang = (language || 'postscript').toLowerCase();

  if (lang === 'pdf' || lang === 'raw' || lang === 'none') {
    return printRaw(filePath, ip, streamPort, copies);
  }

  // Convert via Ghostscript, stream, then clean up the converted file.
  const convertedPath = await convertPdf(filePath, lang);
  try {
    await printRawBytes(fs.readFileSync(convertedPath), ip, streamPort, copies);
  } finally {
    fs.unlink(convertedPath, () => {});
  }
}

module.exports = {
  discoverNetworkPrinters,
  discoverMdns,
  discoverScan,
  printToNetworkPrinter,
  printRawBytes,
  convertPdf,
  findGhostscript,
  getLocalSubnets
};
