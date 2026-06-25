// ---------------------------------------------------------------------------
// ESC/POS renderer
//
// Builds raw ESC/POS byte streams for thermal receipt printers (e.g. Epson
// TM-T20III) from either plain text or a rendered PNG bitmap. The resulting
// buffer is streamed directly to the printer's port (usually 9100).
//
// Receipt printers do NOT understand PDF/PostScript/PCL — they expect ESC/POS
// command bytes, which is why a normal "print this PDF" job comes out blank.
// ---------------------------------------------------------------------------

// Common ESC/POS control bytes.
const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

// Low-level command helpers (return Buffers, no init/cut wrapping).
const cmdAlign = (align) => Buffer.from([ESC, 0x61, align === 'center' ? 1 : align === 'right' ? 2 : 0]);
const cmdBold = (on) => Buffer.from([ESC, 0x45, on ? 1 : 0]);
// GS ! n : bits 4-7 width magnification, bits 0-3 height magnification.
const cmdSize = (widthMul = 1, heightMul = 1) => {
  const w = Math.max(0, Math.min(7, widthMul - 1));
  const h = Math.max(0, Math.min(7, heightMul - 1));
  return Buffer.from([GS, 0x21, (w << 4) | h]);
};
const cmdFeed = (n) => Buffer.from([ESC, 0x64, n]);
const cmdCut = () => Buffer.from([GS, 0x56, 66, 0]);
const cmdInit = () => Buffer.from([ESC, 0x40]);

const INIT = Buffer.from([ESC, 0x40]);                 // ESC @  - initialize
const ALIGN_LEFT = Buffer.from([ESC, 0x61, 0]);
const ALIGN_CENTER = Buffer.from([ESC, 0x61, 1]);
const ALIGN_RIGHT = Buffer.from([ESC, 0x61, 2]);
const BOLD_ON = Buffer.from([ESC, 0x45, 1]);
const BOLD_OFF = Buffer.from([ESC, 0x45, 0]);
const FEED_AND_CUT = Buffer.from([GS, 0x56, 66, 0]);   // GS V 66 0 - feed + partial cut
const FEED_LINES = (n) => Buffer.from([ESC, 0x64, n]); // ESC d n - feed n lines

function alignBytes(align) {
  if (align === 'center') return ALIGN_CENTER;
  if (align === 'right') return ALIGN_RIGHT;
  return ALIGN_LEFT;
}

// ---------------------------------------------------------------------------
// Text -> ESC/POS
// ---------------------------------------------------------------------------
/**
 * Build an ESC/POS buffer from plain text.
 * options: { align, bold, cut, feed }
 */
function escposFromText(text, options = {}) {
  const { align = 'left', bold = false, cut = true, feed = 4 } = options;
  const parts = [INIT, alignBytes(align)];
  if (bold) parts.push(BOLD_ON);

  // Normalize newlines and append a trailing newline.
  const normalized = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  parts.push(Buffer.from(normalized + '\n', 'latin1'));

  if (bold) parts.push(BOLD_OFF);
  parts.push(FEED_LINES(feed));
  if (cut) parts.push(FEED_AND_CUT);

  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Image (PNG pixels) -> ESC/POS raster
// ---------------------------------------------------------------------------
/**
 * Convert decoded RGBA pixel data to a 1-bit-per-pixel monochrome bitmap and
 * wrap it in ESC/POS "GS v 0" raster commands. Uses Floyd–Steinberg dithering
 * so photos/anti-aliased text reproduce well on a 1-bit printer.
 *
 * image = { width, height, data } where data is RGBA (Uint8Array/Buffer).
 * options: { threshold (0-255, default 128), dither (default true),
 *            cut (default true), feed (default 4), bandHeight (default 128) }
 */
function escposFromImage(image, options = {}) {
  const { width, height, data } = image;
  const { threshold = 128, dither = true, cut = true, feed = 4, bandHeight = 128 } = options;

  // 1) Convert to grayscale luminance (0 = black, 255 = white).
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3];
    // Composite onto white using alpha, then luminance.
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    gray[i] = (lum * a + 255 * (255 - a)) / 255;
  }

  // 2) Threshold (with optional Floyd–Steinberg dithering) -> black bitmap.
  //    blackBit[i] = 1 means print a dot (black).
  const blackBit = new Uint8Array(width * height);
  if (dither) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const oldPix = gray[idx];
        const newPix = oldPix < threshold ? 0 : 255;
        blackBit[idx] = newPix === 0 ? 1 : 0;
        const err = oldPix - newPix;
        if (x + 1 < width) gray[idx + 1] += err * 7 / 16;
        if (y + 1 < height) {
          if (x > 0) gray[idx + width - 1] += err * 3 / 16;
          gray[idx + width] += err * 5 / 16;
          if (x + 1 < width) gray[idx + width + 1] += err * 1 / 16;
        }
      }
    }
  } else {
    for (let i = 0; i < width * height; i++) {
      blackBit[i] = gray[i] < threshold ? 1 : 0;
    }
  }

  // 3) Pack into ESC/POS raster bands ("GS v 0").
  const raster = packRaster(blackBit, width, height, bandHeight);

  const parts = [INIT, ALIGN_CENTER, raster, FEED_LINES(feed)];
  if (cut) parts.push(FEED_AND_CUT);
  return Buffer.concat(parts);
}

