'use strict';
const { app, BrowserWindow, protocol, session, Menu, shell, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { localURL, resource, allowedDownload, isSourceLink } = require('./policy.cjs');
const selfTest = process.argv.includes('--self-test');
const testOutput = process.env.HOMELAND_TEST_RESULT;
const configPath = fs.existsSync(path.join(__dirname, 'site.config.json'))
  ? path.join(__dirname, 'site.config.json')
  : path.resolve(__dirname, '../../site.config.json');
const repositoryUrl = JSON.parse(fs.readFileSync(configPath, 'utf8')).repositoryUrl;
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'homeland',
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);
app.setName('家园蓝图');
if (selfTest) app.setPath('userData', path.join(app.getPath('temp'), 'homeland-self-test'));
let window;
let finished = false;
function finish(result, code) {
  if (finished) return;
  finished = true;
  const line = JSON.stringify(result);
  console.log('HOMELAND_TEST ' + line);
  if (testOutput) fs.writeFileSync(testOutput, line + '\n');
  app.exit(code);
}
app
  .whenReady()
  .then(async () => {
    const root = fs.existsSync(path.join(__dirname, 'web', 'index.html'))
      ? path.join(__dirname, 'web')
      : path.resolve(__dirname, '../web/dist');
    await protocol.handle('homeland', async (request) => {
      if (request.method !== 'GET') return new Response('', { status: 405 });
      const value = await resource(request.url, root);
      return new Response(value.body ?? '', { status: value.status, headers: value.headers });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({
        cancel:
          !localURL(details.url) &&
          !details.url.startsWith('blob:homeland://app/') &&
          !details.url.startsWith('data:'),
      });
    });
    session.defaultSession.on('will-download', (event, item) => {
      if (!allowedDownload(item.getURL(), item.getFilename())) {
        event.preventDefault();
        return;
      }
      const ext = path.extname(item.getFilename()).slice(1);
      item.setSaveDialogOptions({
        title:
          ext === 'zip' ? '保存家园蓝图完整包' : ext === 'json' ? '保存布置工程' : '保存家园蓝图',
        filters: [
          {
            name: ext === 'zip' ? '蓝图完整包' : ext === 'json' ? '布置工程' : '家园蓝图',
            extensions: [ext],
          },
        ],
      });
    });
    window = new BrowserWindow({
      width: 1260,
      height: 900,
      minWidth: 780,
      minHeight: 680,
      show: !selfTest,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#2a2229' : '#fcf4f6',
      title: '家园蓝图 · 基础展示',
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: !app.isPackaged,
      },
    });
    Menu.setApplicationMenu(null);
    const openSourceLink = (url) => {
      if (isSourceLink(url, repositoryUrl))
        shell.openExternal(url).catch((error) => console.error('无法打开源码仓库', error));
    };
    window.webContents.setWindowOpenHandler(({ url }) => {
      openSourceLink(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (!localURL(url)) {
        event.preventDefault();
        openSourceLink(url);
      }
    });
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.webContents.on('render-process-gone', (_event, detail) => {
      if (selfTest) finish({ ok: false, error: detail.reason }, 1);
    });
    if (selfTest) {
      window.webContents.on('console-message', (details) => {
        if (details.message.startsWith('HOMELAND_RUNTIME ')) {
          try {
            const result = JSON.parse(details.message.slice(17));
            finish(
              {
                ...result,
                versions: process.versions,
                packaged: app.isPackaged,
                platform: process.platform,
                arch: process.arch,
              },
              result.ok ? 0 : 1,
            );
          } catch (error) {
            finish({ ok: false, error: String(error) }, 1);
          }
        }
      });
      setTimeout(() => finish({ ok: false, error: '桌面运行时验证超时' }, 1), 60000);
    }
    await window.loadURL('homeland://app/' + (selfTest ? 'runtime-check.html' : 'index.html'));
    if (!selfTest)
      window.on('closed', () => {
        window = undefined;
      });
  })
  .catch((error) => {
    if (selfTest) finish({ ok: false, error: String(error) }, 1);
    else {
      console.error(error);
      app.quit();
    }
  });
app.on('window-all-closed', () => app.quit());
