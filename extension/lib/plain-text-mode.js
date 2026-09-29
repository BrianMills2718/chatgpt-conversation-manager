// Loaded into the background worker with importScripts (a classic script, so
// no `export`), and run in the PAGE's main world through
// chrome.scripting.executeScript world:"MAIN", so the function must be
// self-contained: no imports, no closure variables.
//
// Why (2026-09-29): ChatGPT's composer sends `getText()`. When its
// `hasMarkdownFormatting()` finds a link or other formatting in the draft --
// a bare URL in the prompt is enough -- getText() serializes the draft as
// Markdown. That serializer escapes every literal Markdown character (`\#`,
// `` \` ``, `\_`), writes leading spaces as `&#x20;` and bare URLs as
// `[url](url)`. So about 40% of audit prompts reached the model mangled.
// hasMarkdownFormatting() returns false when the composer controller is in
// `plainTextMode` (ChatGPT's own "keeps code, Markdown, and links as literal
// text" setting, `composerPlainTextMode`, default off), and getText() then
// returns the draft's text verbatim. This finds the agent tab's composer
// controller through React's fiber tree and switches that one controller to
// plain-text mode. It does not change the account setting, so the user's own
// tabs keep their normal composer.
function setComposerPlainTextMode(on) {
  const editor = document.querySelector('div.ProseMirror[contenteditable="true"]');
  if (!editor) return { ok: false, reason: "no composer editor on the page" };
  const isController = (v) => v && typeof v === "object" && typeof v.setPlainTextMode === "function" && typeof v.getText === "function";
  const candidates = (v) => {
    if (!v || typeof v !== "object") return [];
    const out = [v];
    if (v.current && typeof v.current === "object") out.push(v.current);
    for (const k of Object.keys(v).slice(0, 60)) { const x = v[k]; if (x && typeof x === "object") out.push(x, x.current); }
    return out;
  };
  let node = editor;
  let fiber = null;
  for (let i = 0; node && i < 30 && !fiber; i++, node = node.parentElement) {
    const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$"));
    if (key) fiber = node[key];
  }
  if (!fiber) return { ok: false, reason: "no React fiber above the composer" };
  for (let depth = 0; fiber && depth < 200; depth++, fiber = fiber.return) {
    const bags = [fiber.memoizedProps, fiber.stateNode];
    for (let h = fiber.memoizedState, i = 0; h && i < 80; i++, h = h.next) bags.push(h.memoizedState);
    for (const bag of bags) {
      for (const c of candidates(bag)) {
        if (isController(c)) {
          c.setPlainTextMode(Boolean(on));
          return { ok: true, plain_text_mode: c.plainTextMode === Boolean(on), depth };
        }
      }
    }
  }
  return { ok: false, reason: "composer controller not found in the React tree" };
}

if (typeof self !== "undefined") self.setComposerPlainTextMode = setComposerPlainTextMode;
if (typeof module !== "undefined") module.exports = { setComposerPlainTextMode };
