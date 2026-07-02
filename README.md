# EbizTray

A lightweight desktop print agent (like QZ Tray) that runs in the system tray and lets web applications print silently to **local printers** (installed via OS drivers) and **network printers** (reachable by IP, no driver install needed) — **with one-time user approval per origin, no repeated popups**.

## How it works
```
Web App (browser)  --HTTP/WebSocket-->  EbizTray (http://127.0.0.1:7654)
                                              |
                    +-------------------------+--------------------------+--------------------------+
                    v                                                    v                          v
            Local printer (OS driver)                       Network printer (IP)            Remote shared printer (\\PC\Share)
            - PDF via driver (laser/inkjet)                 - PDF -> PS/PCL (laser/inkjet)  - PDF via remote driver
            - ESC/POS RAW (thermal receipt)                 - ESC/POS over :9100 (thermal)  - ESC/POS RAW to remote spooler
```

1. Your web app connects to EbizTray via HTTP or WebSocket on localhost.
2. **First time only:** EbizTray shows a dialog asking the user to approve the origin.
3. Once approved, the origin is trusted permanently (stored on disk). No more popups.
4. All subsequent print requests from that origin go through silently.

## Key differences from QZ Tray
| Feature | QZ Tray | EbizTray |
|---|---|---|
| Approval popups | Every session or certificate-based | **One-time only**, then silent forever |
| Setup complexity | Certificate signing, Java runtime | Single .exe, no dependencies |
| Protocol | WebSocket only | HTTP + WebSocket |
| Printers | Local + raw | **Local, network, and remote shared printers — in one request** |
| Size | ~100MB (bundled Java) | ~80MB (Electron) |

## Setup (Development)
```
npm install
npm start
```
This launches EbizTray in the system tray. Open `test-local.html`, `test-network.html`, `test-remote.html`, or `test-client.html` in a browser to test.

## Configuration
| Variable | Purpose | Default |
|---|---|---|
| `PRINT_AGENT_PORT` | Port to listen on | `7654` |
| `PRINT_AGENT_CHROME_PATH` | Override auto-detected Chrome/Edge path (for HTML rendering) | auto-detected |
| `PRINT_AGENT_GS_PATH` | Override Ghostscript path (for network laser PS/PCL conversion) | auto-detected |

Trusted origins are managed via the system tray icon menu (right-click -> Trusted Origins -> Revoke).

---

## Printing concepts

A print job is sent as a single `POST /print` (or WebSocket `print`) request. It can target **local printers**, **network printers**, **remote shared printers**, or **any combination** — every target prints in parallel.

### Target kinds

| Kind | Where it goes | Good for | How content is rendered |
|---|---|---|---|
| **Local — document** | `printers[]` as a plain name string | Laser/inkjet installed via Windows driver | HTML/PDF rendered to A4 PDF, sent through the OS driver |
| **Local — receipt** | `printers[]` as an object with `type:"receipt"` | Thermal POS printers (e.g. Epson TM-T20III) attached/installed locally | Native **ESC/POS**, streamed RAW to the local spooler |
| **Network — document** | `networkPrinters[]` (default type) | Laser/inkjet reachable by IP | PDF converted to PostScript/PCL via Ghostscript, streamed to the printer |
| **Network — receipt** | `networkPrinters[]` with `type:"receipt"` | Thermal POS printers reachable by IP (port 9100) | Native **ESC/POS**, streamed to the printer socket |
| **Remote — document** | `remotePrinters[]` (default type) | Shared laser/inkjet on another Windows PC on the LAN | HTML/PDF rendered to A4 PDF and sent to the remote PC via `\\PC\Share` |
| **Remote — receipt** | `remotePrinters[]` with `type:"receipt"` | Shared thermal POS printer on another Windows PC on the LAN | Native **ESC/POS** streamed RAW to the remote PC's spooler via `\\PC\Share` |

### Receipt render modes (thermal printers)
For receipt targets, `render` controls how HTML becomes ESC/POS:

- `"text"` (default) — HTML is converted to **native ESC/POS text**: crisp, fast, aligned columns, native QR, logos as bitmaps. Use this for KOTs/receipts.
- `"image"` — the whole receipt is rasterized to a single bitmap. Use only when you need exact pixel-perfect layout/fonts.

