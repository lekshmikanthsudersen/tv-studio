const assert = require('assert');
const fs = require('fs');
const path = require('path');
const AdbWrapper = require('../src/main/modules/adbWrapper');
const ScrcpyController = require('../src/main/modules/scrcpyController');

const root = path.resolve(__dirname, '..');

async function main() {
  const html = read('src/renderer/index.html');
  const ui = read('src/renderer/uiController.js');
  const preload = read('src/main/preload.js');
  const mainSource = read('src/main/main.js');
  const packageScript = read('scripts/package-win.js');

  const requiredIds = [
    'deviceSelect', 'connectButton', 'mirrorStage', 'startScrcpyButton', 'stopScrcpyButton',
    'scrcpyStatusPill', 'scrcpyQualitySelect', 'installApkButton', 'appGrid', 'openScreenshotButton'
  ];
  for (const id of requiredIds) {
    assert(html.includes(`id="${id}"`), `Renderer is missing #${id}`);
    assert(ui.includes(`getElementById('${id}')`), `UI controller is not bound to #${id}`);
  }

  const boundIds = Array.from(ui.matchAll(/getElementById\('([^']+)'\)/g), (match) => match[1]);
  for (const id of boundIds) {
    assert(html.includes(`id="${id}"`), `UI controller binds missing renderer element #${id}`);
  }

  for (const channel of ['scrcpy:start', 'scrcpy:stop', 'scrcpy:status', 'device:open-screenshot']) {
    assert(mainSource.includes(`'${channel}'`), `Main process is missing ${channel}`);
    assert(preload.includes(`'${channel}'`), `Preload bridge is missing ${channel}`);
  }

  assert(packageScript.includes("'scrcpy'"), 'Windows package does not include scrcpy');

  const adb = new AdbWrapper({ appRoot: root });
  const scrcpy = new ScrcpyController({ adb, appRoot: root });
  const [adbDiagnostics, scrcpyDiagnostics] = await Promise.all([
    adb.getDiagnostics(),
    scrcpy.getDiagnostics()
  ]);
  assert(adbDiagnostics.available, adbDiagnostics.error || 'ADB is unavailable');
  assert(scrcpyDiagnostics.available, scrcpyDiagnostics.error || 'scrcpy is unavailable');
  console.log(`Runtime OK: ${adbDiagnostics.version}; ${scrcpyDiagnostics.version}`);
  console.log(`Contract OK (${boundIds.length} renderer bindings, live control and screenshot IPC)`);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
