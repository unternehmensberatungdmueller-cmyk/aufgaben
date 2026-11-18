// Supabase Edge Function "google"
// Verbindet die Aufgaben-App mit Google Kalender und Google Kontakten.
//   POST (mit Anmeldung der App)  { action: "begin" | "status" | "events" | "upsert" | "delete" | "contacts" | "disconnect", ... }
//   GET  .../google/callback      Rücksprung von Google nach der Freigabe
// Benötigte Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
// Der Google-Zugang (refresh token) liegt nur auf dem Server in der Tabelle google_konto.
// Wichtig: In den Einstellungen dieser Function "Verify JWT" AUSSCHALTEN (die Function prüft selbst).

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
const REDIRECT = `${SUPABASE_URL}/functions/v1/google/callback`;
const SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
].join(" ");

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const page = (title: string, text: string, ok = true) => new Response(
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title><style>body{font:18px -apple-system,system-ui,sans-serif;background:#f5f5f7;color:#1d1d1f;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}
  .c{background:#fff;border-radius:20px;padding:32px 24px;max-width:420px;box-shadow:0 4px 20px rgba(0,0,0,.06)}h1{font-size:24px;margin:12px 0}.i{font-size:48px}</style></head>
  <body><div class="c"><div class="i">${ok ? "✅" : "⚠️"}</div><h1>${title}</h1><p>${text}</p></div></body></html>`,
  { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } });

// --- signierter "state", damit der Rücksprung dem richtigen Nutzer zugeordnet wird
const enc = new TextEncoder();
async function hmac(data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(CLIENT_SECRET + SERVICE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]!));
}
async function makeState(uid: string) { const p = `${uid}.${Date.now() + 15 * 60e3}`; return `${p}.${await hmac(p)}`; }
async function readState(s: string) {
  const [uid, exp, sig] = s.split(".");
  if (!uid || !exp || !sig || Date.now() > +exp) return null;
  return (await hmac(`${uid}.${exp}`)) === sig ? uid : null;
}

// --- Google-Zugriff
async function accessToken(uid: string) {
  const { data } = await db.from("google_konto").select("refresh_token").eq("user_id", uid).maybeSingle();
  if (!data) return null;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: data.refresh_token, grant_type: "refresh_token" }),
  });
  const d = await r.json();
  if (!r.ok) {
    if (d.error === "invalid_grant") await db.from("google_konto").delete().eq("user_id", uid); // Zugriff wurde entzogen
    throw new Error("Google-Verbindung abgelaufen. Bitte neu verbinden.");
  }
  return d.access_token as string;
}
async function g(token: string, url: string, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  if (r.status === 204 || r.status === 410) return {};
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Google-Fehler ${r.status}`);
  return d;
}
const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

function toAppEvent(e: any) {
  const allDay = !!e.start?.date;
  return {
    googleId: e.id, text: e.summary || "(ohne Titel)", allDay,
    start: allDay ? e.start.date : e.start?.dateTime, end: allDay ? e.end?.date : e.end?.dateTime,
    location: e.location || "", description: e.description || "", link: e.htmlLink || "",
    fromApp: e.extendedProperties?.private?.aufgabenApp || "",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);

  // ---------- Rücksprung von Google ----------
  if (url.pathname.endsWith("/callback")) {
    const code = url.searchParams.get("code"), state = url.searchParams.get("state") || "";
    if (url.searchParams.get("error")) return page("Nicht verbunden", "Die Freigabe wurde abgebrochen. Du kannst dieses Fenster schließen.", false);
    const uid = await readState(state);
    if (!code || !uid) return page("Link abgelaufen", "Bitte in der App nochmal auf „Mit Google verbinden“ tippen.", false);
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: "authorization_code" }),
    });
    const t = await r.json();
    if (!r.ok || !t.refresh_token) return page("Das hat nicht geklappt", t.error_description || "Google hat keinen dauerhaften Zugang erteilt. Bitte nochmal versuchen.", false);
    let email = "";
    try { email = (await g(t.access_token, "https://openidconnect.googleapis.com/v1/userinfo")).email || ""; } catch { /* egal */ }
    const { error } = await db.from("google_konto").upsert({ user_id: uid, refresh_token: t.refresh_token, email, updated_at: new Date().toISOString() });
    if (error) return page("Speichern fehlgeschlagen", error.message, false);
    return page("Google ist verbunden", `${email ? email + " ist" : "Dein Konto ist"} jetzt mit der Aufgaben-App verbunden.<br><br>Du kannst dieses Fenster schließen und zur App zurückkehren.`);
  }

  if (req.method !== "POST") return json({ error: "Nur POST" }, 405);
  if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: "Google ist in Supabase noch nicht eingerichtet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET fehlen)." }, 500);

  // ---------- Anmeldung der App prüfen ----------
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u, error: ue } = await db.auth.getUser(jwt);
  if (ue || !u?.user) return json({ error: "Bitte in der App anmelden." }, 401);
  const uid = u.user.id;
  const body = await req.json().catch(() => ({}));

  try {
    switch (body.action) {
      case "begin": {
        const p = new URLSearchParams({
          client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", scope: SCOPES,
          access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: await makeState(uid),
        });
        return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${p}` });
      }
      case "status": {
        const { data } = await db.from("google_konto").select("email").eq("user_id", uid).maybeSingle();
        return json({ connected: !!data, email: data?.email || "" });
      }
      case "disconnect": {
        const { data } = await db.from("google_konto").select("refresh_token").eq("user_id", uid).maybeSingle();
        if (data) await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(data.refresh_token), { method: "POST" }).catch(() => {});
        await db.from("google_konto").delete().eq("user_id", uid);
        return json({ ok: true });
      }
    }
    const token = await accessToken(uid);
    if (!token) return json({ error: "Google ist nicht verbunden.", notConnected: true }, 400);

    switch (body.action) {
      case "events": {
        const out: any[] = []; let pageToken = "";
        do {
          const p = new URLSearchParams({ timeMin: body.from, timeMax: body.to, singleEvents: "true", orderBy: "startTime", maxResults: "250" });
          if (pageToken) p.set("pageToken", pageToken);
          const d = await g(token, `${CAL}?${p}`);
          for (const e of d.items || []) if (e.status !== "cancelled") out.push(toAppEvent(e));
          pageToken = d.nextPageToken || "";
        } while (pageToken && out.length < 2000);
        return json({ events: out });
      }
      case "upsert": {
        // body: { googleId?, appId, text, allDay, start, end, description, timeZone }
        const tz = body.timeZone || "Europe/Berlin";
        const ev: any = {
          summary: body.text, status: "confirmed",
          start: body.allDay ? { date: body.start } : { dateTime: body.start, timeZone: tz },
          end: body.allDay ? { date: body.end } : { dateTime: body.end, timeZone: tz },
          extendedProperties: { private: { aufgabenApp: body.appId || "" } },
        };
        if (body.description != null) ev.description = body.description;
        if (body.reminderMinutes != null) ev.reminders = { useDefault: false, overrides: [{ method: "popup", minutes: body.reminderMinutes }] };
        let d;
        if (!body.googleId && body.appId) {
          // Schon einmal eingetragen (z. B. vom anderen Gerät)? Dann dieses ändern statt doppelt anlegen.
          const q = new URLSearchParams({ privateExtendedProperty: `aufgabenApp=${body.appId}`, maxResults: "1" });
          const f = await g(token, `${CAL}?${q}`).catch(() => ({}));
          if (f.items?.[0]?.id) body.googleId = f.items[0].id;
        }
        if (body.googleId) {
          try { d = await g(token, `${CAL}/${encodeURIComponent(body.googleId)}`, { method: "PATCH", body: JSON.stringify(ev) }); }
          catch { d = await g(token, CAL, { method: "POST", body: JSON.stringify(ev) }); }
        } else d = await g(token, CAL, { method: "POST", body: JSON.stringify(ev) });
        return json({ googleId: d.id });
      }
      case "delete": {
        if (body.googleId) await g(token, `${CAL}/${encodeURIComponent(body.googleId)}`, { method: "DELETE" }).catch(() => {});
        return json({ ok: true });
      }
      case "contacts": {
        const out: any[] = []; let pageToken = "";
        do {
          const p = new URLSearchParams({ personFields: "names,organizations,phoneNumbers,emailAddresses", pageSize: "1000", sortOrder: "LAST_NAME_ASCENDING" });
          if (pageToken) p.set("pageToken", pageToken);
          const d = await g(token, `https://people.googleapis.com/v1/people/me/connections?${p}`);
          for (const c of d.connections || []) {
            const name = c.names?.[0]?.displayName || "";
            const org = c.organizations?.[0]?.name || "";
            if (!name && !org) continue;
            const phone = (c.phoneNumbers || []).find((x: any) => x.type === "mobile")?.value || c.phoneNumbers?.[0]?.value || "";
            out.push({ googleId: c.resourceName, name, org, phone, email: c.emailAddresses?.[0]?.value || "" });
          }
          pageToken = d.nextPageToken || "";
        } while (pageToken && out.length < 5000);
        return json({ contacts: out });
      }
      default:
        return json({ error: "Unbekannte Aktion" }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 502);
  }
});
