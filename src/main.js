/**
 * MotoFull masaüstü uygulaması — ana süreç.
 *
 * MİMARİ: Uygulama paneli PAKETLEMEZ, canlı paneli
 * (panel.motofull.com.tr) güvenli bir pencerede açar. Bunun üç sonucu var:
 *   1. Web ile masaüstü birebir aynı paneldir; panel her yayınlandığında
 *      masaüstü de güncellenir, ayrı sürüm takibi gerekmez.
 *   2. Çevrimdışı çalışma YOKTUR (bilinçli karar): her istek sunucuda
 *      kimlik doğrulamasından geçer, pasif edilen hesap anında düşer.
 *   3. Veri tek kaynaktan (API) gelir; web, mobil ve masaüstü aynı
 *      gerçek zamanlı kanala bağlanır.
 *
 * GÜVENLİK: Node erişimi yok (sandbox + contextIsolation), panel dışına
 * gezinme engellenir, dış bağlantılar sistem tarayıcısında açılır.
 */
const { app, BrowserWindow, shell, session, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const PANEL_URL = (process.env.MOTOFULL_PANEL_URL || 'https://panel.motofull.com.tr').replace(/\/$/, '');
const PANEL_ORIGIN = new URL(PANEL_URL).origin;
const UA_SUFFIX = `MotoFullDesktop/${app.getVersion()}`;

let mainWindow = null;

/* Tek örnek: ikinci kez açılırsa mevcut pencere öne gelir. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

const isPanelUrl = (url) => {
  try { return new URL(url).origin === PANEL_ORIGIN; } catch { return false; }
};

const openExternal = (url) => {
  try {
    const { protocol } = new URL(url);
    // Yalnızca güvenli şemalar; file:, javascript: vb. asla.
    if (['https:', 'http:', 'mailto:', 'tel:'].includes(protocol)) shell.openExternal(url);
  } catch { /* geçersiz adres — yok say */ }
};

/* ── Pencere boyutunu hatırla ─────────────────────────────── */
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const readState = () => {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
};
const saveState = (win) => {
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch { /* yazılamazsa önemli değil */ }
};

const showOffline = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadFile(path.join(__dirname, 'offline.html'));
};

function createWindow() {
  const state = readState();
  mainWindow = new BrowserWindow({
    width: state.width || 1400,
    height: state.height || 900,
    x: state.x,
    y: state.y,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0b0f17',
    title: 'MotoFull',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  if (state.maximized) mainWindow.maximize();

  const wc = mainWindow.webContents;
  wc.setUserAgent(`${wc.getUserAgent()} ${UA_SUFFIX}`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', () => saveState(mainWindow));

  /* Panel dışına gezinme: sistem tarayıcısına yönlendir. */
  wc.on('will-navigate', (event, url) => {
    if (isPanelUrl(url) || url.startsWith('file://')) return;
    event.preventDefault();
    openExternal(url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    // Panelin kendi yazdırma/önizleme pencereleri (about:blank, blob:) açılabilir.
    if (url === 'about:blank' || url.startsWith('blob:') || isPanelUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
        },
      };
    }
    openExternal(url);
    return { action: 'deny' };
  });

  /* Sunucuya ulaşılamazsa çevrimdışı ekranı (yalnızca ana çerçeve). */
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ABORTED: normal yönlendirme */) return;
    if (url && url.startsWith('file://')) return;
    showOffline();
  });

  /* Web Serial (OBD / ELM327): tarayıcıdaki port seçicinin karşılığı. */
  wc.session.on('select-serial-port', (event, portList, _wc, callback) => {
    event.preventDefault();
    if (!portList.length) return callback('');
    if (portList.length === 1) return callback(portList[0].portId);
    const labels = portList.map((p) => p.displayName || p.portName || p.portId);
    dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'OBD cihazı',
      message: 'Bağlanılacak portu seçin',
      buttons: [...labels, 'İptal'],
      cancelId: labels.length,
    }).then(({ response }) => callback(response < labels.length ? portList[response].portId : ''));
  });

  /* Duman testi: MOTOFULL_SMOKE=<png yolu> ise yüklenince ekran görüntüsü
     alıp durumu yazar ve kapanır (CI ve yerel doğrulama için). */
  if (process.env.MOTOFULL_SMOKE) {
    wc.once('did-finish-load', () => setTimeout(async () => {
      const probe = await wc.executeJavaScript(
        'JSON.stringify({ url: location.href, title: document.title, desktop: !!window.motofullDesktop?.isDesktop, ua: navigator.userAgent.includes("MotoFullDesktop") })'
      ).catch((e) => String(e));
      const img = await wc.capturePage();
      fs.writeFileSync(process.env.MOTOFULL_SMOKE, img.toPNG());
      console.log(`SMOKE ${probe}`);
      app.quit();
    }, 6000));
  }

  mainWindow.loadURL(PANEL_URL);
}

ipcMain.on('motofull:retry', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(PANEL_URL);
});

app.whenReady().then(() => {
  /* İzinler: yalnızca panel kaynağına ve yalnızca gerekenlere. */
  const ALLOWED = new Set(['media', 'clipboard-sanitized-write', 'notifications', 'fullscreen', 'serial', 'geolocation']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(isPanelUrl(wc.getURL()) && ALLOWED.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) =>
    origin === PANEL_ORIGIN && ALLOWED.has(permission));
  session.defaultSession.setDevicePermissionHandler((details) =>
    details.origin === PANEL_ORIGIN && details.deviceType === 'serial');

  /* macOS'ta kopyala/yapıştır kısayolları menü gerektirir. */
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

/* Hiçbir içerik <webview> ile ikinci bir tarayıcı gömemez. */
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
