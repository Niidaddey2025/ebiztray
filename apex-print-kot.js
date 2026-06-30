const AGENT_URL = "http://192.168.100.8:7654";

// The receipt/KOT printer reachable by IP (ESC/POS thermal printer).
const KOT_PRINTER = { ip: "192.168.100.5", port: 9100, type: "receipt", widthDots: 576 };

// ---------------------------------------------------------------------------
// List installed (local) printers on the agent machine.
// ---------------------------------------------------------------------------
async function getPrinters() {
    const response = await fetch(AGENT_URL + "/printers", {
        method: "GET",
        headers: { "Content-Type": "application/json" }
    });
    const data = await response.json();
    return (data.printers || []).map(p => (typeof p === "string" ? p : p.name));
}

// ---------------------------------------------------------------------------
// Check whether a printer is online/reachable BEFORE printing.
// Returns the agent's status report: { results: [{ printer, type, online, ... }] }.
// ---------------------------------------------------------------------------
function checkPrinterStatus(printerName) {
    return fetch(AGENT_URL + "/printer-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printers: [{ name: printerName }] })
    }).then(r => r.json());
}

// ---------------------------------------------------------------------------
// Send an HTML receipt/KOT to a thermal printer.
//
// `printerName` is the name of a locally-installed thermal printer (e.g. an
// Epson TM-T20III shared/attached to the agent machine). It is rendered to
// native ESC/POS (`render: 'text'`) and sent RAW to the local spooler so the
// layout matches the network receipt printer exactly. Pass widthDots to match
// the paper: 576 for 80mm, 384 for 58mm.
//
// The agent automatically checks the printer is online first (checkOnline is
// on by default). If it is offline the job is NOT sent and the result for that
// target has status "offline".
// ---------------------------------------------------------------------------
function printKOT(htmlContent, printerName) {
    const payload = {
        printers: [
            { name: printerName, type: "receipt", render: "text", widthDots: 576 }
        ],
        html: htmlContent,
        checkOnline: true
    };

    return fetch(AGENT_URL + "/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    })
    .then(r => r.json())
    .then(function (result) {
        console.log("Print result:", result);
        // Surface offline printers to the caller.
        const offline = (result.results || []).filter(r => r.status === "offline");
        if (offline.length) {
            console.warn("Printer offline, not printed:", offline.map(r => r.printer).join(", "));
        }
        return result;
    })
    .catch(function (err) {
        console.error("Print error:", err);
        throw err;
    });
}

// ---------------------------------------------------------------------------
// Fetch the item rows HTML for a KOT from the APEX server process.
// ---------------------------------------------------------------------------
function gethtml(pcomp_code, porder_no, porder_date, kot_printer) {
    return new Promise(function (resolve, reject) {
        apex.server.process("KOT_ITEMS",
            {
                x01: pcomp_code,
                x02: porder_no,
                x03: porder_date,
                x04: kot_printer
            },
            {
                type: "GET",
                dataType: "text",
                success: function (text) {
                    apex.item("P7022_ITEMS").setValue(text);
                    resolve(text);
                },
                error: function (jqXHR, textStatus, errorThrown) {
                    reject(errorThrown);
                }
            });
    });
}

// ---------------------------------------------------------------------------
// Build the full KOT HTML and print it for each printer.
// ---------------------------------------------------------------------------
function Printjs() {
    const comp_code  = apex.item("P7022_COMP_CODE").getValue();
    const order_no   = apex.item("P7022_ORDER_NO").getValue();
    const order_date = apex.item("P7022_ORDER_DATE").getValue();
    const table_no   = apex.item("P7022_TABLE_NO").getValue();
    const order_time = apex.item("P7022_CRT_TIME").getValue();
    const waiter     = apex.item("P7022_AGENT").getValue();
    const data       = JSON.parse(apex.item("P7022_PRINTERS").getValue());

    for (var i = 0; i < data.printers.length; i++) {
        const printer = data.printers[i];

        gethtml(comp_code, order_no, order_date, printer)
            .then(function (kotHtml1) {
                const kotHtml = `<html><head><style>
                    body{font-family:"Courier New",monospace;font-size:14px;width:100%;margin:0;padding:1%}
                    .title{text-align:center;font-weight:bold;font-size:18px;margin:6px 0}
                    .footer{text-align:center;font-weight:bold;font-size:12px}
                </style></head><body>
                    <div class="title">KITCHEN ORDER TICKET</div>
                    <hr/>
                    <table style="width:100%">
                        <tr><td>Order No</td><td>${order_no}</td></tr>
                        <tr><td>Table</td><td>${table_no}</td></tr>
                        <tr><td>Time</td><td>${order_date} ${order_time}</td></tr>
                        <tr><td>Waiter</td><td>${waiter}</td></tr>
                    </table>
                    <hr/>
                    <table style="width:100%">
                        <tr style="font-weight:bold"><td>Qty</td><td>Item</td></tr>
                        ${kotHtml1}
                    </table>
                    <hr/>
                    <div><b>Kitchen Notes:</b> Prepare Immediately</div>
                    <hr/>
                    <div class="footer">Powered by Ebizframe.ai</div>
                </body></html>`;

                console.log("printer:", printer);
                console.log(kotHtml);
                return printKOT(kotHtml, printer);
            })
            .catch(function (err) {
                console.error(err);
            });
    }
}
