const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const targets = [
  path.join(root, 'src'),
  path.join(root, 'scripts')
];

function collectJsFiles(dir, files = []) {
  if (!fs.existsSync(dir)) {
    return files;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

const files = targets.flatMap((target) => collectJsFiles(target));
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout);
  }
}

if (failed) {
  process.exit(1);
}

console.log(`Syntax OK (${files.length} JavaScript files)`);
