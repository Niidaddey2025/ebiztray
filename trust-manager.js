const Store = require('electron-store');

const store = new Store({
  name: 'EbizTray-config',
  defaults: {
    trustedOrigins: [],
    apiKey: '9Xf3KqT8mN2VzA7LpD4HyJ6RwE1UcB5GsZ8NtQ0MxY',
    // Names of LAN computers whose shared printers can be used as remote
    // printers (e.g. ['BAR-PC', 'KITCHEN-PC']).
    remoteComputers: []
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

module.exports = {
  isTrusted,
  trustOrigin,
  revokeTrust,
  getTrustedOrigins,
  getApiKey,
  setApiKey,
  getRemoteComputers,
  setRemoteComputers
};
