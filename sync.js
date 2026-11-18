// Abgleich zwischen Geräten über Supabase.
// Prinzip: Jede Aufgabe, jeder Termin und jeder Kunde ist eine Zeile in "eintraege".
// Lokale Änderungen werden erkannt, indem der aktuelle Stand mit dem zuletzt
// abgeglichenen Stand ("snap") verglichen wird. Danach werden neuere Einträge
// vom Server geholt. Gelöschtes wird als "deleted" markiert.
(function () {
  const cfg = window.APP_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseKey && window.supabase);
  const SNAP = "sync-snap-v1", LAST = "sync-last-v1", UP = "sync-fotos-v1";
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const sb = enabled ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "aufgaben-anmeldung" },
  }) : null;

  let user = null, busy = false, again = false, timer = null, lastOk = null, lastError = null;
  const listeners = [];
  const notify = () => listeners.forEach((f) => { try { f(); } catch {} });

  function localEntries() {
    const out = {};
    for (const i of items) out[i.id] = { kind: i.type || "task", data: i };
    for (const c of contacts) out[c.id] = { kind: "contact", data: c };
    return out;
  }

  async function syncNow() {
    if (!sb || !user) return;
    if (busy) { again = true; return; }
    busy = true; notify();
    try {
      const snap = ls.get(SNAP, {});
      const local = localEntries();
      const rows = [];
      for (const [id, e] of Object.entries(local)) {
        const json = JSON.stringify(e.data);
        if (snap[id] !== json) rows.push({ id, kind: e.kind, data: e.data, deleted: false });
      }
      for (const id of Object.keys(snap)) if (!local[id]) rows.push({ id, kind: "geloescht", data: {}, deleted: true });
      for (let k = 0; k < rows.length; k += 200) {
        const { error } = await sb.from("eintraege").upsert(rows.slice(k, k + 200));
        if (error) throw error;
      }
      for (const r of rows) { if (r.deleted) delete snap[r.id]; else snap[r.id] = JSON.stringify(r.data); }

      // Neueres vom Server holen (mit 5 Minuten Puffer gegen Überschneidungen)
      const last = ls.get(LAST, null);
      let q = sb.from("eintraege").select("id,kind,data,deleted,updated_at").order("updated_at", { ascending: true }).limit(5000);
      if (last) q = q.gt("updated_at", new Date(new Date(last).getTime() - 5 * 60e3).toISOString());
      const { data, error } = await q;
      if (error) throw error;
      let changed = false, maxTs = last;
      const now = localEntries();
      for (const r of data || []) {
        if (!maxTs || r.updated_at > maxTs) maxTs = r.updated_at;
        const cur = now[r.id];
        const curJson = cur ? JSON.stringify(cur.data) : null;
        // Lokale, noch nicht abgeglichene Änderungen haben Vorrang
        if (cur && snap[r.id] !== undefined && curJson !== snap[r.id]) continue;
        if (r.deleted) {
          if (cur) {
            if (cur.kind === "contact") contacts = contacts.filter((c) => c.id !== r.id);
            else items = items.filter((i) => i.id !== r.id);
            changed = true;
          }
          delete snap[r.id];
          continue;
        }
        const json = JSON.stringify(r.data);
        if (json !== curJson) {
          if (r.kind === "contact") {
            const idx = contacts.findIndex((c) => c.id === r.id);
            if (idx >= 0) contacts[idx] = r.data; else contacts.push(r.data);
          } else {
            const idx = items.findIndex((i) => i.id === r.id);
            if (idx >= 0) items[idx] = r.data; else items.push(r.data);
          }
          changed = true;
        }
        snap[r.id] = json;
      }
      ls.set(SNAP, snap);
      if (maxTs) ls.set(LAST, maxTs);
      if (changed) { window.__syncApplying = true; save(); window.__syncApplying = false; refreshUI(); }
      await uploadPhotos();
      lastOk = new Date(); lastError = null;
    } catch (e) {
      lastError = (e && e.message) || String(e);
      console.warn("Abgleich fehlgeschlagen", e);
    } finally {
      busy = false; notify();
      if (again) { again = false; setTimeout(syncNow, 300); }
    }
  }

  function refreshUI() {
    // Formulare nicht unter den Fingern verändern
    if (typeof current !== "undefined" && ["task", "event", "contact"].includes(current)) return;
    if (typeof render === "function") render();
  }

  // ---- Fotos ----
  const photoPath = (id) => `${user.id}/${id}.jpg`;
  async function uploadPhotos() {
    const done = new Set(ls.get(UP, []));
    const ids = items.filter((i) => i.photos && i.photos.length).flatMap((i) => i.photos).filter((id) => !done.has(id));
    for (const id of ids) {
      const blob = await localPhoto(id);
      if (!blob) continue;
      const { error } = await sb.storage.from("fotos").upload(photoPath(id), blob, { upsert: true, contentType: "image/jpeg" });
      if (!error) { done.add(id); ls.set(UP, [...done]); }
    }
  }
  let localPhoto = async () => null, storePhoto = async () => {};
  async function fetchPhoto(id) {
    if (!sb || !user) return null;
    const { data, error } = await sb.storage.from("fotos").download(photoPath(id));
    if (error || !data) return null;
    await storePhoto(id, data);
    const done = new Set(ls.get(UP, [])); done.add(id); ls.set(UP, [...done]);
    return data;
  }
  async function removePhoto(id) {
    if (!sb || !user) return;
    await sb.storage.from("fotos").remove([photoPath(id)]);
  }

  // ---- Spracherkennung (Edge Function "transkribieren") ----
  async function transcribe(blob, hint) {
    if (!sb || !user) throw new Error("Bitte zuerst anmelden");
    const ext = /mp4|m4a|aac/.test(blob.type) ? "m4a" : /webm/.test(blob.type) ? "webm" : /ogg/.test(blob.type) ? "ogg" : "m4a";
    const fd = new FormData();
    fd.append("audio", new File([blob], "aufnahme." + ext, { type: blob.type || "audio/mp4" }));
    if (hint) fd.append("hint", hint);
    const { data, error } = await sb.functions.invoke("transkribieren", { body: fd });
    if (error) {
      let msg = error.message || String(error);
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch {}
      if (/not found|404|Requested function/i.test(msg)) msg = "Die Spracherkennung ist noch nicht eingerichtet.";
      throw new Error(msg);
    }
    return (data && data.text) || "";
  }

  // ---- Google Kalender / Kontakte (Edge Function "google") ----
  async function google(action, body = {}) {
    if (!sb || !user) throw new Error("Bitte zuerst anmelden");
    const { data, error } = await sb.functions.invoke("google", { body: { action, ...body } });
    if (!error) return data || {};
    let msg = error.message || String(error), notConnected = false;
    try { const j = await error.context.json(); if (j && j.error) msg = j.error; notConnected = !!(j && j.notConnected); } catch {}
    if (/not found|404|Requested function/i.test(msg)) msg = "Die Google-Verbindung ist in Supabase noch nicht eingerichtet.";
    if (/abgelaufen/i.test(msg)) notConnected = true;
    const err = new Error(msg); err.notConnected = notConnected;
    throw err;
  }

  // ---- Anmeldung ----
  async function signIn(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    user = data.user; notify(); await syncNow();
  }
  async function signUp(email, password) {
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) throw error;
    if (data.session) { user = data.user; notify(); await syncNow(); return "ok"; }
    return "bestaetigen";
  }
  async function signOut() {
    await sb.auth.signOut();
    user = null; ls.set(SNAP, {}); ls.set(LAST, null); ls.set(UP, []); notify();
  }

  function changed() {
    if (window.__syncApplying || !user) return;
    clearTimeout(timer); timer = setTimeout(syncNow, 1200);
  }

  async function init() {
    if (!sb) return;
    const { data } = await sb.auth.getSession();
    user = data.session ? data.session.user : null;
    sb.auth.onAuthStateChange((_e, session) => { user = session ? session.user : null; notify(); });
    notify();
    if (user) syncNow();
    setInterval(() => { if (user && !document.hidden) syncNow(); }, 60e3);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && user) syncNow(); });
    window.addEventListener("online", () => user && syncNow());
  }

  window.Sync = {
    enabled, init, syncNow, changed, transcribe, google, signIn, signUp, signOut, fetchPhoto, removePhoto,
    onChange: (f) => listeners.push(f),
    setPhotoStore: (get, put) => { localPhoto = get; storePhoto = put; },
    get user() { return user; }, get busy() { return busy; }, get lastOk() { return lastOk; }, get lastError() { return lastError; },
  };
})();
