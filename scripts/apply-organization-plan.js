#!/usr/bin/env node
// Applies a classification plan (array of {thread_id, project, series?,
// sequence?, stage?, new_title?}) to the archive + live ChatGPT via the broker
// REST API. Renames only threads with a non-null new_title; sequences only
// threads with a sequence number. Safe to re-run (project assignment and
// numbering are idempotent; a rename is skipped if the title already matches).
//
// Usage: node scripts/apply-organization-plan.js <plan.json>
//   BROKER_URL=http://localhost:8787 RENAMER_TOKEN=... node scripts/apply-organization-plan.js plan.json

import fs from 'node:fs';

const BROKER_URL = process.env.BROKER_URL || 'http://localhost:8787';
const TOKEN = process.env.RENAMER_TOKEN;
if (!TOKEN) { console.error('Set RENAMER_TOKEN in the environment.'); process.exit(1); }

async function api(path, body) {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function main() {
  const planPath = process.argv[2];
  if (!planPath) { console.error('Usage: node scripts/apply-organization-plan.js <plan.json>'); process.exit(1); }
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  console.log(`Applying plan for ${plan.length} threads...`);

  let projectsOk = 0, projectsFailed = 0, renamed = 0, renameFailed = 0, sequenced = 0, sequenceFailed = 0;

  for (const entry of plan) {
    const { thread_id, project, series, sequence, stage, new_title } = entry;
    if (project) {
      try {
        await api('/api/project', { thread_id, project });
        projectsOk++;
      } catch (err) {
        projectsFailed++;
        console.error(`[project] ${thread_id} "${project}": ${err.message}`);
      }
    }

    if (new_title) {
      try {
        await api('/api/rename', { thread_id, title: new_title });
        renamed++;
      } catch (err) {
        renameFailed++;
        console.error(`[rename] ${thread_id} -> "${new_title}": ${err.message}`);
      }
    }

    if (sequence) {
      try {
        await api('/api/number', { thread_id, project, series: series || 'default', stage, sequence, rename_visible_chat: false });
        sequenced++;
      } catch (err) {
        sequenceFailed++;
        console.error(`[number] ${thread_id} seq=${sequence}: ${err.message}`);
      }
    }
  }

  console.log(`\nProjects: ${projectsOk} ok, ${projectsFailed} failed.`);
  console.log(`Renames: ${renamed} ok, ${renameFailed} failed.`);
  console.log(`Sequencing: ${sequenced} ok, ${sequenceFailed} failed.`);
}

main();
