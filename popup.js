const PORTAL_HOST = "app.bristol.ac.uk";
const PORTAL_URL = "https://app.bristol.ac.uk/campusm/home#calendars";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function setStatus(text, kind = "", details = []) {
  statusEl.className = kind;
  statusEl.textContent = text;
  if (details.length) {
    const ul = document.createElement("ul");
    for (const d of details) {
      const li = document.createElement("li");
      li.textContent = d;
      ul.appendChild(li);
    }
    statusEl.appendChild(ul);
  }
}

const monthStr = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");

// Default: the current academic year, August to July.
function defaultRange() {
  const now = new Date();
  const startYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return { from: startYear + "-08", to: startYear + 1 + "-07" };
}

const MIN_MONTHS = 1;
const MAX_MONTHS = 24;

function addMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  return monthStr(new Date(y, m - 1 + n, 1));
}

function monthsBetween(fromYm, toYm) {
  const [fy, fm] = fromYm.split("-").map(Number);
  const [ty, tm] = toYm.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

const clampCount = (n) => Math.min(MAX_MONTHS, Math.max(MIN_MONTHS, Math.round(n) || MIN_MONTHS));

function getCount() {
  return clampCount(parseInt($("count").value, 10));
}

function setCount(n) {
  $("count").value = clampCount(n);
  updateRange();
}

function prettyMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

// Keep the buttons, presets and summary line in step with the inputs.
function updateRange() {
  const n = getCount();
  $("dec").disabled = n <= MIN_MONTHS;
  $("inc").disabled = n >= MAX_MONTHS;
  for (const b of document.querySelectorAll(".presets button")) {
    b.setAttribute("aria-pressed", String(+b.dataset.months === n));
  }
  const from = $("from").value;
  if (!from) {
    $("rangeSummary").textContent = "Choose a start month.";
    return;
  }
  const to = addMonths(from, n - 1);
  $("rangeSummary").textContent =
    n === 1
      ? "Exports " + prettyMonth(from) + " only."
      : "Exports " + prettyMonth(from) + " to " + prettyMonth(to) + " (" + n + " months).";
}

const calendarBoxes = () => [...document.querySelectorAll("#calendars input[type=checkbox]")];

const LABELS = {
  "Student Timetable": "Timetable",
  "Key Dates": "Key dates",
  "Event Timetable": "Event timetable",
  CAMPUSM_REGISTERED_EVENTS: "Registered events",
  CAMPUSM_TASKBOARD: "Taskboard",
};

async function loadPrefs() {
  const def = defaultRange();
  let saved = {};
  try {
    saved = (await browser.storage.local.get("prefs")).prefs || {};
  } catch (_) { /* storage unavailable: use defaults */ }

  // Only reuse a saved range if it still ends in the future.
  const useSaved = saved.from && saved.to && saved.to >= monthStr(new Date());
  $("from").value = useSaved ? saved.from : def.from;
  $("count").value = clampCount(useSaved ? saved.count || monthsBetween(saved.from, saved.to) : 12);
  updateRange();

  if (Array.isArray(saved.calendars)) {
    for (const box of calendarBoxes()) box.checked = saved.calendars.includes(box.value);
  }
  for (const k of ["typeInTitle", "separateFiles", "saveAs"]) {
    if (typeof saved[k] === "boolean") $(k).checked = saved[k];
  }
}

function readForm() {
  const from = $("from").value;
  const count = getCount();
  return {
    from,
    to: from ? addMonths(from, count - 1) : "",
    count,
    calendars: calendarBoxes().filter((b) => b.checked).map((b) => b.value),
    typeInTitle: $("typeInTitle").checked,
    separateFiles: $("separateFiles").checked,
    saveAs: $("saveAs").checked,
  };
}

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function doExport() {
  const opts = readForm();
  if (!opts.from) return setStatus("Choose a start month.", "error");
  if (!opts.calendars.length) return setStatus("Tick at least one calendar to include.", "error");

  browser.storage.local.set({ prefs: opts }).catch(() => {});

  const btn = $("export");
  btn.disabled = true;
  setStatus("Fetching events…");

  try {
    const tab = await activeTab();
    const [injection] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: runExport,
      args: [opts],
    });
    const result = injection && injection.result;
    if (!result) throw new Error("No response from the page. Reload the portal tab and try again.");
    if (!result.ok) throw new Error(result.error);

    const breakdown = opts.calendars.map((c) => (LABELS[c] || c) + ": " + result.perCalendar[c]);
    if (!result.total) {
      setStatus("No events found in that date range.", "error", breakdown);
      return;
    }

    const dl = await browser.runtime.sendMessage({
      type: "download-ics",
      files: result.files,
      saveAs: opts.saveAs,
    });
    if (dl && dl.ok === false) throw new Error("Download failed: " + dl.error);

    const n = result.files.length;
    setStatus(
      "Exported " + result.total + " events" + (n > 1 ? " into " + n + " files." : "."),
      "ok",
      breakdown
    );
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/Missing host permission|cannot access|Invalid tab/i.test(msg)) {
      document.body.classList.add("not-portal");
    } else {
      setStatus(msg, "error");
    }
  } finally {
    btn.disabled = false;
  }
}

async function init() {
  $("openPortal").addEventListener("click", async () => {
    const tab = await activeTab();
    if (tab && /^about:(newtab|home|blank)$/.test(tab.url || "")) {
      await browser.tabs.update(tab.id, { url: PORTAL_URL });
    } else {
      await browser.tabs.create({ url: PORTAL_URL });
    }
    window.close();
  });
  $("export").addEventListener("click", doExport);
  $("dec").addEventListener("click", () => setCount(getCount() - 1));
  $("inc").addEventListener("click", () => setCount(getCount() + 1));
  $("count").addEventListener("input", updateRange);
  $("count").addEventListener("change", () => setCount(parseInt($("count").value, 10)));
  $("from").addEventListener("input", updateRange);
  for (const b of document.querySelectorAll(".presets button")) {
    b.addEventListener("click", () => setCount(+b.dataset.months));
  }

  const tab = await activeTab();
  let host = "";
  try { host = new URL(tab.url || "").hostname; } catch (_) {}
  if (tab.url && host !== PORTAL_HOST) {
    document.body.classList.add("not-portal");
    return;
  }
  await loadPrefs();
}

init();
