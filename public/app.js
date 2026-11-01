"use strict";

/*
  How this page works:
  1. The visitor picks a PDF. We send it to /api/upload and get back a job id.
  2. The job id goes in the address bar (#job=...) so a refresh does not lose it.
  3. Every few seconds we ask /api/status for that job. The notes appear first,
     then the real-world context, as n8n saves each one.

  Everything the AI wrote is untrusted text. We only ever put it on the page with
  textContent (through el() below), never innerHTML, and links must be http(s).
*/

const POLL_MS = 4000;
const GIVE_UP_MS = 20 * 60 * 1000;
const MAX_BYTES = 4 * 1024 * 1024;

const $ = (id) => document.getElementById(id);
const intro = $("intro");
const form = $("upload-form");
const fileInput = $("file");
const drop = $("drop");
const dropText = $("drop-text");
const formError = $("form-error");
const submitBtn = $("submit");
const jobSection = $("job");
const jobFile = $("job-file");
const trace = $("trace");
const statusText = $("status-text");
const notesOut = $("notes-out");
const contextOut = $("context-out");
const restartBtn = $("restart");

let activeJob = null; // { id, timer, notesShown, contextShown }

/* ---------- small helpers ---------- */

/** Build an element. String children become text nodes, so they can never turn into markup. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child != null && child !== "") node.append(child);
  return node;
}

/** Models sometimes add markdown even when told not to. Remove the common marks. */
const clean = (value) =>
  String(value ?? "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`/g, "")
    .replace(/^[\s\-*•]+/, "")
    .trim();

/** Shorten long text for a one-line label. */
const short = (value, max = 90) => {
  const text = clean(value);
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

/** Search results give dates like "Tue, 19 May 2026 00:00:00 GMT". Show "May 19, 2026". Unknown text is left alone. */
function niceDate(value) {
  const text = clean(value);
  if (!text || text === "unknown") return "";
  const date = new Date(text);
  return Number.isNaN(date.getTime())
    ? text
    : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

const toArray = (value) => (Array.isArray(value) ? value : value == null || value === "" ? [] : [value]);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Only http(s) links are allowed. A "javascript:" link from a model would otherwise run code. */
function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function showFormError(message) {
  formError.textContent = message;
  formError.hidden = !message;
}

/* ---------- upload ---------- */

function updateDrop() {
  const file = fileInput.files[0];
  if (file) {
    dropText.textContent = `${file.name} (${(file.size / 1048576).toFixed(1)} MB)`;
    drop.setAttribute("data-has-file", "");
  } else {
    dropText.textContent = "Choose a PDF or drop it here";
    drop.removeAttribute("data-has-file");
  }
  showFormError("");
}

fileInput.addEventListener("change", updateDrop);

drop.addEventListener("dragover", (event) => {
  event.preventDefault();
  drop.setAttribute("data-over", "");
});
drop.addEventListener("dragleave", () => drop.removeAttribute("data-over"));
drop.addEventListener("drop", (event) => {
  event.preventDefault();
  drop.removeAttribute("data-over");
  if (event.dataTransfer.files.length) {
    fileInput.files = event.dataTransfer.files;
    updateDrop();
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showFormError("");

  const file = fileInput.files[0];
  if (!file) return showFormError("Choose a PDF first.");
  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    return showFormError("That file is not a PDF. Export your slides as a PDF and try again.");
  }
  if (file.size > MAX_BYTES) {
    return showFormError("That PDF is over 4 MB. Export fewer slides or a smaller file.");
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Uploading";
  try {
    const body = new FormData();
    body.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body });
    if (res.status === 429) throw new Error("Too many uploads. Wait a minute and try again.");
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.jobId) throw new Error(data.error || "The upload failed. Try again.");

    history.replaceState(null, "", `#job=${data.jobId}`);
    startJob(data.jobId, file.name);
  } catch (err) {
    showFormError(
      err instanceof TypeError
        ? "Can't reach the server. Check your connection and try again."
        : err.message,
    );
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Make notes";
  }
});

/* ---------- job + polling ---------- */

function setTrace(received, notes, context) {
  const states = { received, notes, context };
  for (const li of trace.children) li.setAttribute("data-state", states[li.dataset.step]);
}

function startJob(id, fileName) {
  stopPolling();
  activeJob = { id, timer: null, notesShown: false, contextShown: false };

  intro.hidden = true;
  jobSection.hidden = false;
  restartBtn.hidden = true;
  jobFile.textContent = fileName || "";
  notesOut.replaceChildren();
  contextOut.replaceChildren();
  setTrace("done", "active", "todo");
  statusText.textContent = "Reading your slides and writing notes. This can take a few minutes.";
  $("job-title").focus(); // moves screen-reader focus to the new section

  poll(id, Date.now());
}

function stopPolling() {
  if (activeJob?.timer) clearTimeout(activeJob.timer);
  activeJob = null;
}

function leaveJob(message) {
  stopPolling();
  history.replaceState(null, "", location.pathname);
  jobSection.hidden = true;
  intro.hidden = false;
  fileInput.value = "";
  updateDrop();
  showFormError(message || "");
}

async function poll(id, startedAt) {
  if (activeJob?.id !== id) return; // the visitor moved on to another job
  let finished = false;

  try {
    const res = await fetch(`/api/status?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (res.status === 404 || res.status === 410) {
      return leaveJob("That job is gone. Notes are deleted after 24 hours. Upload the slides again.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "status check failed");
    if (activeJob?.id !== id) return;
    finished = render(data);
  } catch {
    if (activeJob?.id === id) statusText.textContent = "Lost the connection. Trying again.";
  }

  if (finished || activeJob?.id !== id) return;

  if (Date.now() - startedAt > GIVE_UP_MS) {
    statusText.textContent =
      "This is taking longer than expected. Keep this page's address and come back; your notes are kept for 24 hours.";
    return;
  }
  activeJob.timer = setTimeout(() => poll(id, startedAt), POLL_MS);
}

/** Update the page from one status response. Returns true when no more polling is needed. */
function render(data) {
  const job = activeJob;
  if (data.fileName) jobFile.textContent = data.fileName;

  if (data.notes && !job.notesShown) {
    notesOut.replaceChildren(renderNotes(data.notes));
    job.notesShown = true;
  }
  if (data.context && !job.contextShown) {
    contextOut.replaceChildren(renderContext(data.context));
    job.contextShown = true;
  }

  switch (data.status) {
    case "notes_ready":
      setTrace("done", "done", "active");
      statusText.textContent = "Notes are ready. Finding real-world examples.";
      return false;
    case "complete":
      setTrace("done", "done", "done");
      statusText.textContent = "Notes and examples are ready.";
      restartBtn.hidden = false;
      return true;
    case "error": {
      const message = data.error || "Something went wrong.";
      setTrace("done", job.notesShown ? "done" : "failed", job.notesShown ? "failed" : "todo");
      statusText.textContent = job.notesShown
        ? `The notes are ready, but the examples could not be added. ${message}`
        : `The notes could not be made. ${message}`;
      restartBtn.hidden = false;
      return true;
    }
    default:
      setTrace("done", "active", "todo");
      statusText.textContent = "Reading your slides and writing notes. This can take a few minutes.";
      return false;
  }
}

restartBtn.addEventListener("click", () => leaveJob(""));

/* ---------- rendering notes ---------- */

function unexpected(data) {
  if (typeof data === "string") {
    return el("div", { class: "topic" }, ...data.split(/\n{2,}/).map((p) => el("p", {}, clean(p))));
  }
  return el("pre", { class: "raw" }, JSON.stringify(data, null, 2));
}

function renderNotes(data) {
  const wrap = el("section", { class: "notes", "aria-labelledby": "notes-h" });
  wrap.append(el("h2", { id: "notes-h" }, "Notes"));

  const topics = Array.isArray(data) ? data : Array.isArray(data?.topics) ? data.topics : null;
  if (!topics) {
    wrap.append(unexpected(data));
    return wrap;
  }

  for (const topic of topics) {
    if (!isObject(topic)) continue;
    const bullets = toArray(topic.bullets).map(clean).filter(Boolean);
    const article = el("article", { class: "topic" }, el("h3", {}, clean(topic.title) || "Topic"));
    if (bullets.length) article.append(el("ul", {}, bullets.map((b) => el("li", {}, b))));
    if (topic.analogy) {
      article.append(el("p", { class: "analogy" }, el("strong", {}, "Analogy: "), clean(topic.analogy)));
    }
    wrap.append(article);
  }
  return wrap;
}

/* ---------- rendering context ---------- */

function linkTitle(title, urlValue) {
  const url = safeUrl(urlValue);
  const text = clean(title) || (url ? url.hostname : "Untitled");
  return el("p", { class: "item__title" }, url ? el("a", { href: url.href, target: "_blank", rel: "noopener noreferrer" }, text) : text);
}

function meta(...parts) {
  const text = parts.map(clean).filter(Boolean).join(", ");
  return text ? el("p", { class: "item__meta" }, text) : null;
}

function unverifiedFlag(item) {
  return item.verified === false ? el("p", { class: "item__body item__flag" }, "Could not be verified. Check it yourself.") : null;
}

function renderArticles(list) {
  const items = toArray(list).filter(isObject);
  if (!items.length) return null;
  return [
    el("h3", {}, "In the news"),
    el(
      "ul",
      { class: "items" },
      items.map((a) => {
        const url = safeUrl(a.url);
        return el(
          "li",
          {},
          linkTitle(a.title, a.url),
          meta(url ? url.hostname.replace(/^www\./, "") : "", niceDate(a.published), a.topic ? `Topic: ${short(a.topic)}` : ""),
          a.why_it_fits ? el("p", { class: "item__body" }, clean(a.why_it_fits)) : null,
          unverifiedFlag(a),
        );
      }),
    ),
  ];
}

/** Built here, not by the AI, so the link can never be made up. Only plain indicator codes are accepted. */
function worldBankUrl(code) {
  return /^[A-Z0-9.]{3,40}$/.test(String(code ?? "")) ? `https://data.worldbank.org/indicator/${code}?locations=US-IN` : null;
}

/** The two countries often report different years, so every value carries its own. */
function withYear(value, year) {
  const v = clean(value);
  const y = clean(year);
  return v ? (y ? `${v} (${y})` : v) : "No data";
}

function renderComparison(list) {
  const rows = toArray(list).filter(isObject);
  if (!rows.length) return null;
  const body = el("tbody");
  for (const r of rows) {
    const href = worldBankUrl(r.code);
    const label = clean(r.indicator) || clean(r.code) || "Measure";
    body.append(
      el(
        "tr",
        {},
        el(
          "th",
          { scope: "row" },
          href ? el("a", { href, target: "_blank", rel: "noopener noreferrer" }, label) : label,
          r.topic ? el("span", { class: "cell__sub" }, `Topic: ${short(r.topic)}`) : null,
        ),
        el("td", {}, withYear(r.us, r.us_year ?? r.year)),
        el("td", {}, withYear(r.india, r.india_year ?? r.year)),
      ),
    );
    if (r.takeaway || r.verified === false) {
      body.append(
        el("tr", { class: "takeaway" }, el("td", { colspan: "3" }, clean(r.takeaway), r.verified === false ? " Could not be verified." : "")),
      );
    }
  }
  const table = el(
    "table",
    {},
    el("caption", { class: "item__meta" }, "Figures are from the World Bank. Each value shows its own year. Open a measure to see the source."),
    el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Measure"), el("th", { scope: "col" }, "United States"), el("th", { scope: "col" }, "India"))),
    body,
  );
  return [el("h3", {}, "United States and India"), el("div", { class: "table-wrap" }, table)];
}

function renderHistory(list) {
  const items = toArray(list).filter(isObject);
  if (!items.length) return null;
  return [
    el("h3", {}, "A similar moment in modern history"),
    el(
      "ul",
      { class: "items" },
      items.map((h) =>
        el(
          "li",
          {},
          linkTitle(h.episode || h.title, h.url || h.source_url),
          meta(h.years, h.topic ? `Topic: ${short(h.topic)}` : ""),
          h.similarity ? el("p", { class: "item__body" }, el("strong", {}, "Alike: "), clean(h.similarity)) : null,
          h.difference ? el("p", { class: "item__body" }, el("strong", {}, "Different: "), clean(h.difference)) : null,
          unverifiedFlag(h),
        ),
      ),
    ),
  ];
}

function renderContext(data) {
  const wrap = el("section", { class: "context", "aria-labelledby": "context-h" });
  wrap.append(el("h2", { id: "context-h" }, "Real-world context"));
  wrap.append(el("p", { class: "context__note" }, "These come from outside your slides. Open each link and check it before you cite it."));

  if (!isObject(data)) {
    wrap.append(unexpected(data));
    return wrap;
  }

  const sections = [renderArticles(data.articles ?? data.news), renderComparison(data.comparison), renderHistory(data.history)];
  let shown = 0;
  for (const section of sections) {
    if (!section) continue;
    wrap.append(...section);
    shown += 1;
  }
  if (data.note) wrap.append(el("p", { class: "context__note" }, clean(data.note)));
  if (!shown && !data.note) wrap.append(el("p", { class: "context__note" }, "No outside examples were found for these topics."));
  return wrap;
}

/* ---------- start-up ---------- */

/** Open the job named in the address bar, if there is one. */
function resumeFromAddress() {
  const match = /^#job=([0-9a-f-]{36})$/.exec(location.hash);
  if (match && match[1] !== activeJob?.id) startJob(match[1], "");
}

resumeFromAddress();
// Pasting a job link into a tab that is already open changes only the part after #, which does not reload the page.
window.addEventListener("hashchange", resumeFromAddress);
