const Store = require('electron-store');

const store = new Store({
  name: 'EbizTray-config',
  defaults: {
    trustedOrigins: [],
    apiKey: '9Xf3KqT8mN2VzA7LpD4HyJ6RwE1UcB5GsZ8NtQ0MxY',
    // Names of LAN computers whose shared printers can be used as remote
    // printers (e.g. ['BAR-PC', 'KITCHEN-PC']).
    remoteComputers: [],
    // Credentials for remote PCs in a workgroup (stored in plain text).
    remoteCredentials: []
  }
});

/**
 * Check if an origin is already trusted.
 */
function isTrusted(origin) {
  if (!origin) return false;
  const trusted = store.get('trustedOrigins', []);
  return trusted.includes(origin);
}

/**
 * Add an origin to the trusted list (persisted to disk).
 */
function trustOrigin(origin) {
  if (!origin) return;
  const trusted = store.get('trustedOrigins', []);
  if (!trusted.includes(origin)) {
    trusted.push(origin);
    store.set('trustedOrigins', trusted);
  }
}

/**
 * Remove an origin from the trusted list.
 */
function revokeTrust(origin) {
  const trusted = store.get('trustedOrigins', []);
  store.set('trustedOrigins', trusted.filter(o => o !== origin));
}

/**
 * Get all trusted origins.
 */
function getTrustedOrigins() {
  return store.get('trustedOrigins', []);
}

/**
 * Get the API key.
 */
function getApiKey() {
  return store.get('apiKey', '9Xf3KqT8mN2VzA7LpD4HyJ6RwE1UcB5GsZ8NtQ0MxY');
}

/**
 * Set the API key.
 */
function setApiKey(key) {
  store.set('apiKey', key);
}

/**
 * Get the list of known remote computers (whose shared printers can be used).
 */
function getRemoteComputers() {
  return store.get('remoteComputers', []);
}

/**
 * Replace the list of known remote computers.
 */
function setRemoteComputers(list) {
  const clean = Array.from(new Set((Array.isArray(list) ? list : [])
    .map(c => String(c).trim().replace(/^\\+/, ''))
    .filter(Boolean)));
  store.set('remoteComputers', clean);
  return clean;
}

/**
 * Get all stored remote PC credentials.
 */
function getRemoteCredentials() {
  return store.get('remoteCredentials', []);
}

/**
 * Get the stored credential for a specific PC (case-insensitive).
 */
function getRemoteCredential(pcName) {
  const name = String(pcName || '').trim().replace(/^\\+/, '').toLowerCase();
  if (!name) return null;
  return getRemoteCredentials().find(c =>
    String(c.pcName || '').trim().replace(/^\\+/, '').toLowerCase() === name
  ) || null;
}

/**
 * Replace the full list of remote PC credentials.
 * Duplicates are removed (last entry wins). Passwords are stored in plain text.
 */
function setRemoteCredentials(list) {
  const clean = [];
  const seen = new Set();
  for (const item of (Array.isArray(list) ? list : [])) {
    const pcName = String(item.pcName || '').trim().replace(/^\\+/, '');
    const username = String(item.username || '').trim();
    const password = String(item.password || '');
    if (!pcName || !username || !password) continue;
    const key = pcName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ pcName, username, password });
  }
  store.set('remoteCredentials', clean);
  return clean;
}

module.exports = {
  isTrusted,
  trustOrigin,
  revokeTrust,
  getTrustedOrigins,
  getApiKey,
  setApiKey,
  getRemoteComputers,
  setRemoteComputers,
  getRemoteCredentials,
  getRemoteCredential,
  setRemoteCredentials
};