`widthDots` must match the paper: **576 = 80mm**, **384 = 58mm**.

> **Local thermal printing** uses the same ESC/POS renderer as network thermal printing, so a locally-attached TM-T20III produces byte-identical output to the same printer over IP — no more A4-PDF reflow mangling the layout.

### Remote (shared) printers

EbizTray can also print to printers that are **shared by other Windows PCs on the LAN**. This is useful when the agent runs on a central server but the physical printers are connected to workstations (e.g. a kitchen PC or a bar PC).

Requirements:
- EbizTray runs on a Windows server that can reach the remote PCs.
- The remote PC has **File & Printer Sharing** enabled.
- The printer is **Shared** and has a share name.
- The server's Windows account has permission to use the share.

Remote targets are addressed as `{ pcName: "PCNAME", name: "ShareName" }` and EbizTray prints to them using the same Windows spooler paths as local printers (`\\PCNAME\ShareName`).

---

## API

### `GET /health`
Returns: `{ "status": "ok", "version": "1.0.0", "name": "EbizTray", "printers": [ ... ] }`

### `GET /printers`
Lists installed (local) printers.
Returns: `{ "printers": [ { "name": "EPSON TM-T20III", "driver": "...", "port": "USB001", "status": "..." } ] }`

### `GET /network-printers`
Discovers printers on the LAN (mDNS + subnet scan).
Optional query params: `mdns=0|1`, `scan=0|1`, `mdnsTimeout`, `scanTimeout`.
Returns: `{ "printers": [ { "name": "...", "ip": "192.168.1.50", "port": 9100, "protocol": "raw" } ] }`

### `GET /remote-computers`
Returns the persisted list of known remote computer names.
Returns: `{ "computers": ["BAR-PC", "KITCHEN-PC"] }`

### `POST /remote-computers`
Replaces the persisted list of known remote computer names.
Body: `{ "computers": ["BAR-PC", "KITCHEN-PC"] }`
Returns: `{ "computers": ["BAR-PC", "KITCHEN-PC"] }`

### `GET /remote-printers`
Discovers shared printers on the remote PCs. If no `computers` query param is provided, the persisted list from `/remote-computers` is used.
Query: `?computers=BAR-PC,KITCHEN-PC`
Returns:
```json
{
  "computers": ["BAR-PC", "KITCHEN-PC"],
  "results": [
    { "pcName": "KITCHEN-PC", "online": true, "printers": [
      { "name": "EPSON TM-T20III", "shareName": "EPSON TM-T20III", "displayName": "EPSON TM-T20III", "driver": "...", "status": "Normal" }
    ]}
  ]
}
```

### `POST /printer-status`
Check whether printers are online/reachable **without printing**. Body accepts the same `printers[]`, `networkPrinters[]`, and `remotePrinters[]` as `/print`.
```json
{
  "printers": [ { "name": "EPSON TM-T20III" } ],
  "networkPrinters": [ { "ip": "192.168.1.50", "port": 9100 } ]
}
```
Returns:
```json
{
  "results": [
    { "printer": "EPSON TM-T20III", "type": "local",   "online": true,  "found": true, "status": "Normal" },
    { "printer": "192.168.1.50:9100", "type": "network", "online": false, "found": true, "status": "offline" }
  ]
}
```
- **Network** printers are checked with a TCP probe of the printing port (reliable).
- **Local** printers are checked via the OS spooler status; note some USB thermal printers report "Normal" until a job actually fails.

### `POST /print`
Send a job to any combination of local and network printers. See the JSON examples below.

**Online pre-check:** by default (`checkOnline: true`) every target is checked for reachability *before* anything is rendered or sent. Offline targets are **not printed to** and come back with `status: "offline"`. Set `"checkOnline": false` to skip the check and print unconditionally.

Per-target `status` values: `"sent"`, `"offline"`, or `"failed"`. The top-level `status` is `"offline"` only when *every* target was offline (nothing was sent), otherwise `"sent"` (something was sent) or `"failed"`.

Returns a per-target result array:
```json
{
  "status": "sent",
  "results": [
    { "printer": "EPSON TM-T20III (receipt)", "type": "local",   "status": "sent" },
    { "printer": "192.168.1.50:9100 (receipt)", "type": "network", "status": "sent" }
  ]
}
```

