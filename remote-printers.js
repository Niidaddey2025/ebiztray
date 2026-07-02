// ---------------------------------------------------------------------------
// Remote (shared) printers.
//
// In this deployment EbizTray runs ONLY on the server. The printers are
// physically attached to other PCs on the LAN (e.g. BAR-PC, KITCHEN-PC) and
// shared via Windows printer sharing. The server reaches them by their UNC
// name "\\PCNAME\ShareName" and prints through its own spooler:
//   - documents -> the printer's driver (via pdf-to-printer)
//   - receipts  -> RAW ESC/POS passthrough (winspool WritePrinter)
// exactly like a locally-attached printer, just addressed over the network.
//
// This module enumerates the shared printers exposed by a given computer and
// checks whether that computer is reachable.
//
// Requirements on the remote PC:
//   - File & Printer Sharing enabled
//   - The printer is Shared (has a Share name)
//   - The server's Windows user has permission to use the share
// ---------------------------------------------------------------------------

const { execFile } = require('child_process');
const os = require('os');
const net = require('net');

// Build the UNC path used to address a remote shared printer.
function uncName(pcName, shareName) {
  const pc = String(pcName).replace(/^\\+/, '');
  return `\\\\${pc}\\${shareName}`;
}

// Probe a TCP port on a host; resolves true if a connection is accepted.
function probePort(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

// Is a remote computer reachable? Probes the SMB ports used for printer shares.
async function checkComputerOnline(pcName, timeout = 1500) {
  if (!pcName) return false;
  const host = String(pcName).replace(/^\\+/, '');
  if (await probePort(host, 445, timeout)) return true;   // SMB over TCP
  return probePort(host, 139, timeout);                   // NetBIOS session
}

// Parse the share list produced by `net view \\PC`. Returns printer shares.
function parseNetViewPrinters(stdout) {
  const lines = String(stdout).split(/\r?\n/);
  const printers = [];
  for (const line of lines) {
    // Columns are whitespace separated: "ShareName   Print   Comment".
    // Match a line whose 2nd column is the localized/EN word "Print".
    const m = line.match(/^(\S.*?)\s{2,}Print\b\s*(.*)$/i);
    if (m) {
      const name = m[1].trim();
      if (name) printers.push({ name, shareName: name, displayName: name, driver: '', status: 'shared', comment: (m[2] || '').trim() });
    }
  }
  return printers;
}

// Enumerate the shared printers exposed by a remote computer.
//
// Strategy:
//   1. Get-Printer -ComputerName (best: gives driver + status) when RPC/WinRM
//      access is available.
//   2. Fallback to `net view \\PC` which only needs SMB access and lists the
//      printer share names.
//
// Returns { online, printers: [{ name, shareName, displayName, driver, status }] }.
function listRemotePrinters(pcName, timeout = 4000) {
  const host = String(pcName || '').replace(/^\\+/, '');
  if (!host) return Promise.resolve({ online: false, printers: [] });

  if (process.platform !== 'win32') {
    return Promise.resolve({ online: false, printers: [], error: 'Remote shared-printer enumeration is only supported on Windows' });
  }

  const tryGetPrinter = () => new Promise((resolve) => {
    const safe = host.replace(/'/g, "''");
    const cmd =
      `Get-Printer -ComputerName '${safe}' -ErrorAction Stop | ` +
      `Where-Object { $_.Shared -eq $true } | ` +
      `Select-Object Name, ShareName, DriverName, PrinterStatus | ConvertTo-Json -Compress`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true, timeout }, (err, stdout) => {
        if (err) return resolve(null);
        const txt = String(stdout).trim();
        if (!txt) return resolve([]);
        try {
          let arr = JSON.parse(txt);
          if (!Array.isArray(arr)) arr = [arr];
          resolve(arr.map(p => ({
            name: p.ShareName || p.Name,
            shareName: p.ShareName || p.Name,
            displayName: p.Name,
            driver: p.DriverName || '',
            status: String(p.PrinterStatus || '')
          })));
        } catch (e) {
          resolve(null);
        }
      });
  });

  const tryNetView = () => new Promise((resolve) => {
    execFile('net', ['view', `\\\\${host}`, '/all'],
      { windowsHide: true, timeout }, (err, stdout) => {
        if (err && !stdout) return resolve([]);
        resolve(parseNetViewPrinters(stdout));
      });
  });

  return (async () => {
    const online = await checkComputerOnline(host, Math.min(2000, timeout));
    if (!online) return { online: false, printers: [] };
    let printers = await tryGetPrinter();
    if (printers === null) printers = await tryNetView();
    return { online: true, printers };
  })();
}

// Enumerate shared printers across several computers in parallel.
async function listRemotePrintersForComputers(computers, timeout = 4000) {
  const names = Array.from(new Set((computers || []).map(c => String(c).trim()).filter(Boolean)));
  const results = await Promise.all(names.map(async (pcName) => {
    try {
      const { online, printers } = await listRemotePrinters(pcName, timeout);
      return { pcName, online, printers };
    } catch (e) {
      return { pcName, online: false, printers: [], error: e.message };
    }
  }));
  return results;
}

module.exports = {
  uncName,
  probePort,
  checkComputerOnline,
  listRemotePrinters,
  listRemotePrintersForComputers,
  hostName: os.hostname()
};
