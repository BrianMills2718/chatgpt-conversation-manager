import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConversations } from '../scripts/import-chatgpt-export.js';

function sampleExport() {
  return [
    {
      id: 'conv-1',
      conversation_id: 'conv-1',
      title: 'Sample',
      mapping: {
        root: { id: 'root', message: null, parent: null },
        u1: { id: 'u1', message: { author: { role: 'user' }, content: { parts: ['hi'] }, create_time: 1 }, parent: 'root' },
      },
      current_node: 'u1',
    },
  ];
}

test('loadConversations reads a plain conversations.json file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-import-test-'));
  const file = path.join(dir, 'conversations.json');
  fs.writeFileSync(file, JSON.stringify(sampleExport()));
  const result = loadConversations(file);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'conv-1');
});

test('loadConversations reads conversations.json from an extracted export directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-import-test-'));
  fs.writeFileSync(path.join(dir, 'conversations.json'), JSON.stringify(sampleExport()));
  const result = loadConversations(dir);
  assert.equal(result.length, 1);
});

test('loadConversations extracts conversations.json from a real zip', (t) => {
  try {
    execFileSync('zip', ['-v'], { stdio: 'ignore' });
  } catch {
    t.skip('zip CLI not available in this environment');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-import-test-'));
  fs.writeFileSync(path.join(dir, 'conversations.json'), JSON.stringify(sampleExport()));
  fs.writeFileSync(path.join(dir, 'user.json'), '{}'); // real exports have other files alongside
  const zipPath = path.join(dir, 'export.zip');
  execFileSync('zip', ['-j', zipPath, path.join(dir, 'conversations.json'), path.join(dir, 'user.json')]);
  const result = loadConversations(zipPath);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'conv-1');
});
