#!/usr/bin/env node
// Renders the archived+organized ChatGPT catalog as a MediaWiki wikitext
// bundle: one page per project, one page per thread, plus a top-level index.
// Same bundle format as project-meta's render_project_wiki_mediawiki.py
// (manifest.json = [{title, filename}], each filename holds raw wikitext) so
// it can be imported with the same local-preview harness:
//
//   node scripts/render-mediawiki-bundle.js
//   python3 ~/code/project-meta/wiki/local_mediawiki/import_wiki_bundle.py \
//     data/wiki_mediawiki_bundle
//
// This only writes local files — it does not talk to any MediaWiki instance
// itself, and does not stand up any new persistent service.

import fs from 'node:fs';
import path from 'node:path';

const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.resolve('data');
const OUT_DIR = process.env.WIKI_BUNDLE_DIR || path.join(ARCHIVE_DIR, 'wiki_mediawiki_bundle');
const NAMESPACE = 'ChatGPT';

function pageSafeTitle(value) {
  // MediaWiki titles can't contain [ ] { } | # < >; keep everything else,
  // including the project/thread's own punctuation, for readability.
  return String(value || 'Untitled')
    .replace(/[[\]{}|#<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || 'Untitled';
}

// Neutralize the handful of characters that have special meaning in
// wikitext ([[ ]] {{ }} '' ----) so conversation text renders as plain text
// instead of accidentally being interpreted as markup.
function escapeWikitext(text) {
  return String(text ?? '')
    .replace(/\[\[/g, '&#91;&#91;')
    .replace(/\]\]/g, '&#93;&#93;')
    .replace(/\{\{/g, '&#123;&#123;')
    .replace(/\}\}/g, '&#125;&#125;');
}

function threadMarkdownToWikitext(mdContent) {
  // Strip the YAML frontmatter block and the leading `# Title` line — the
  // wiki page title already carries that; keep just the conversation body.
  const withoutFrontmatter = mdContent.replace(/^---\n[\s\S]*?\n---\n/, '');
  const lines = withoutFrontmatter.split('\n');
  const out = [];
  for (const line of lines) {
    const roleHeading = line.match(/^## (\w+)/);
    if (roleHeading) {
      out.push(`\n=== ${roleHeading[1]} ===\n`);
      continue;
    }
    if (line.startsWith('# ')) continue; // the top-level title line
    if (line.startsWith('<!-- message_id:')) continue;
    out.push(escapeWikitext(line));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function main() {
  const catalog = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, 'metadata', 'catalog.json'), 'utf8'));
  const threads = Object.values(catalog.threads).filter((t) => t.project_name);
  const byProject = new Map();
  for (const t of threads) {
    if (!byProject.has(t.project_name)) byProject.set(t.project_name, []);
    byProject.get(t.project_name).push(t);
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const manifest = [];
  let fileCounter = 0;
  function addPage(title, wikitext) {
    fileCounter += 1;
    const filename = `page-${fileCounter}.wikitext`;
    fs.writeFileSync(path.join(OUT_DIR, filename), wikitext, 'utf8');
    manifest.push({ title, filename });
  }

  const projectNames = [...byProject.keys()].sort((a, b) => a.localeCompare(b));

  const indexLines = [
    `= ${NAMESPACE} =`,
    '',
    `Organized ChatGPT conversations, generated from the archive catalog. ${threads.length} threads across ${projectNames.length} projects.`,
    '',
  ];
  for (const projectName of projectNames) {
    const projectTitle = `${NAMESPACE}/${pageSafeTitle(projectName)}`;
    indexLines.push(`* [[${projectTitle}|${projectName}]] (${byProject.get(projectName).length} threads)`);
  }
  addPage(NAMESPACE, indexLines.join('\n'));

  for (const projectName of projectNames) {
    const projectTitle = `${NAMESPACE}/${pageSafeTitle(projectName)}`;
    const projectThreads = byProject.get(projectName).sort((a, b) => (a.sequence || 0) - (b.sequence || 0) || a.title.localeCompare(b.title));
    const lines = [`= ${projectName} =`, '', `[[${NAMESPACE}|← ${NAMESPACE} index]]`, ''];
    let missingContent = 0;
    for (const t of projectThreads) {
      const threadTitle = `${projectTitle}/${pageSafeTitle(t.title)}`;
      lines.push(`* [[${threadTitle}|${t.title}]] — [${t.url} open in ChatGPT]`);

      const mdPath = path.join(ARCHIVE_DIR, 'raw', 'chats', `${t.thread_id}.md`);
      let body = '(not yet archived locally)';
      if (fs.existsSync(mdPath)) {
        const raw = fs.readFileSync(mdPath, 'utf8');
        body = threadMarkdownToWikitext(raw) || '(no message content captured)';
        if (!(t.message_count > 0)) missingContent += 1;
      }
      addPage(
        threadTitle,
        [`= ${t.title} =`, '', `[[${projectTitle}|← ${projectName}]]  |  [${t.url} open in ChatGPT]`, '', body].join('\n')
      );
    }
    if (missingContent) lines.push('', `''${missingContent} thread(s) above have no locally archived message content yet — open in ChatGPT to view, or re-run capture.''`);
    addPage(projectTitle, lines.join('\n'));
  }

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${manifest.length} pages to ${OUT_DIR}`);
  console.log(`Import with: python3 ~/code/project-meta/wiki/local_mediawiki/import_wiki_bundle.py ${OUT_DIR}`);
}

main();