---

## `POST /print` request examples

### 1. Local printer — document (laser/inkjet via OS driver)
```json
{
  "printers": ["HP LaserJet Pro"],
  "pdfUrl": "https://yourapp.com/invoices/123.pdf",
  "copies": 1
}
```
You can also send `"html"` instead of `"pdfUrl"`:
```json
{
  "printers": ["HP LaserJet Pro"],
  "html": "<h1>Invoice #123</h1><p>Thank you.</p>"
}
```

### 2. Local printer — thermal receipt (ESC/POS via RAW spooler)
```json
{
  "printers": [
    { "name": "EPSON TM-T20III", "type": "receipt", "render": "text", "widthDots": 576 }
  ],
  "html": "<div style=\"text-align:center;font-weight:bold\">KITCHEN ORDER TICKET</div><hr/><table style=\"width:100%\"><tr><td>Table</td><td>7</td></tr></table>",
  "copies": 1
}
```
Plain text (no HTML rendering) instead of `html`:
```json
{
  "printers": [
    { "name": "EPSON TM-T20III", "type": "receipt" }
  ],
  "text": "ORDER #1978\nTable 7\n2x Club Lager Mint\n",
  "copies": 1
}
```

### 3. Network printer — thermal receipt (ESC/POS over port 9100)
```json
{
  "networkPrinters": [
    { "ip": "192.168.1.50", "port": 9100, "type": "receipt", "render": "text", "widthDots": 576 }
  ],
  "html": "<div style=\"text-align:center;font-weight:bold\">RECEIPT</div><hr/><div>Total: 12.00</div>"
}
```

### 4. Network printer — document (laser/inkjet by IP)
```json
{
  "networkPrinters": [
    { "ip": "192.168.1.20", "port": 9100, "protocol": "raw", "language": "postscript" }
  ],
  "pdfUrl": "https://yourapp.com/invoices/123.pdf",
  "copies": 2
}
```
`language` may be `"postscript"` (default), `"pcl"`, `"pclxl"`, or `"pdf"` (send PDF bytes verbatim for printers with a built-in PDF interpreter). `protocol` may be `"raw"` (9100), `"ipp"` (631), or `"lpd"` (515).

### 5. Both at once — local thermal + network thermal in one request
```json
{
  "printers": [
    { "name": "EPSON TM-T20III", "type": "receipt", "render": "text", "widthDots": 576 }
  ],
  "networkPrinters": [
    { "ip": "192.168.1.50", "port": 9100, "type": "receipt", "render": "text", "widthDots": 576 }
  ],
  "html": "<div style=\"text-align:center;font-weight:bold\">KITCHEN ORDER TICKET</div><hr/><table style=\"width:100%\"><tr><td>Order No</td><td>1978</td></tr><tr><td>Table</td><td>7</td></tr></table>",
  "copies": 1
}
```

### 6. Remote shared printer — thermal receipt on another PC
```json
{
  "remotePrinters": [
    { "pcName": "KITCHEN-PC", "name": "EPSON TM-T20III", "type": "receipt", "render": "text", "widthDots": 576 }
  ],
  "html": "<div style=\"text-align:center;font-weight:bold\">KITCHEN ORDER TICKET</div><hr/><div>Table: 7</div>"
}
```

Remote shared printers are addressed by their UNC share name (`\\PCNAME\ShareName`). The `name` field must be the **share name** of the printer on the remote PC.

### Pass raw ESC/POS yourself (any receipt target)
If you already have ESC/POS bytes, send them base64-encoded and skip rendering:
```json
{
  "printers": [ { "name": "EPSON TM-T20III", "type": "receipt", "escposBase64": "G0AbYQE..." } ]
}
```

