const { Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const trustManager = require('./trust-manager');

let tray = null;

function createTray(app, port) {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
  } catch (e) {
    // Fallback: create a simple colored icon if no file found
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip(`EbizTray - Print Agent (port ${port})`);

  updateContextMenu(app, port);

  tray.on('double-click', () => {
    // Could open a settings window in the future
  });

  return tray;
}

function updateContextMenu(app, port) {
  const trustedOrigins = trustManager.getTrustedOrigins();

  const trustedItems = trustedOrigins.length > 0
    ? trustedOrigins.map(origin => ({
        label: origin,
        submenu: [
          {
            label: 'Revoke Trust',
            click: () => {
              trustManager.revokeTrust(origin);
              updateContextMenu(app, port);
            }
          }
        ]
      }))
    : [{ label: '(none)', enabled: false }];

  const contextMenu = Menu.buildFromTemplate([
    { label: `EbizTray v1.0.0`, enabled: false },
    { label: `Listening on port ${port}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Trusted Origins',
      submenu: trustedItems
    },
    { type: 'separator' },
    {
      label: 'View Printers',
      click: () => {
        shell.openExternal(`http://localhost:${port}/printers.html`);
      }
    },
    {
      label: 'Remote Printers',
      click: () => {
        shell.openExternal(`http://localhost:${port}/test-remote.html`);
      }
    },
    { type: 'separator' },
    {
      label: 'Quit EbizTray',
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = {
  createTray,
  updateContextMenu,
  destroyTray
};
