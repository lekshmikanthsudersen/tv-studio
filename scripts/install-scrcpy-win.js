const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = '4.1';
const ARCHIVE = `scrcpy-win64-v${VERSION}.zip`;
const EXPECTED_SHA256 = '5b12172b3264b2889f4583ee64752ce832e29bc8b1089dca81093459697165db';
const root = path.resolve(__dirname, '..');
const cacheDir = path.join(root, 'cache');
const zipPath = path.join(cacheDir, ARCHIVE);
const extractDir = path.join(cacheDir, `scrcpy-extract-v${VERSION}`);
const targetDir = path.join(root, 'scrcpy');
const releaseUrl = `https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/${ARCHIVE}`;

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('This installer currently supports the Windows portable build only.');
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  if (!fs.existsSync(zipPath) || sha256(zipPath) !== EXPECTED_SHA256) {
    await download(releaseUrl, zipPath);
  }
  const actual = sha256(zipPath);
  if (actual !== EXPECTED_SHA256) {
    throw new Error(`scrcpy checksum mismatch. Expected ${EXPECTED_SHA256}, got ${actual}.`);
  }

  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  expandArchive(zipPath, extractDir);
  const sourceDir = path.join(extractDir, `scrcpy-win64-v${VERSION}`);
  if (!fs.existsSync(path.join(sourceDir, 'scrcpy.exe'))) {
    throw new Error('The verified archive did not contain scrcpy.exe.');
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.renameSync(sourceDir, targetDir);
  const probe = spawnSync(path.join(targetDir, 'scrcpy.exe'), ['--version'], {
    cwd: targetDir,
    encoding: 'utf8',
    windowsHide: true
  });
  if (probe.status !== 0) {
    throw new Error(probe.stderr || probe.stdout || 'Installed scrcpy runtime did not start.');
  }
  console.log(probe.stdout.split(/\r?\n/)[0]);
  console.log(`Installed verified scrcpy runtime to ${targetDir}`);
}

function download(url, outputPath) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'TV-Studio-Installer' } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const nextUrl = new URL(response.headers.location, url).toString();
        response.resume();
        download(nextUrl, outputPath).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed (${response.statusCode}) for ${url}`));
        return;
      }
      const file = fs.createWriteStream(outputPath);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    request.on('error', reject);
  });
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function expandArchive(archivePath, destination) {
  const command = `Expand-Archive -LiteralPath '${escapePowerShell(archivePath)}' -DestinationPath '${escapePowerShell(destination)}' -Force`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Unable to extract scrcpy archive.');
  }
}

function escapePowerShell(value) {
  return String(value).replace(/'/g, "''");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
