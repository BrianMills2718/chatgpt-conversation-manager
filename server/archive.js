import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function safeName(value) {
  return String(value || 'untitled').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'untitled';
}

function escMd(s) {
  return String(s ?? '').replace(/\r\n/g, '\n');
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k] ?? null;
  return out;
}

export const THREAD_STATUSES = ['current', 'superseded', 'reference', 'final', 'abandoned'];

// Fields undoLastAction knows how to snapshot/restore per action type. Keeping
// this explicit (rather than diffing the whole thread object) avoids undo
// accidentally reverting unrelated fields a later action legitimately changed.
const UNDOABLE_FIELDS = {
  assign_project: ['project_id', 'project_name'],
  number_thread: ['series', 'sequence', 'stage'],
  set_status: ['status'],
};

export class ArchiveStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.rawDir = path.join(this.root, 'raw', 'chats');
    this.wikiDir = path.join(this.root, 'wiki');
    this.metaDir = path.join(this.root, 'metadata');
    this.catalogPath = path.join(this.metaDir, 'catalog.json');
    fs.mkdirSync(this.rawDir, { recursive: true });
    fs.mkdirSync(this.wikiDir, { recursive: true });
    fs.mkdirSync(this.metaDir, { recursive: true });
    if (!fs.existsSync(this.catalogPath)) this.writeCatalog({ threads: {}, projects: {}, actions: [] });
  }

  readCatalog() {
    try { return JSON.parse(fs.readFileSync(this.catalogPath, 'utf8')); }
    catch { return { threads: {}, projects: {}, actions: [] }; }
  }

  writeCatalog(catalog) {
    const tmp = `${this.catalogPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2));
    fs.renameSync(tmp, this.catalogPath);
  }

  threadPaths(threadId) {
    const base = safeName(threadId);
    return {
      json: path.join(this.rawDir, `${base}.json`),
      md: path.join(this.rawDir, `${base}.md`),
      history: path.join(this.rawDir, `${base}.history.jsonl`),
    };
  }

  // `account` is the signed-in ChatGPT identity of the tab that produced the snapshot.
  // It is provenance, not content, so it is kept out of the content hash.
  archiveSnapshot(snapshot, { account = null } = {}) {
    if (!snapshot?.thread_id) throw new Error('snapshot.thread_id is required');
    const now = new Date().toISOString();
    const canonical = {
      schema_version: 1,
      ...snapshot,
      captured_at: now,
    };
    const semantic = { ...canonical };
    delete semantic.captured_at;
    delete semantic.capture_account;
    const bytes = JSON.stringify(semantic);
    canonical.content_hash = crypto.createHash('sha256').update(bytes).digest('hex');

    const p = this.threadPaths(snapshot.thread_id);
    let priorHash = null;
    let priorAccount = null;
    if (fs.existsSync(p.json)) {
      try { const prior = JSON.parse(fs.readFileSync(p.json, 'utf8')); priorHash = prior.content_hash || null; priorAccount = prior.capture_account || null; } catch {}
    }
    canonical.capture_account = account || priorAccount || null;
    if (priorHash !== canonical.content_hash || (account && account !== priorAccount)) {
      fs.appendFileSync(p.history, JSON.stringify(canonical) + '\n');
      fs.writeFileSync(p.json, JSON.stringify(canonical, null, 2));
      fs.writeFileSync(p.md, this.toMarkdown(canonical));
    }

    const catalog = this.readCatalog();
    const existing = catalog.threads[snapshot.thread_id] || {};
    catalog.threads[snapshot.thread_id] = {
      status: 'current',
      parent_thread_id: null,
      ...existing,
      thread_id: snapshot.thread_id,
      title: snapshot.title || existing.title || 'Untitled',
      url: snapshot.url || existing.url || null,
      created_at: existing.created_at || snapshot.created_at || now,
      updated_at: snapshot.updated_at || now,
      last_captured_at: now,
      content_hash: canonical.content_hash,
      message_count: Array.isArray(snapshot.messages) ? snapshot.messages.length : 0,
      capture_source: snapshot.capture_source || existing.capture_source || null,
      completeness_warning: snapshot.completeness_warning ?? existing.completeness_warning ?? null,
      // null means captured before accounts were recorded; it is never guessed.
      account: existing.account || account || null,
      accounts_seen: [...new Set([...(existing.accounts_seen || (existing.account ? [existing.account] : [])), ...(account ? [account] : [])])],
    };
    if (account && existing.account && existing.account !== account) {
      catalog.threads[snapshot.thread_id].account_conflict = true;
      console.error(`[archive] thread ${snapshot.thread_id} was captured from ${existing.account} and now from ${account}`);
    }
    this.writeCatalog(catalog);
    return catalog.threads[snapshot.thread_id];
  }

  toMarkdown(s) {
    const lines = [
      '---',
      `thread_id: ${JSON.stringify(s.thread_id)}`,
      `title: ${JSON.stringify(s.title || 'Untitled')}`,
      `url: ${JSON.stringify(s.url || '')}`,
      `captured_at: ${JSON.stringify(s.captured_at)}`,
      `content_hash: ${JSON.stringify(s.content_hash || '')}`,
      '---',
      '',
      `# ${s.title || 'Untitled'}`,
      '',
    ];
    for (const m of s.messages || []) {
      lines.push(`## ${m.role || 'unknown'}`);
      if (m.message_id) lines.push(`<!-- message_id: ${m.message_id} -->`);
      lines.push('', escMd(m.text || ''), '');
    }
    return lines.join('\n');
  }

  assignProject(threadId, projectName) {
    const catalog = this.readCatalog();
    const t = catalog.threads[threadId];
    if (!t) throw new Error(`Unknown archived thread: ${threadId}`);
    const before = pick(t, UNDOABLE_FIELDS.assign_project);
    const projectId = safeName(projectName.toLowerCase());
    catalog.projects[projectId] ||= { project_id: projectId, name: projectName, created_at: new Date().toISOString() };
    t.project_id = projectId;
    t.project_name = projectName;
    t.updated_at = new Date().toISOString();
    this.recordAction(catalog, { type: 'assign_project', thread_id: threadId, project_id: projectId, before });
    this.writeCatalog(catalog);
    return t;
  }

  setThreadParent(threadId, parentThreadId) {
    const catalog = this.readCatalog();
    const t = catalog.threads[threadId];
    if (!t) throw new Error(`Unknown archived thread: ${threadId}`);
    if (parentThreadId && !catalog.threads[parentThreadId]) throw new Error(`Unknown parent thread: ${parentThreadId}`);
    if (parentThreadId === threadId) throw new Error('A thread cannot be its own parent.');
    t.parent_thread_id = parentThreadId || null;
    t.updated_at = new Date().toISOString();
    this.recordAction(catalog, { type: 'set_parent', thread_id: threadId, parent_thread_id: t.parent_thread_id });
    this.writeCatalog(catalog);
    return t;
  }

  setThreadStatus(threadId, statusValue) {
    if (!THREAD_STATUSES.includes(statusValue)) throw new Error(`status must be one of: ${THREAD_STATUSES.join(', ')}`);
    const catalog = this.readCatalog();
    const t = catalog.threads[threadId];
    if (!t) throw new Error(`Unknown archived thread: ${threadId}`);
    const before = pick(t, UNDOABLE_FIELDS.set_status);
    t.status = statusValue;
    t.updated_at = new Date().toISOString();
    this.recordAction(catalog, { type: 'set_status', thread_id: threadId, status: statusValue, before });
    this.writeCatalog(catalog);
    return t;
  }

  // Records that a thread has been mirrored into a native ChatGPT project
  // (see move_to_project / /api/move-to-project). Purely informational —
  // lets batch mirror scripts skip threads already correctly placed instead
  // of re-running the DOM automation on every rerun.
  setNativeProjectRef(threadId, projectRef) {
    const catalog = this.readCatalog();
    const t = catalog.threads[threadId];
    if (!t) throw new Error(`Unknown archived thread: ${threadId}`);
    t.native_project_ref = projectRef;
    this.writeCatalog(catalog);
    return t;
  }

  // Free-form secondary relevance, distinct from the required primary project.
  // A revision series (sequence/stage) only makes sense scoped to one project,
  // so project stays single-valued; tags are how a thread can be cross-cutting.
  addTag(threadId, tag) {
    const clean = String(tag || '').trim();
    if (!clean) throw new Error('tag is required');
    const catalog = this.readCatalog();
    const t = catalog.threads[threadId];
    if (!t) throw new Error(`Unknown archived thread: ${threadId}`);
    t.tags ||= [];
    if (!t.tags.includes(clean)) t.tags.push(clean);
    t.updated_at = new Date().toISOString();
    this.writeCatalog(catalog);
    return t;
  }

  removeTag(threadId, tag) {
    const catalog = this.readCatalog();
    const t = catalog.threads[threadId];
    if (!t) throw new Error(`Unknown archived thread: ${threadId}`);
    t.tags = (t.tags || []).filter((x) => x !== tag);
    t.updated_at = new Date().toISOString();
    this.writeCatalog(catalog);
    return t;
  }

  // Reverts the most recent undoable action recorded for this thread (project
  // assignment, sequence/series/stage change, or status change). Lineage
  // (`set_parent`) and checkpoints are intentionally left out of scope here —
  // parent links are cheap to re-set, and checkpoints are additive history that
  // should not silently disappear.
  undoLastAction(threadId) {
    const catalog = this.readCatalog();
    const t = catalog.threads[threadId];
    if (!t) throw new Error(`Unknown archived thread: ${threadId}`);
    const actions = catalog.actions || [];
    const idx = [...actions].reverse().findIndex((a) => a.thread_id === threadId && UNDOABLE_FIELDS[a.type] && !a.undone);
    if (idx === -1) throw new Error(`No undoable action found for thread: ${threadId}`);
    const action = actions[actions.length - 1 - idx];
    Object.assign(t, action.before);
    t.updated_at = new Date().toISOString();
    action.undone = true;
    this.recordAction(catalog, { type: 'undo', thread_id: threadId, reverted_action_id: action.action_id, reverted_type: action.type });
    this.writeCatalog(catalog);
    return t;
  }

  nextSequence(projectId, series = 'default') {
    const catalog = this.readCatalog();
    let max = 0;
    for (const t of Object.values(catalog.threads)) {
      if (t.project_id === projectId && (t.series || 'default') === series && Number.isFinite(Number(t.sequence))) {
        max = Math.max(max, Number(t.sequence));
      }
    }
    return max + 1;
  }

  numberThread(threadId, { projectName, series = 'default', stage = null, sequence = null } = {}) {
    let catalog = this.readCatalog();
    let t = catalog.threads[threadId];
    if (!t) throw new Error(`Unknown archived thread: ${threadId}`);
    if (projectName) {
      this.assignProject(threadId, projectName);
      catalog = this.readCatalog();
      t = catalog.threads[threadId];
    }
    if (!t.project_id) throw new Error('Assign the thread to a project before numbering it.');
    const seq = sequence == null ? this.nextSequence(t.project_id, series) : Number(sequence);
    if (!Number.isInteger(seq) || seq < 1) throw new Error('sequence must be a positive integer');
    const existingHolder = Object.values(catalog.threads).find(
      (other) => other.thread_id !== threadId && other.project_id === t.project_id && (other.series || 'default') === series && Number(other.sequence) === seq
    );
    if (existingHolder && sequence != null) {
      throw new Error(`Sequence ${seq} in series "${series}" is already used by "${existingHolder.title}" (${existingHolder.thread_id}). Pass an explicit different sequence to override.`);
    }
    const before = pick(t, UNDOABLE_FIELDS.number_thread);
    t.series = series;
    t.sequence = seq;
    if (stage) t.stage = stage;
    t.updated_at = new Date().toISOString();
    this.recordAction(catalog, { type: 'number_thread', thread_id: threadId, sequence: seq, series, stage, before });
    this.writeCatalog(catalog);
    return t;
  }

  saveCheckpoint(threadId, checkpoint) {
    const catalog = this.readCatalog();
    const t = catalog.threads[threadId];
    if (!t) throw new Error(`Unknown archived thread: ${threadId}`);
    t.checkpoints ||= [];
    const cp = {
      checkpoint_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      status: checkpoint.status || 'current',
      summary: checkpoint.summary || '',
      decisions: checkpoint.decisions || [],
      open_questions: checkpoint.open_questions || [],
      next_steps: checkpoint.next_steps || [],
      source_message_ids: checkpoint.source_message_ids || [],
    };
    t.checkpoints.push(cp);
    this.recordAction(catalog, { type: 'checkpoint', thread_id: threadId, checkpoint_id: cp.checkpoint_id });
    this.writeCatalog(catalog);
    this.writeProjectWiki(t.project_id);
    return cp;
  }

  search(query, { project = null, limit = 8, threadId = null, status = null, since = null, until = null, tag = null } = {}) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    const catalog = this.readCatalog();
    const rows = [];
    const sinceMs = since ? Date.parse(since) : null;
    const untilMs = until ? Date.parse(until) : null;
    for (const t of Object.values(catalog.threads)) {
      if (project && !(t.project_name || '').toLowerCase().includes(project.toLowerCase()) && t.project_id !== project) continue;
      if (threadId && t.thread_id !== threadId) continue;
      if (status && t.status !== status) continue;
      if (tag && !(t.tags || []).includes(tag)) continue;
      if (sinceMs != null && Date.parse(t.updated_at || t.last_captured_at || 0) < sinceMs) continue;
      if (untilMs != null && Date.parse(t.updated_at || t.last_captured_at || 0) > untilMs) continue;
      const p = this.threadPaths(t.thread_id);
      if (!fs.existsSync(p.md)) continue;
      const text = fs.readFileSync(p.md, 'utf8');
      const lower = text.toLowerCase();
      let score = 0;
      for (const term of terms) {
        const matches = lower.split(term).length - 1;
        score += matches;
        if ((t.title || '').toLowerCase().includes(term)) score += 5;
        if ((t.project_name || '').toLowerCase().includes(term)) score += 3;
      }
      if (!score) continue;
      const firstPos = Math.min(...terms.map(term => lower.indexOf(term)).filter(n => n >= 0));
      const start = Math.max(0, firstPos - 240);
      const snippet = text.slice(start, start + 900).replace(/\n{3,}/g, '\n\n');
      rows.push({ thread_id: t.thread_id, title: t.title, project: t.project_name || null, sequence: t.sequence || null, stage: t.stage || null, status: t.status || null, parent_thread_id: t.parent_thread_id || null, tags: t.tags || [], score, snippet });
    }
    return rows.sort((a, b) => b.score - a.score).slice(0, Math.min(Number(limit) || 8, 25));
  }

  getThread(threadId) {
    const p = this.threadPaths(threadId);
    if (!fs.existsSync(p.json)) return null;
    return JSON.parse(fs.readFileSync(p.json, 'utf8'));
  }

  writeProjectWiki(projectId) {
    if (!projectId) return;
    const catalog = this.readCatalog();
    const project = catalog.projects[projectId];
    if (!project) return;
    const threads = Object.values(catalog.threads)
      .filter(t => t.project_id === projectId)
      .sort((a, b) => (a.sequence || 999999) - (b.sequence || 999999) || String(a.created_at).localeCompare(String(b.created_at)));
    const lines = [`# ${project.name}`, '', '## Thread index', ''];
    for (const t of threads) {
      // If the title has already been renamed to include its number/stage
      // (e.g. "01 — Initial Critique — Graph Paper"), don't re-prepend/append
      // them — just list the title as-is.
      const alreadyFormatted = t.sequence && new RegExp(`^${String(t.sequence).padStart(2, '0')}\\s*[—–-]`).test(t.title || '');
      const num = !alreadyFormatted && t.sequence ? String(t.sequence).padStart(2, '0') + ' — ' : '';
      const stage = !alreadyFormatted && t.stage ? ` — ${t.stage}` : '';
      const statusTag = t.status && t.status !== 'current' ? ` [${t.status}]` : '';
      const parentTag = t.parent_thread_id ? ` (parent: \`${t.parent_thread_id}\`)` : '';
      lines.push(`- **${num}${t.title}${stage}**${statusTag}  \`${t.thread_id}\`${parentTag}`);
      const cps = t.checkpoints || [];
      const latest = cps.at(-1);
      if (latest?.summary) lines.push(`  - ${latest.summary}`);
    }
    lines.push('', '## Decisions and checkpoints', '');
    for (const t of threads) {
      for (const cp of t.checkpoints || []) {
        lines.push(`### ${String(t.sequence || '').padStart(2, '0')} ${t.title} — ${cp.created_at}`);
        if (cp.summary) lines.push('', cp.summary);
        if (cp.decisions?.length) lines.push('', '**Decisions**', ...cp.decisions.map(x => `- ${x}`));
        if (cp.open_questions?.length) lines.push('', '**Open questions**', ...cp.open_questions.map(x => `- ${x}`));
        if (cp.next_steps?.length) lines.push('', '**Next steps**', ...cp.next_steps.map(x => `- ${x}`));
        lines.push('');
      }
    }
    fs.writeFileSync(path.join(this.wikiDir, `${safeName(projectId)}.md`), lines.join('\n'));
  }

  recordAction(catalog, action) {
    catalog.actions ||= [];
    catalog.actions.push({ action_id: crypto.randomUUID(), at: new Date().toISOString(), ...action });
    if (catalog.actions.length > 1000) catalog.actions = catalog.actions.slice(-1000);
  }
}
