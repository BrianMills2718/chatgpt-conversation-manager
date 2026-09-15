#!/usr/bin/env node
// Backfills native ChatGPT Project membership for every already-archived
// thread that has an archive-side project assigned but hasn't been mirrored
// yet (or was mirrored to a different project since). Idempotent: skips
// threads whose native_project_ref already matches their current project.
//
// Usage: RENAMER_TOKEN=... node scripts/mirror-projects.js [--dry-run]

import fs from 'node:fs';
import path from 'node:path';

const BROKER_URL = process.env.BROKER_URL || 'http://localhost:8787';
const TOKEN = process.env.RENAMER_TOKEN;
if (!TOKEN) { console.error('Set RENAMER_TOKEN in the environment.'); process.exit(1); }
const DRY_RUN = process.argv.includes('--dry-run');
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.resolve('data');

async function api(apiPath, body) {
  const res = await fetch(`${BROKER_URL}${apiPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// A project's native ref is only known for certain once at least one of its
// threads has been mirrored successfully in THIS run (or a prior run). Cache
// project -> ref as we go so repeat project names don't need re-verification
// beyond the API's own before/after check inside the extension.
function main() {
  const catalogPath = path.join(ARCHIVE_DIR, 'metadata', 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const threads = Object.values(catalog.threads).filter((t) => t.project_name);

  console.log(`${threads.length} threads have an archive-side project. Checking mirror state...`);

  const toMirror = threads.filter((t) => !t.native_project_ref);
  console.log(`${toMirror.length} need mirroring, ${threads.length - toMirror.length} already mirrored.`);
  if (DRY_RUN) {
    for (const t of toMirror) console.log(`  would mirror: ${t.thread_id} "${t.title}" -> ${t.project_name}`);
    return;
  }

  return (async () => {
    let ok = 0, failed = 0;
    for (const t of toMirror) {
      try {
        const result = await api('/api/move-to-project', { thread_id: t.thread_id, project: t.project_name });
        console.log(`[ok] ${t.thread_id} "${t.title}" -> ${t.project_name} (${result.project_ref})`);
        ok++;
      } catch (err) {
        console.error(`[fail] ${t.thread_id} "${t.title}" -> ${t.project_name}: ${err.message}`);
        failed++;
      }
    }
    console.log(`\nDone: ${ok} mirrored, ${failed} failed.`);
  })();
}

main();
