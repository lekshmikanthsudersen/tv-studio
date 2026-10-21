// Run with Electron, for example: electron scripts/renderer-layout-test.js 1.25
// This hidden, static renderer has no preload, IPC, discovery, or TV connection.
const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const scale = Number(process.argv[2] || 1.25);
assert([1, 1.25, 1.5].includes(scale), 'Use scale 1, 1.25, or 1.5');
app.commandLine.appendSwitch('force-device-scale-factor', String(scale));
app.setPath('userData', path.resolve(__dirname, `../../tvstudio-layout-profile-${scale}`));
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const results = [];
  for (const [width, height] of [[1080, 680], [1440, 900]]) {
    const window = new BrowserWindow({ width, height, useContentSize: true, frame: false, show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
    window.webContents.session.webRequest.onBeforeRequest((request, callback) => {
      callback({ cancel: request.url.endsWith('/uiController.js') });
    });
    await window.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
    // Win32 frame rounding varies by scale; use an exact CSS viewport for these layout checks.
    window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width, height }, viewSize: { width, height }, deviceScaleFactor: scale, scale: 1 });
    for (const expanded of [false, true]) {
      const result = await window.webContents.executeJavaScript(`(async () => {
        document.querySelectorAll('details').forEach(element => { element.open = ${expanded}; });
        document.getElementById('connectionMessage').textContent = 'Sony BRAVIA VU3 · Android 14 · 1920×1080';
        document.getElementById('scrcpyStatusPill').textContent = 'TV window live';
        document.getElementById('commandStatusLabel').textContent = 'TV window ready; click it to control your TV';
        document.getElementById('screenshotMessage').textContent = 'Saved screenshot-2026-10-22-123456789.png (1.2s)';
        document.getElementById('openScreenshotButton').hidden = false;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rect = element => {
          const r = element.getBoundingClientRect();
          return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom };
        };
        const dpad = rect(document.querySelector('.dpad-shell'));
        const quick = rect(document.querySelector('.quick-remote'));
        const stage = rect(document.getElementById('mirrorStage'));
        const checkbox = rect(document.getElementById('autoTypeToggle'));
        const input = rect(document.getElementById('textInput'));
        const right = document.querySelector('.right-pane');
        const clipped = [...right.querySelectorAll('button, select, input, summary')]
          .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
          .filter(element => { const closed = element.closest('details:not([open])'); return !closed || element === closed.querySelector('summary'); })
          .filter(element => { const r = rect(element); return r.x < -1 || r.right > innerWidth + 1 || r.y < -1 || r.bottom > innerHeight + 1; })
          .map(element => element.id || element.textContent.trim());
        const overlappingDpad = [...document.querySelectorAll('.dpad-button')].some(element => rect(element).right > quick.x + 0.5);
        return { viewport:[innerWidth,innerHeight], dpr:devicePixelRatio, expanded:${expanded}, dpad, quick, stage,
          checkboxHeight:checkbox.height, inputHeight:input.height, clipped, overlappingDpad,
          bodyOverflow:document.documentElement.scrollWidth > innerWidth,
          sidebarOverflow:document.querySelector('.left-pane').scrollWidth > document.querySelector('.left-pane').clientWidth + 1 };
      })()`);
      assert.deepEqual(result.viewport, [width, height]);
      assert.equal(result.dpr, scale);
      assert.equal(result.overlappingDpad, false, 'D-pad overlaps quick remote');
      assert.equal(result.checkboxHeight, 14, 'Checkbox inherited text field height');
      assert.equal(result.inputHeight, 42);
      assert.equal(result.bodyOverflow, false, 'Horizontal document overflow');
      assert.equal(result.sidebarOverflow, false, 'Horizontal sidebar overflow');
      assert.deepEqual(result.clipped, [], 'Right-side controls clipped');
      assert(result.stage.height > 0, 'Preview stage collapsed');
      results.push(result);
    }
    window.destroy();
  }
  console.log(JSON.stringify({ scale, results }, null, 2));
  app.exit(0);
}).catch(error => { console.error(error.stack || error); app.exit(1); });
