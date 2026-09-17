// Downloads run here rather than in the popup, because the popup closes
// (and its blob URLs die) as soon as a "Save as" dialog takes focus.

const pending = new Map(); // downloadId -> blob URL

browser.runtime.onMessage.addListener(async (msg) => {
  if (!msg || msg.type !== "download-ics") return;
  const ids = [];
  for (const file of msg.files) {
    const blob = new Blob([file.text], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const id = await browser.downloads.download({
        url,
        filename: file.name,
        saveAs: !!msg.saveAs,
        conflictAction: "uniquify",
      });
      pending.set(id, url);
      ids.push(id);
    } catch (err) {
      URL.revokeObjectURL(url);
      // The user cancelling the Save dialog is not an error worth reporting.
      if (!/cancel/i.test(String(err && err.message))) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
      }
    }
  }
  return { ok: true, ids };
});

browser.downloads.onChanged.addListener((delta) => {
  const url = pending.get(delta.id);
  if (!url || !delta.state) return;
  if (delta.state.current === "complete" || delta.state.current === "interrupted") {
    URL.revokeObjectURL(url);
    pending.delete(delta.id);
  }
});
