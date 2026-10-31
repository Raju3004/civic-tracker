// There is no bundler or type-checker in this project, so "build" = every JS file must parse.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['node_modules', '.git', '.vercel', 'upgrade-screenshots']);
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

let failed = 0;
const files = walk(path.join(__dirname, '..'));
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`SYNTAX ERROR in ${path.relative(process.cwd(), file)}\n${err.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} JS files parse cleanly`);
process.exit(failed ? 1 : 0);
