const { app, dialog, BrowserWindow, Notification, nativeImage } = require('electron');
const path = require('path');
const { startServer, setApprovalCallback } = require('./print-server');
const { createTray, updateContextMenu, destroyTray } = require('./tray-manager');

// App icon shown in dialogs and notifications (not just the tray).
const appIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-icon.png'));

// Required on Windows for notifications to display the app icon/identity.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.EbizTray.print-agent');
}

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Hide from dock on macOS (tray-only app)
if (process.platform === 'darwin') {
  app.dock.hide();
}

// Pending approval requests (to avoid duplicate dialogs for same origin)
const pendingApprovals = new Map();

/**
 * Show a one-time approval dialog when a new origin tries to connect.
 * Returns a promise that resolves to true (approved) or false (denied).
 */
function showApprovalDialog(origin) {
  // If there's already a pending dialog for this origin, return that promise
  if (pendingApprovals.has(origin)) {
    return pendingApprovals.get(origin);
  }

  const promise = new Promise((resolve) => {
    dialog.showMessageBox(null, {
      type: 'question',
      buttons: ['Allow', 'Deny'],
      defaultId: 0,
      cancelId: 1,
      icon: appIcon,
      title: 'EbizTray - New Print Request',
      message: `Allow printing from this origin?`,
      detail: `"${origin}" is requesting access to your printers.\n\nIf you allow, this origin will be trusted permanently and won't ask again.\n\nYou can revoke trust later from the tray icon menu.`,
      noLink: true
    }).then(({ response }) => {
      pendingApprovals.delete(origin);
      const approved = response === 0;
      if (approved) {
        // Show a notification confirming trust
        if (Notification.isSupported()) {
          new Notification({
            title: 'EbizTray',
            body: `${origin} is now trusted for printing.`,
            icon: appIcon
          }).show();
        }
        // Refresh tray menu to show new trusted origin
        updateContextMenu(app, serverPort);
      }
      resolve(approved);
    }).catch(() => {
      pendingApprovals.delete(origin);
      resolve(false);
    });
  });

  pendingApprovals.set(origin, promise);
  return promise;
}

let serverPort = 7654;

app.whenReady().then(async () => {
  // Set the approval callback so the print server can trigger dialogs
  setApprovalCallback(showApprovalDialog);

  // Start the print server
  try {
    serverPort = await startServer();
    console.log(`EbizTray started on port ${serverPort}`);
  } catch (err) {
    dialog.showErrorBox('EbizTray Error', `Failed to start print server: ${err.message}`);
    app.quit();
    return;
  }

  // Create system tray
  createTray(app, serverPort);

  // Show startup notification
  if (Notification.isSupported()) {
    new Notification({
      title: 'EbizTray',
      body: `Print agent running on port ${serverPort}. Right-click tray icon for options.`,
      icon: appIcon
    }).show();
  }
});

// Keep app running when all windows are closed (it's a tray app)
app.on('window-all-closed', () => {
  // Do nothing — keep running as a tray app
});

app.on('before-quit', () => {
  destroyTray();
});
