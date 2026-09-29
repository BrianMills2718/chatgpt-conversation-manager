#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const archiveDir = process.env.ARCHIVE_DIR || path.resolve('data');
const file = path.join(archiveDir, 'observations', 'bridge-events.jsonl');
if (!fs.existsSync(file)) {
  console.log(JSON.stringify({ events: 0, message: 'No bridge observations have been captured yet.', file }, null, 2));
  process.exit(0);
}

// A machine crash mid-append leaves NUL padding or a torn line (three WSL
// crashes on 2026-09-28 did). Skip such lines but report them, rather than
// aborting the whole report on the first one.
const events = [];
const damagedLines = [];
fs.readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
  const line = raw.replace(/\0/g, '').trim();
  if (!line) { if (raw.length) damagedLines.push(i + 1); return; }
  try { events.push(JSON.parse(line)); } catch { damagedLines.push(i + 1); }
});
if (damagedLines.length) console.error(`warning: skipped ${damagedLines.length} damaged line(s) in ${file}: ${damagedLines.slice(0, 20).join(', ')}${damagedLines.length > 20 ? ', ...' : ''}`);
const countBy = (key) => Object.fromEntries(Object.entries(events.reduce((counts, event) => {
  const value = event[key] ?? 'null';
  counts[value] = (counts[value] || 0) + 1;
  return counts;
}, {})).sort(([a], [b]) => a.localeCompare(b)));
const durations = events.map((event) => event.duration_ms).filter(Number.isFinite).sort((a, b) => a - b);
const percentile = (p) => durations.length ? durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * p))] : null;
console.log(JSON.stringify({
  damaged_lines_skipped: damagedLines.length,
  events: events.length,
  by_outcome: countBy('outcome'),
  by_failure_kind: countBy('failure_kind'),
  by_conversation_mode: countBy('conversation_mode'),
  by_thinking_level: countBy('thinking_level'),
  duration_ms: { median: percentile(0.5), p95: percentile(0.95) },
  rate_limited_events: events.filter((event) => event.failure_kind === 'rate_limited').map((event) => ({ started_at: event.started_at, ended_at: event.ended_at, thread_id: event.thread_id, conversation_mode: event.conversation_mode, history_message_count: event.history_message_count })),
  file
}, null, 2));
