const DEFAULTS = { brokerUrl: "ws://localhost:8787/extension", token: "change-me", autoArchive: true, autoArchiveDelayMs: 3000, debug: false };

function deriveApiBase(brokerUrl) {
  const u = new URL(brokerUrl || DEFAULTS.brokerUrl);
  const httpProtocol = u.protocol === "wss:" ? "https:" : "http:";
  return `${httpProtocol}//${u.host}`;
}

let cfg;
let apiBase;

async function api(path, options = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

function setMsg(text, kind) {
  const el = document.getElementById("msg");
  el.textContent = text || "";
  el.className = kind || "";
}

function setBroker(ok, count) {
  const el = document.getElementById("broker");
  const dotClass = ok ? "ok" : "bad";
  el.innerHTML = `<span class="dot ${dotClass}"></span>${ok ? `connected (${count} extension tab${count === 1 ? "" : "s"})` : "unreachable"}`;
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

let currentThreadId = null;

async function refresh() {
  try {
    const health = await api("/health");
    setBroker(true, health.extension_connections);
  } catch (err) {
    setBroker(false, 0);
    document.getElementById("detected").textContent = "broker unreachable";
    document.getElementById("threadId").textContent = "—";
    document.getElementById("title").textContent = "—";
    return;
  }

  let current;
  try {
    current = await api("/api/current");
  } catch (err) {
    document.getElementById("detected").textContent = "not detected";
    document.getElementById("threadId").textContent = "—";
    document.getElementById("title").textContent = "—";
    document.getElementById("lastArchive").textContent = "—";
    document.getElementById("project").textContent = "—";
    document.getElementById("sequence").textContent = "—";
    return;
  }

  currentThreadId = current.thread_id || null;
  document.getElementById("detected").textContent = currentThreadId ? "detected" : "not detected";
  document.getElementById("threadId").textContent = currentThreadId || "—";
  document.getElementById("title").textContent = current.title || "—";

  const warnEl = document.getElementById("completenessWarning");
  if (current.completeness_warning) {
    warnEl.style.display = "block";
    warnEl.textContent = `⚠ ${current.completeness_warning}`;
  } else {
    warnEl.style.display = "none";
  }

  if (!currentThreadId) return;
  try {
    const thread = await api(`/api/thread/${encodeURIComponent(currentThreadId)}`);
    document.getElementById("lastArchive").textContent = `${fmtTime(thread.last_captured_at)}${thread.content_hash ? "" : ""}`;
    document.getElementById("project").textContent = thread.project_name || "—";
    document.getElementById("sequence").textContent = thread.sequence ? `${String(thread.sequence).padStart(2, "0")}${thread.stage ? ` — ${thread.stage}` : ""}` : "—";
  } catch {
    document.getElementById("lastArchive").textContent = "not archived yet";
    document.getElementById("project").textContent = "—";
    document.getElementById("sequence").textContent = "—";
  }
}

function wireButton(id, handler) {
  document.getElementById(id).addEventListener("click", async () => {
    setMsg("Working…");
    try {
      const result = await handler();
      setMsg(result || "Done.", "ok");
      await refresh();
    } catch (err) {
      setMsg(`Failed: ${err.message}`, "error");
    }
  });
}

async function init() {
  cfg = await chrome.storage.sync.get(DEFAULTS);
  apiBase = deriveApiBase(cfg.brokerUrl);
  await refresh();

  wireButton("captureBtn", async () => {
    const r = await api("/api/capture", { method: "POST" });
    return `Captured ${r.thread_id} (${r.message_count} messages, source: ${r.capture_source || "unknown"}).`;
  });

  wireButton("renameBtn", async () => {
    const title = document.getElementById("renameTitle").value.trim();
    if (!title) throw new Error("Enter a title first.");
    const r = await api("/api/rename", { method: "POST", body: JSON.stringify({ title }) });
    return `Renamed to "${r.title}".`;
  });

  wireButton("assignBtn", async () => {
    const project = document.getElementById("assignProject").value.trim();
    if (!project) throw new Error("Enter a project name first.");
    const r = await api("/api/project", { method: "POST", body: JSON.stringify({ project }) });
    return `Assigned to project "${r.project_name}".`;
  });

  wireButton("numberBtn", async () => {
    const project = document.getElementById("numberProject").value.trim();
    const series = document.getElementById("numberSeries").value.trim() || "default";
    const stage = document.getElementById("numberStage").value.trim();
    const sequenceRaw = document.getElementById("numberSequence").value;
    const renameVisible = document.getElementById("numberRenameVisible").checked;
    const body = { series, rename_visible_chat: renameVisible };
    if (project) body.project = project;
    if (stage) body.stage = stage;
    if (sequenceRaw) body.sequence = Number(sequenceRaw);
    const r = await api("/api/number", { method: "POST", body: JSON.stringify(body) });
    return `Numbered ${String(r.sequence).padStart(2, "0")} in "${r.project_name}"${renameVisible ? " and renamed the visible chat." : "."}`;
  });
}

init().catch((err) => setMsg(`Failed to load: ${err.message}`, "error"));
