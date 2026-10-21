const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const electronDist = process.env.TV_STUDIO_ELECTRON_DIST
  ? path.resolve(process.env.TV_STUDIO_ELECTRON_DIST)
  : path.join(root, 'node_modules', 'electron', 'dist');
const outputRoot = process.env.TV_STUDIO_OUTPUT_ROOT
  ? path.resolve(process.env.TV_STUDIO_OUTPUT_ROOT)
  : path.join(root, 'dist');
const outputDir = path.join(outputRoot, 'TVStudio-win32-x64');
const appDir = path.join(outputDir, 'resources', 'app');
const electronExe = path.join(outputDir, 'electron.exe');
const appExe = path.join(outputDir, 'TVStudio.exe');

const requiredRuntimeFiles = [
  'src',
  'scrcpy',
  'package.json',
  'README.md',
  'docs',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md'
];

function assertExists(target, label) {
  if (!fs.existsSync(target)) {
    throw new Error(`${label} was not found: ${target}`);
  }
}

function copyPath(source, destination) {
  if (!fs.existsSync(source)) {
    return;
  }

  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.cpSync(source, destination, {
      recursive: true,
      force: true,
      filter: (entry) => {
        const baseName = path.basename(entry);
        return !['node_modules', 'dist', '.git'].includes(baseName);
      }
    });
    return;
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

assertExists(electronDist, 'Electron runtime');
assertExists(path.join(electronDist, 'electron.exe'), 'Electron executable');
assertExists(path.join(root, 'src', 'main', 'main.js'), 'App entry point');
assertExists(path.join(root, 'scrcpy', 'scrcpy.exe'), 'scrcpy runtime');

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

fs.cpSync(electronDist, outputDir, {
  recursive: true,
  force: true
});

fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });

for (const file of requiredRuntimeFiles) {
  copyPath(path.join(root, file), path.join(appDir, file));
}

if (fs.existsSync(appExe)) {
  fs.rmSync(appExe, { force: true });
}
fs.renameSync(electronExe, appExe);

const metadata = {
  name: 'TVStudio',
  version: require(path.join(root, 'package.json')).version,
  builtAt: new Date().toISOString(),
  entry: 'resources/app/src/main/main.js',
  notes: [
    'This is a portable Electron build. Keep the DLLs and resources next to TVStudio.exe.',
    'ADB is bundled with scrcpy in resources/app/scrcpy and can be overridden via ANDROID_TV_CONTROLLER_ADB.',
    'The primary interactive mirror uses scrcpy. Legacy H.264 fallback requires ANDROID_TV_CONTROLLER_FFMPEG or ffmpeg on PATH.'
  ]
};

fs.writeFileSync(
  path.join(outputDir, 'BUILD_INFO.json'),
  `${JSON.stringify(metadata, null, 2)}\n`,
  'utf8'
);

console.log(`Windows portable build created: ${appExe}`);
