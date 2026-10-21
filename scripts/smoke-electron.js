const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronBin = require('electron');
const env = {
  ...process.env,
  ANDROID_TV_CONTROLLER_SMOKE: '1',
  ELECTRON_ENABLE_LOGGING: '1'
};

const result = process.platform === 'win32'
  ? spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `$env:ANDROID_TV_CONTROLLER_SMOKE='1'; $env:ELECTRON_ENABLE_LOGGING='1'; & '${electronBin.replace(/'/g, "''")}' '.'; exit $LASTEXITCODE`
  ], {
    cwd: root,
    stdio: 'inherit',
    env,
    timeout: 20000,
    windowsHide: true
  })
  : spawnSync(electronBin, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env,
    timeout: 20000
  });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.signal) {
  console.error(`Electron smoke test ended with signal ${result.signal}.`);
  process.exit(1);
}
process.exit(result.status ?? 1);
