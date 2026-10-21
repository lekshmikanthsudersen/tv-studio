const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const cacheDir = path.join(root, 'cache', 'ffmpeg');
const binDir = path.join(root, 'bin');
const zipPath = path.join(cacheDir, 'ffmpeg-release-essentials-download.zip');
const shaPath = path.join(cacheDir, 'ffmpeg-release-essentials-download.zip.sha256');
const extractDir = path.join(cacheDir, 'extract');
const ffmpegUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const shaUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256';

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('This installer is for the Windows portable package only.');
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  await download(ffmpegUrl, zipPath);
  await download(shaUrl, shaPath);
  verifySha256(zipPath, shaPath);

  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  runPowerShell(['Expand-Archive', '-Path', quote(zipPath), '-DestinationPath', quote(extractDir), '-Force']);

  const ffmpegExe = findFile(extractDir, 'ffmpeg.exe');
  if (!ffmpegExe) {
    throw new Error('ffmpeg.exe was not found in the downloaded archive.');
  }

  fs.copyFileSync(ffmpegExe, path.join(binDir, 'ffmpeg.exe'));
  copyIfFound(extractDir, 'LICENSE', path.join(binDir, 'FFMPEG-LICENSE.txt'));
  copyIfFound(extractDir, 'README.txt', path.join(binDir, 'FFMPEG-README.txt'));
  fs.copyFileSync(shaPath, path.join(binDir, 'ffmpeg-release-essentials.zip.sha256'));

  const version = spawnSync(path.join(binDir, 'ffmpeg.exe'), ['-version'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  if (version.status !== 0) {
    throw new Error(version.stderr || version.stdout || 'Bundled ffmpeg.exe did not run.');
  }

  console.log(version.stdout.split(/\r?\n/)[0]);
  console.log(`Installed FFmpeg to ${path.join(binDir, 'ffmpeg.exe')}`);
}

function download(url, outputPath) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const nextUrl = new URL(response.headers.location, url).toString();
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

function verifySha256(filePath, checksumPath) {
  const expected = fs.readFileSync(checksumPath, 'utf8').match(/[a-fA-F0-9]{64}/)?.[0]?.toLowerCase();
  if (!expected) {
    throw new Error('Could not parse FFmpeg SHA-256 checksum file.');
  }

  const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  if (actual !== expected) {
    throw new Error(`FFmpeg checksum mismatch. Expected ${expected}, got ${actual}.`);
  }
}

function runPowerShell(args) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', args.join(' ')], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'PowerShell command failed.');
  }
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(fullPath, name);
      if (found) {
        return found;
      }
    } else if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) {
      return fullPath;
    }
  }
  return '';
}

function copyIfFound(dir, name, destination) {
  const source = findFile(dir, name);
  if (source) {
    fs.copyFileSync(source, destination);
  }
}

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
