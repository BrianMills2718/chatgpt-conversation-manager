#!/usr/bin/env node
// Imports ChatGPT's official "Export data" ZIP (Settings -> Data Controls ->
// Export data -> conversations.json) directly into the local archive. This is
// the bulk path: one official, rate-limit-safe export request instead of
// hundreds of individual API calls. Reuses the same pure parsing/normalization
// logic the live single-conversation capture uses.
//
// Usage:
//   node scripts/import-chatgpt-export.js <path-to-export.zip | conversations.json | extracted-dir>
//   ARCHIVE_DIR=/custom/path node scripts/import-chatgpt-export.js export.zip

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { linearizeMapping } from '../extension/lib/api-capture.js';
import { buildSnapshot } from '../extension/lib/normalize.js';
import { ArchiveStore } from '../server/archive.js';

export function loadConversations(inputPath) {
  const resolved = path.resolve(inputPath);
  if (resolved.endsWith('.zip')) {
    const raw = execFileSync('unzip', ['-p', resolved, 'conversations.json'], { maxBuffer: 1024 * 1024 * 1024 });
    return JSON.parse(raw.toString('utf8'));
  }
  const stat = fs.statSync(resolved);
  const jsonPath = stat.isDirectory() ? path.join(resolved, 'conversations.json') : resolved;
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node scripts/import-chatgpt-export.js <export.zip | conversations.json | extracted-dir>');
    process.exit(1);
  }
  const archiveDir = process.env.ARCHIVE_DIR || path.resolve('data');
  const archive = new ArchiveStore(archiveDir);

  console.log(`Reading conversations from ${inputPath} ...`);
  const conversations = loadConversations(inputPath);
  console.log(`Found ${conversations.length} conversations in the export.`);

  let archived = 0;
  let skipped = 0;
  const failed = [];

  for (const convo of conversations) {
    const threadId = convo.conversation_id || convo.id;
    if (!threadId) { skipped++; continue; }
    try {
      const messages = linearizeMapping(convo);
      if (!messages.length) { skipped++; continue; }
      const snapshot = buildSnapshot({
        threadId,
        title: convo.title || null,
        titleSource: 'export',
        url: `https://chatgpt.com/c/${threadId}`,
        messages,
        captureSource: 'export',
        completenessWarning: null,
      });
      archive.archiveSnapshot(snapshot);
      archived++;
    } catch (err) {
      failed.push({ thread_id: threadId, title: convo.title || null, error: err.message });
    }
  }

  console.log(`\nDone: ${archived} archived, ${skipped} skipped (empty/no id), ${failed.length} failed.`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  ${f.thread_id} "${f.title}": ${f.error}`);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
