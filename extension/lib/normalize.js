// Pure snapshot normalization. No DOM/chrome globals so this is unit-testable with node:test.

// De-duplicate by message_id when available (authoritative, e.g. from the API path),
// otherwise fall back to a role+text-prefix key (best-effort, e.g. DOM path where
// stable IDs may be missing). Order of first occurrence is preserved.
export function dedupeMessages(messages) {
  const seen = new Set();
  const out = [];
  for (const m of messages || []) {
    if (!m || !m.text) continue;
    const key = m.message_id ? `id:${m.message_id}` : `text:${m.role}:${String(m.text).slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

export function buildSnapshot(input, { now = () => new Date().toISOString() } = {}) {
  const { threadId, title, titleSource, url, messages, captureSource, completenessWarning } = input;
  return {
    thread_id: threadId,
    title: title || null,
    title_source: titleSource || null,
    url: url || null,
    updated_at: now(),
    capture_source: captureSource || null,
    completeness_warning: completenessWarning || null,
    messages: dedupeMessages(messages),
  };
}

// Fingerprint used client-side to avoid sending a snapshot to the broker when
// nothing observable has changed since the last send. This is a light debounce
// aid, distinct from the server's content-hash which governs history writes.
export function snapshotFingerprint(snapshot) {
  return JSON.stringify([
    snapshot.thread_id,
    snapshot.title,
    snapshot.capture_source,
    (snapshot.messages || []).map((m) => [m.message_id, m.role, m.text]),
  ]);
}
