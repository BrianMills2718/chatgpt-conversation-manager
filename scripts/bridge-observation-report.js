#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const archiveDir = process.env.ARCHIVE_DIR || path.resolve('data');
const file = path.join(archiveDir, 'observations', 'bridge-events.jsonl');
if (!fs.existsSync(file)) {
  console.log(JSON.stringify({ events: 0, message: 'No bridge observations have been captured yet.', file }, null, 2));
  process.exit(0);
}

const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const countBy = (key) => Object.fromEntries(Object.entries(events.reduce((counts, event) => {
  const value = event[key] ?? 'null';
  counts[value] = (counts[value] || 0) + 1;
  return counts;
}, {})).sort(([a], [b]) => a.localeCompare(b)));
const durations = events.map((event) => event.duration_ms).filter(Number.isFinite).sort((a, b) => a - b);
const percentile = (p) => durations.length ? durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * p))] : null;
console.log(JSON.stringify({
  events: events.length,
  by_outcome: countBy('outcome'),
  by_failure_kind: countBy('failure_kind'),
  by_conversation_mode: countBy('conversation_mode'),
  by_thinking_level: countBy('thinking_level'),
  duration_ms: { median: percentile(0.5), p95: percentile(0.95) },
  rate_limited_events: events.filter((event) => event.failure_kind === 'rate_limited').map((event) => ({ started_at: event.started_at, ended_at: event.ended_at, thread_id: event.thread_id, conversation_mode: event.conversation_mode, history_message_count: event.history_message_count })),
  file
}, null, 2));
