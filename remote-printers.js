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
function normalizeRemotePcName(pcName) {
  return String(pcName || '').trim().replace(/^[-\\]+/, '');
}

function uncName(pcName, shareName) {
  const pc = normalizeRemotePcName(pcName);
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
  const host = normalizeRemotePcName(pcName);
  if (!host) return false;
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

// Build a PowerShell PSCredential snippet for the given username/password.
// The caller must already have single-quoted the surrounding command.
function normalizeRemoteUsername(username, pcName) {
  const u = String(username || '').trim();
  if (!u) return u;
  if (u.includes('\\') || u.includes('@')) return u;
  return `${pcName}\\${u}`;
}

function psCredentialString(username, password) {
  const safeUser = String(username || '').replace(/'/g, "''");
  const safePass = String(password || '').replace(/'/g, "''");
  return `$cred = New-Object PSCredential -ArgumentList '${safeUser}', (ConvertTo-SecureString '${safePass}' -AsPlainText -Force); `;
}

// Establish an SMB session to a remote PC using explicit credentials.
// Resolves to an error object (or null if successful). The password is passed
// as a separate command-line argument so it is not interpreted by the shell.
function authenticateRemotePc(pcName, username, password) {
  const host = normalizeRemotePcName(pcName);
  const user = normalizeRemoteUsername(username, host);
  if (!host || !user || !password) return Promise.resolve(null);
  return new Promise((resolve) => {
    // Disconnect any stale session first to avoid the "multiple user name" error.
    execFile('net', ['use', `\\\\${host}\\IPC$`, '/delete', '/y'], { windowsHide: true }, () => {
      execFile('net', ['use', `\\\\${host}\\IPC$`, password, `/user:${user}`],
        { windowsHide: true }, (err) => resolve(err || null));
    });
  });
}

// Remove an SMB session that was created with authenticateRemotePc.
function clearRemoteSession(pcName) {
  const host = normalizeRemotePcName(pcName);
  if (!host) return Promise.resolve();
  return new Promise((resolve) => {
    execFile('net', ['use', `\\\\${host}\\IPC$`, '/delete', '/y'], { windowsHide: true }, () => resolve());
  });
}

// Enumerate the shared printers exposed by a remote computer.
//
// Strategy:
//   1. Invoke-Command -ComputerName (best: gives driver + status) when WinRM
//      access is available.
//   2. Fallback to WMI Get-WmiObject Win32_Printer (uses DCOM/RPC) when WinRM
//      is not configured but the remote PC allows WMI.
//   3. Fallback to `net view \\PC` which only needs SMB access and lists the
//      printer share names.
//
// Returns { online, printers: [{ name, shareName, displayName, driver, status }] }.
function listRemotePrinters(pcName, timeout = 4000, credentials = null) {
  const host = normalizeRemotePcName(pcName);
  if (!host) return Promise.resolve({ online: false, printers: [] });

  if (process.platform !== 'win32') {
    return Promise.resolve({ online: false, printers: [], error: 'Remote shared-printer enumeration is only supported on Windows' });
  }

  const cred = credentials && credentials.username && credentials.password
    ? { username: normalizeRemoteUsername(credentials.username, host), password: credentials.password }
    : null;

  const tryGetPrinter = () => new Promise((resolve) => {
    const safe = host.replace(/'/g, "''");
    const cmd =
      (cred ? psCredentialString(cred.username, cred.password) : '') +
      `Invoke-Command -ComputerName '${safe}' ${cred ? '-Credential $cred ' : ''}-ScriptBlock { ` +
      `Get-Printer | Where-Object { $_.Shared -eq $true } | ` +
      `Select-Object Name, ShareName, DriverName, PrinterStatus } | ConvertTo-Json -Compress`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true, timeout }, (err, stdout) => {
        if (err) return resolve({ error: `Invoke-Command failed: ${err.message}` });
        const txt = String(stdout).trim();
        if (!txt) return resolve({ printers: [] });
        try {
          let arr = JSON.parse(txt);
          if (!Array.isArray(arr)) arr = [arr];
          resolve({ printers: arr.map(p => ({
            name: p.ShareName || p.Name,
            shareName: p.ShareName || p.Name,
            displayName: p.Name,
            driver: p.DriverName || '',
            status: String(p.PrinterStatus || '')
          })) });
        } catch (e) {
          resolve({ error: `Invoke-Command output parse failed: ${e.message}` });
        }
      });
  });

  const tryWmi = () => new Promise((resolve) => {
    const safe = host.replace(/'/g, "''");
    const cmd =
      (cred ? psCredentialString(cred.username, cred.password) : '') +
      `Get-WmiObject Win32_Printer -ComputerName '${safe}' ${cred ? '-Credential $cred ' : ''}-Filter "Shared=true" | ` +
      `Select-Object Name, ShareName, DriverName, Status | ConvertTo-Json -Compress`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true, timeout }, (err, stdout) => {
        if (err) return resolve({ error: `WMI query failed: ${err.message}` });
        const txt = String(stdout).trim();
        if (!txt) return resolve({ printers: [] });
        try {
          let arr = JSON.parse(txt);
          if (!Array.isArray(arr)) arr = [arr];
          resolve({ printers: arr.map(p => ({
            name: p.ShareName || p.Name,
            shareName: p.ShareName || p.Name,
            displayName: p.Name,
            driver: p.DriverName || '',
            status: String(p.Status || '')
          })) });
        } catch (e) {
          resolve({ error: `WMI output parse failed: ${e.message}` });
        }
      });
  });

  const tryNetView = () => new Promise((resolve) => {
    const runView = () => {
      execFile('net', ['view', `\\\\${host}`, '/all'],
        { windowsHide: true, timeout }, (err, stdout) => {
          clearRemoteSession(host).catch(() => {});
          if (err && !stdout) return resolve({ error: `net view failed: ${err.message}` });
          resolve({ printers: parseNetViewPrinters(stdout) });
        });
    };

    if (cred) {
      authenticateRemotePc(host, cred.username, cred.password).then((authErr) => {
        if (authErr) return resolve({ error: `net view authentication failed: ${authErr.message}` });
        runView();
      });
    } else {
      runView();
    }
  });

  return (async () => {
    const online = await checkComputerOnline(host, Math.min(2000, timeout));
    if (!online) return { online: false, printers: [], error: 'Computer unreachable (SMB ports 445/139 not open)' };

    const errors = [];
    let result = await tryGetPrinter();
    if (result.error) {
      errors.push(result.error);
      result = await tryWmi();
    }
    if (result.error) {
      errors.push(result.error);
      result = await tryNetView();
    }
    if (result.error) errors.push(result.error);

    return { online: true, printers: result.printers || [], errors };
  })();
}

// Enumerate shared printers across several computers in parallel.
// credentialsMap is an optional object keyed by computer name.
async function listRemotePrintersForComputers(computers, credentialsMap, timeout = 4000) {
  const names = Array.from(new Set((computers || []).map(c => String(c).trim()).filter(Boolean)));
  const map = credentialsMap || {};
  const results = await Promise.all(names.map(async (pcName) => {
    try {
      const host = normalizeRemotePcName(pcName);
      const cred = map[host] || map[host.toLowerCase()] || map[pcName] || map[pcName.toLowerCase()] || null;
      const { online, printers, errors, error } = await listRemotePrinters(host, timeout, cred);
      return { pcName: host, online, printers, errors, error, hasCredentials: !!cred };
    } catch (e) {
      return { pcName: normalizeRemotePcName(pcName), online: false, printers: [], error: e.message, hasCredentials: false };
    }
  }));
  return results;
}

module.exports = {
  uncName,
  probePort,
  checkComputerOnline,
  authenticateRemotePc,
  clearRemoteSession,
  listRemotePrinters,
  listRemotePrintersForComputers,
  psCredentialString,
  normalizeRemoteUsername,
  normalizeRemotePcName,
  hostName: os.hostname()
};
