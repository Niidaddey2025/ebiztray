const fs = require('fs');
const path = require('path');

// A minimal 16x16 PNG of a printer icon (base64 encoded)
// This is a simple solid-color printer silhouette
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA' +
  'nElEQVQ4y2NgGAWDATAyMDD8J0H/f0YGBgZGYjQwMTAwMBCr' +
  'gYWBgYGBWA0sDCQaQJIXSNJAqhdI0kCqF0jSQKoXiNbAwMBA' +
  'tBdYGBgYSPICCwMDA9FeYGAgzQvEamBhYGAg2gssJHqBJC+Q' +
  'pIFUL5CkgVQvkKSBVC8QrYGFhP//E6thFIyCUTDgAABMzhW7' +
  'bvHCDAAAAABJRU5ErkJggg==';

const buffer = Buffer.from(pngBase64, 'base64');
const outPath = path.join(__dirname, 'assets', 'tray-icon.png');
fs.writeFileSync(outPath, buffer);
console.log('Created', outPath);
