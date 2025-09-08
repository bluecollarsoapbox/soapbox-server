// scripts/seed-data.js
// Seed Stories/Spotlights from the repo into Render's persistent disk ONCE.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..'); // repo checkout
const DATA_DIR  = (process.env.DATA_DIR && process.env.DATA_DIR.trim())
  ? process.env.DATA_DIR.trim()
  : '/opt/render/project/data';

const SOURCES = [
  { name: 'Stories',    from: path.join(REPO_ROOT, 'Stories'),    to: path.join(DATA_DIR, 'Stories') },
  { name: 'Spotlights', from: path.join(REPO_ROOT, 'Spotlights'), to: path.join(DATA_DIR, 'Spotlights') },
];

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  await fsp.cp(src, dest, { recursive: true, force: false, errorOnExist: false });
}

(async () => {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });

    for (const { name, from, to } of SOURCES) {
      const srcExists = await exists(from);
      const destExists = await exists(to);
      if (!srcExists) {
        console.log(`[seed] skip ${name}: not present in repo (${from})`);
        continue;
      }
      if (destExists) {
        console.log(`[seed] skip ${name}: already exists on disk (${to})`);
        continue;
      }
      console.log(`[seed] seeding ${name} → ${to}`);
      await copyDir(from, to);
      console.log(`[seed] done ${name}`);
    }

    console.log(`[seed] complete (DATA_DIR=${DATA_DIR})`);
    process.exit(0);
  } catch (e) {
    console.error('[seed] failed:', e?.message || e);
    process.exit(1);
  }
})();
