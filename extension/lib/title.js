// Pure title-selection logic. No DOM/chrome globals so this is unit-testable with node:test.

const DENYLIST = [
  /^skip to content$/i,
  /^skip to main content$/i,
  /^chatgpt$/i,
  /^new chat$/i,
  /^chat history$/i,
  /^sidebar$/i,
  /^main menu$/i,
  /^untitled$/i,
];

export function isValidTitle(value) {
  const t = String(value ?? "").trim();
  if (!t) return false;
  if (t.length > 300) return false;
  return !DENYLIST.some((re) => re.test(t));
}

export function cleanTitle(value) {
  const t = String(value ?? "").trim();
  return isValidTitle(t) ? t : null;
}

// Chrome tab titles are usually "<conversation title> - ChatGPT" or "ChatGPT - <title>".
export function cleanDocumentTitle(rawDocumentTitle) {
  const stripped = String(rawDocumentTitle || "")
    .replace(/\s*[-–—]\s*ChatGPT.*$/i, "")
    .replace(/^ChatGPT\s*[-–—]\s*/i, "");
  return cleanTitle(stripped);
}

// An accessibility "Skip to content" link commonly has href="#main" (or similar).
// Resolved against the current page, its pathname equals the current pathname even
// though it is not a conversation link at all. Reject any href that is a bare
// same-page anchor before it ever gets compared to the current path.
export function isSameOriginPageAnchor(hrefAttr) {
  return typeof hrefAttr === "string" && hrefAttr.trim().startsWith("#");
}

// candidates: ordered array of { source: string, value: string|null|undefined }
// Returns the first candidate that survives isValidTitle, tagged with its source
// so callers can log/report which signal actually produced the title.
export function selectTitle(candidates) {
  for (const c of candidates || []) {
    const t = cleanTitle(c?.value);
    if (t) return { title: t, source: c.source || null };
  }
  return { title: null, source: null };
}
