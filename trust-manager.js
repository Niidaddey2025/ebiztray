const Store = require('electron-store');

const store = new Store({
  name: 'EbizTray-config',
  defaults: {
    trustedOrigins: [],
    apiKey: 'replace-this-with-a-long-random-key'
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
  return store.get('apiKey', 'replace-this-with-a-long-random-key');
}

/**
 * Set the API key.
 */
function setApiKey(key) {
  store.set('apiKey', key);
}

module.exports = {
  isTrusted,
  trustOrigin,
  revokeTrust,
  getTrustedOrigins,
  getApiKey,
  setApiKey
};
