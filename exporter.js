/*
 * runExport is injected into the app.bristol.ac.uk tab with
 * browser.scripting.executeScript, so it must be fully self-contained:
 * every helper lives inside it.
 *
 * opts = {
 *   from: "2026-08",            // first month (inclusive), local time
 *   to:   "2027-07",            // last month (inclusive), local time
 *   calendars: ["Student Timetable", ...],
 *   separateFiles: false,
 *   typeInTitle: true           // "Jurisprudence (Lecture)"
 * }
 *
 * Returns { ok: true, files: [{ name, text, count }], total }
 *      or { ok: false, error }
 */
async function runExport(opts) {
  const ORIGIN = "https://app.bristol.ac.uk";
  const CHUNK_MONTHS = 3;

  // Firefox content scripts: content.fetch makes the request as the page
  // itself, so the portal's session cookies are sent exactly as normal.
  const doFetch =
    typeof content !== "undefined" && content && typeof content.fetch === "function"
      ? content.fetch.bind(content)
      : fetch.bind(globalThis);

  if (typeof location !== "undefined" && location.hostname !== "app.bristol.ac.uk") {
    return { ok: false, error: "Open app.bristol.ac.uk/campusm and log in, then try again." };
  }

  // ---------- date range ----------
  function parseMonth(s) {
    const m = /^(\d{4})-(\d{2})$/.exec(s || "");
    if (!m) throw new Error("Invalid month: " + s);
    return { y: +m[1], m: +m[2] - 1 };
  }
  const f = parseMonth(opts.from);
  const t = parseMonth(opts.to);
  const rangeStart = new Date(f.y, f.m, 1, 0, 0, 0, 0);
  const rangeEnd = new Date(t.y, t.m + 1, 1, 0, 0, 0, 0); // exclusive
  if (rangeEnd <= rangeStart) {
    return { ok: false, error: "The end month must be the same as or after the start month." };
  }

  const windows = [];
  for (let d = new Date(rangeStart); d < rangeEnd; ) {
    const next = new Date(d.getFullYear(), d.getMonth() + CHUNK_MONTHS, 1);
    const end = next < rangeEnd ? next : rangeEnd;
    windows.push([d, new Date(end.getTime() - 1000)]); // mirror the site's 23:59:59
    d = next;
  }

  // ---------- fetching ----------
  async function fetchWindow(cal, start, end) {
    const url =
      ORIGIN + "/campusm/sso/cal2/" + encodeURIComponent(cal) +
      "?start=" + encodeURIComponent(start.toISOString()) +
      "&end=" + encodeURIComponent(end.toISOString());
    const res = await doFetch(url, {
      method: "GET",
      credentials: "same-origin",
      headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" },
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("The portal says you're not logged in. Log in again, then retry.");
    }
    if (!res.ok) throw new Error(cal + ": the portal returned HTTP " + res.status + ".");
    const type = res.headers.get("content-type") || "";
    if (!type.includes("json")) {
      throw new Error("The portal didn't return calendar data. Your session has probably expired, so reload the page and log in.");
    }
    const data = await res.json();
    return Array.isArray(data && data.events) ? data.events : [];
  }

  const byCal = {};
  try {
    for (const cal of opts.calendars) {
      const seen = new Map();
      for (const [s, e] of windows) {
        for (const ev of await fetchWindow(cal, s, e)) {
          const key = (ev.eventRef || "") + "|" + (ev.start || "");
          if (!seen.has(key)) seen.set(key, ev);
        }
      }
      // Keep only events that overlap the requested range.
      byCal[cal] = [...seen.values()]
        .filter((ev) => {
          const st = new Date(ev.start), en = new Date(ev.end || ev.start);
          return !isNaN(st) && en >= rangeStart && st < rangeEnd;
        })
        .sort((a, b) => new Date(a.start) - new Date(b.start));
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }

  // ---------- ICS helpers ----------
  const clean = (v) => (v == null ? "" : String(v).trim());

  function esc(s) {
    return clean(s)
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r\n|\r|\n/g, "\\n");
  }

  // Fold at 75 octets without splitting UTF-8 characters.
  function fold(line) {
    const enc = new TextEncoder();
    if (enc.encode(line).length <= 75) return line;
    const out = [];
    let cur = "", curLen = 0, limit = 75;
    for (const ch of line) {
      const n = enc.encode(ch).length;
      if (curLen + n > limit) {
        out.push(cur);
        cur = "";
        curLen = 0;
        limit = 74; // continuation lines start with a space
      }
      cur += ch;
      curLen += n;
    }
    out.push(cur);
    return out.join("\r\n ");
  }

  const pad = (n) => String(n).padStart(2, "0");
  function utc(d) {
    return (
      d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" +
      pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z"
    );
  }

  // All-day dates are taken literally from the string ("2026-09-01T00:..."),
  // never shifted through a timezone.
  function datePart(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/.exec(s || "");
    if (!m) return null;
    return { y: +m[1], mo: +m[2], d: +m[3], midnight: !m[4] || (m[4] === "00" && m[5] === "00" && m[6] === "00") };
  }
  function ymd(y, mo, d) {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() + pad(dt.getUTCMonth() + 1) + pad(dt.getUTCDate());
  }

  function firstHttpUrl(s) {
    const m = /https?:\/\/[^\s"'<>]+/.exec(clean(s));
    return m ? m[0] : "";
  }

  function uidFor(cal, ev) {
    const raw = cal + "|" + clean(ev.eventRef) + "|" + clean(ev.start);
    // Simple stable hash (FNV-1a, two passes) keeps UIDs short and safe.
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
    }
    return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0") + "@uob-calendar-export";
  }

  const stamp = utc(new Date());

  function vevent(cal, ev) {
    const L = [];
    const title = clean(ev.desc1) || "(untitled)";
    const type = clean(ev.desc2);
    const summary = opts.typeInTitle && type && !title.toLowerCase().includes(type.toLowerCase())
      ? title + " (" + type + ")"
      : title;

    L.push("BEGIN:VEVENT");
    L.push("UID:" + uidFor(cal, ev));
    L.push("DTSTAMP:" + stamp);

    if (clean(ev.isAllDay) === "true") {
      const s = datePart(ev.start);
      const e = datePart(ev.end) || s;
      L.push("DTSTART;VALUE=DATE:" + ymd(s.y, s.mo, s.d));
      // DTEND is exclusive: "…T23:59:59" on the 31st ends on the 1st.
      const endDay = e.midnight && (e.y !== s.y || e.mo !== s.mo || e.d !== s.d) ? e.d : e.d + 1;
      L.push("DTEND;VALUE=DATE:" + ymd(e.y, e.mo, endDay));
      L.push("TRANSP:TRANSPARENT");
    } else {
      const s = new Date(ev.start);
      let e = new Date(ev.end);
      if (isNaN(e) || e <= s) e = new Date(s.getTime() + 60 * 60 * 1000);
      L.push("DTSTART:" + utc(s));
      L.push("DTEND:" + utc(e));
    }

    L.push("SUMMARY:" + esc(summary));

    const loc = [ev.locAdd1, ev.locAdd2, ev.locAdd3, ev.locAdd4, ev.locAddPostCode]
      .map(clean).filter(Boolean).join(", ");
    if (loc) L.push("LOCATION:" + esc(loc));

    const mapUrl = firstHttpUrl(ev.locUrl);
    const meetUrl = firstHttpUrl(ev.meetingURL);

    const desc = [];
    if (type) desc.push("Type: " + type);
    if (clean(ev.teacherName)) desc.push("Staff: " + clean(ev.teacherName));
    const course = [clean(ev.courseCode), clean(ev.courseName)].filter(Boolean).join(" ");
    if (course) desc.push("Course: " + course);
    if (clean(ev.desc3)) desc.push(clean(ev.desc3));
    if (clean(ev.locCom)) desc.push("Location note: " + clean(ev.locCom));
    if (clean(ev.alertCom)) desc.push("Note: " + clean(ev.alertCom));
    if (meetUrl) desc.push((clean(ev.meetingURLDesc) || "Online meeting") + ": " + meetUrl);
    if (mapUrl) desc.push("Map: " + mapUrl);
    desc.push("Calendar: " + cal);
    L.push("DESCRIPTION:" + esc(desc.join("\n")));

    if (meetUrl || mapUrl) L.push("URL:" + (meetUrl || mapUrl));
    L.push("CATEGORIES:" + esc(cal));
    L.push("END:VEVENT");
    return L;
  }

  function buildIcs(name, entries) {
    const L = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//UoB Calendar Export//Firefox Extension//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:" + esc(name),
      "X-WR-TIMEZONE:Europe/London",
    ];
    for (const [cal, ev] of entries) L.push(...vevent(cal, ev));
    L.push("END:VCALENDAR");
    return L.map(fold).join("\r\n") + "\r\n";
  }

  const safe = (s) => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const span = opts.from === opts.to ? opts.from : opts.from + "_to_" + opts.to;

  const files = [];
  if (opts.separateFiles) {
    for (const cal of opts.calendars) {
      const entries = byCal[cal].map((ev) => [cal, ev]);
      if (!entries.length) continue;
      files.push({
        name: "UoB-" + safe(cal) + "_" + span + ".ics",
        text: buildIcs("UoB " + cal, entries),
        count: entries.length,
      });
    }
  } else {
    const entries = [];
    for (const cal of opts.calendars) for (const ev of byCal[cal]) entries.push([cal, ev]);
    entries.sort((a, b) => new Date(a[1].start) - new Date(b[1].start));
    if (entries.length) {
      files.push({
        name: "UoB-calendar_" + span + ".ics",
        text: buildIcs("University of Bristol", entries),
        count: entries.length,
      });
    }
  }

  const perCalendar = {};
  for (const cal of opts.calendars) perCalendar[cal] = byCal[cal].length;
  const total = Object.values(perCalendar).reduce((a, b) => a + b, 0);
  return { ok: true, files, total, perCalendar };
}