### Field reference
| Field | Applies to | Notes |
|---|---|---|
| `printers[]` | local | String name (document) or object `{ name, type, render, widthDots, cut, align, bold, text, escposBase64 }` |
| `networkPrinters[]` | network | `{ ip, port, protocol, language, name, type, render, widthDots, cut, align, bold, text, escposBase64 }` |
| `remotePrinters[]` | remote | `{ pcName, name, type, render, widthDots, cut, align, bold, text, escposBase64 }`. `name` is the printer's **share name** on `\\pcName` |
| `pdfUrl` / `html` | document + receipt(html) | Source document. Receipt `render` modes require `html` (or `text`) — they cannot rasterize a remote PDF |
| `text` | receipt | Plain-text content; takes precedence over `html` for that target |
| `render` | receipt | `"text"` (default) or `"image"` |
| `widthDots` | receipt | `576` = 80mm, `384` = 58mm |
| `cut` | receipt | `false` to disable the auto paper cut (default `true`) |
| `copies` | all | Number of copies (default `1`) |

---

## WebSocket API
Connect to `ws://localhost:7654` and send JSON messages (same payloads as `POST /print`, plus a `type` and `id`):
```json
{ "type": "listPrinters", "id": 1 }
{ "type": "discoverNetworkPrinters", "id": 2 }
{ "type": "discoverRemotePrinters", "id": 3, "computers": ["BAR-PC", "KITCHEN-PC"] }
{ "type": "listRemoteComputers", "id": 4 }
{ "type": "setRemoteComputers", "id": 5, "computers": ["BAR-PC", "KITCHEN-PC"] }
{
  "type": "print",
  "id": 6,
  "printers": [ { "name": "EPSON TM-T20III", "type": "receipt", "render": "text", "widthDots": 576 } ],
  "networkPrinters": [ { "ip": "192.168.1.50", "port": 9100, "type": "receipt", "render": "text" } ],
  "remotePrinters": [ { "pcName": "KITCHEN-PC", "name": "EPSON TM-T20III", "type": "receipt", "render": "text", "widthDots": 576 } ],
  "html": "<h1>Receipt</h1>"
}
```
Responses are keyed by the same `id`: `printers`, `networkPrinters`, `remotePrinters`, `remoteComputers`, `printResult`, or `error`.

---

## Calling from your web app
```js
// HTTP: print a KOT to a LOCAL thermal printer + a NETWORK thermal printer at once
async function printKOT(html) {
  const res = await fetch('http://localhost:7654/print', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      printers: [
        { name: 'EPSON TM-T20III', type: 'receipt', render: 'text', widthDots: 576 }
      ],
      networkPrinters: [
        { ip: '192.168.1.50', port: 9100, type: 'receipt', render: 'text', widthDots: 576 }
      ],
      html
    })
  });
  console.log(await res.json());
}

// WebSocket: persistent connection
const ws = new WebSocket('ws://localhost:7654');
ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'print',
    id: 1,
    printers: [{ name: 'EPSON TM-T20III', type: 'receipt', render: 'text', widthDots: 576 }],
    html: '<h1>Receipt #123</h1>'
  }));
};
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

See `apex-print-kot.js` for a complete Oracle APEX example that builds KOT HTML and prints it.

## Building the .exe
```
npm run build
```
This produces a Windows installer and portable .exe in `dist/`.

## Security
- Binds to `0.0.0.0:7654` so it can also receive jobs on the LAN, but every request is gated by the **origin trust check**.
- **One-time trust approval** per origin — only sites the user explicitly approves can print.
- Trusted origins list is visible and revocable from the tray icon menu.
- No shared secrets or certificates to manage.

## Running at startup
- **Windows:** The installer can optionally add EbizTray to startup. Or manually: drop a shortcut in `shell:startup`.
- **macOS:** Add to Login Items or use a launchd plist.
- **Linux:** Create a systemd user service.

## Troubleshooting
- **Local thermal layout looks reflowed/wrong:** make sure the target is a receipt object (`type:"receipt"`, `render:"text"`) and not a plain name string — a plain string prints via the A4 PDF driver path.
- **Wrong width / wrapping:** set `widthDots` to match the paper (`576` for 80mm, `384` for 58mm).
- **Local RAW print fails:** the printer must be installed on the agent machine with a driver that accepts RAW jobs (standard for Epson TM drivers / "Generic / Text Only").
- **Network laser prints blank:** install Ghostscript (or set `PRINT_AGENT_GS_PATH`) so PDFs can be converted to PostScript/PCL, or set `language:"pdf"` if the printer has a built-in PDF interpreter.
- **Remote shared printer not found:** verify the remote PC is online, File & Printer Sharing is enabled, the printer is shared, and the server account has permission to use the share.