/**
 * Pack a 1-bit black/white bitmap into ESC/POS "GS v 0" raster command bands.
 * Returns ONLY the raster command bytes (no init/feed/cut) so it can be
 * embedded inline within a larger receipt stream.
 */
function packRaster(blackBit, width, height, bandHeight = 128) {
  const bytesPerRow = Math.ceil(width / 8);
  const xL = bytesPerRow & 0xff;
  const xH = (bytesPerRow >> 8) & 0xff;
  const parts = [];

  for (let bandStart = 0; bandStart < height; bandStart += bandHeight) {
    const rows = Math.min(bandHeight, height - bandStart);
    const band = Buffer.alloc(bytesPerRow * rows, 0);
    for (let y = 0; y < rows; y++) {
      const srcY = bandStart + y;
      for (let x = 0; x < width; x++) {
        if (blackBit[srcY * width + x]) {
          band[y * bytesPerRow + (x >> 3)] |= (0x80 >> (x & 7));
        }
      }
    }
    const header = Buffer.from([GS, 0x76, 0x30, 0x00, xL, xH, rows & 0xff, (rows >> 8) & 0xff]);
    parts.push(header, band);
  }
  return Buffer.concat(parts);
}

/**
 * Convert decoded RGBA pixels to the raster command bytes only (no init/cut),
 * for embedding a logo/image inside a larger receipt. Same thresholding as
 * escposFromImage.
 */
function imageToRaster(image, options = {}) {
  const { threshold = 128, dither = true, bandHeight = 128 } = options;
  const { width, height, data } = image;

  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    gray[i] = (lum * a + 255 * (255 - a)) / 255;
  }

  const blackBit = new Uint8Array(width * height);
  if (dither) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const oldPix = gray[idx];
        const newPix = oldPix < threshold ? 0 : 255;
        blackBit[idx] = newPix === 0 ? 1 : 0;
        const err = oldPix - newPix;
        if (x + 1 < width) gray[idx + 1] += err * 7 / 16;
        if (y + 1 < height) {
          if (x > 0) gray[idx + width - 1] += err * 3 / 16;
          gray[idx + width] += err * 5 / 16;
          if (x + 1 < width) gray[idx + width + 1] += err * 1 / 16;
        }
      }
    }
  } else {
    for (let i = 0; i < width * height; i++) blackBit[i] = gray[i] < threshold ? 1 : 0;
  }

  return packRaster(blackBit, width, height, bandHeight);
}

/**
 * Decode a PNG buffer to the embeddable raster command bytes (no init/cut).
 */
function pngToRaster(pngBuffer, options = {}) {
  const PNG = require('pngjs').PNG;
  const png = PNG.sync.read(pngBuffer);
  return imageToRaster({ width: png.width, height: png.height, data: png.data }, options);
}

// ---------------------------------------------------------------------------
// Native QR code (ESC/POS GS ( k, model 2) — crisp and scannable, far better
// than a rasterized QR image. Supported by Epson TM-T20III and most ESC/POS.
// ---------------------------------------------------------------------------
/**
 * Build the GS ( k command sequence to print a QR code.
 * options: { moduleSize (1-16, default 6), ec ('L'|'M'|'Q'|'H', default 'M') }
 */
function escposQrCode(data, options = {}) {
  const moduleSize = Math.max(1, Math.min(16, options.moduleSize || 6));
  const ecMap = { L: 48, M: 49, Q: 50, H: 51 };
  const ec = ecMap[(options.ec || 'M').toUpperCase()] || 49;
  const payload = Buffer.from(String(data), 'utf8');

  const fn = (...bytes) => Buffer.from(bytes);
  // Select model 2.
  const model = fn(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00);
  // Module (dot) size.
  const size = fn(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize);
  // Error correction level.
  const level = fn(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, ec);
  // Store the data in the symbol storage area.
  const storeLen = payload.length + 3;
  const store = Buffer.concat([
    fn(GS, 0x28, 0x6b, storeLen & 0xff, (storeLen >> 8) & 0xff, 0x31, 0x50, 0x30),
    payload
  ]);
  // Print the stored symbol.
  const print = fn(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);

  return Buffer.concat([model, size, level, store, print]);
}

/**
 * Decode a PNG buffer (via pngjs) and build an ESC/POS raster buffer.
 */
function escposFromPng(pngBuffer, options = {}) {
  let PNG;
  try {
    PNG = require('pngjs').PNG;
  } catch (e) {
    throw new Error('Receipt image rendering requires the "pngjs" package.');
  }
  const png = PNG.sync.read(pngBuffer);
  return escposFromImage({ width: png.width, height: png.height, data: png.data }, options);
}

module.exports = {
  escposFromText,
  escposFromImage,
  escposFromPng,
  imageToRaster,
  pngToRaster,
  escposQrCode,
  // Low-level command builders for assembling custom receipt streams.
  cmd: { init: cmdInit, align: cmdAlign, bold: cmdBold, size: cmdSize, feed: cmdFeed, cut: cmdCut }
};
