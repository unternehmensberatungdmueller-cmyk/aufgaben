// Supabase Edge Function "transkribieren"
// Nimmt eine Sprachaufnahme aus der App entgegen und gibt den erkannten Text zurück.
// Nutzt OpenAI (Secret OPENAI_API_KEY) oder Deepgram (Secret DEEPGRAM_API_KEY).
// Nur angemeldete Nutzer der App dürfen sie aufrufen (prüft die Function selbst, "Verify JWT" kann aus sein).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST" }, 405);
  // Anmeldung der App prüfen
  const auth = req.headers.get("Authorization") || "";
  const who = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: Deno.env.get("SUPABASE_ANON_KEY") || "" },
  }).catch(() => null);
  if (!who || !who.ok) return json({ error: "Bitte in der App anmelden." }, 401);
  try {
    const form = await req.formData();
    const audio = form.get("audio");
    const hint = String(form.get("hint") || "").slice(0, 800);
    if (!(audio instanceof File) || audio.size === 0) return json({ error: "Keine Aufnahme erhalten" }, 400);
    if (audio.size > 20 * 1024 * 1024) return json({ error: "Aufnahme zu lang" }, 413);

    const openai = Deno.env.get("OPENAI_API_KEY");
    const deepgram = Deno.env.get("DEEPGRAM_API_KEY");

    if (openai) {
      const fd = new FormData();
      fd.append("file", audio, audio.name || "aufnahme.m4a");
      fd.append("model", "whisper-1");
      fd.append("language", "de");
      fd.append("response_format", "json");
      if (hint) fd.append("prompt", hint);
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST", headers: { Authorization: `Bearer ${openai}` }, body: fd,
      });
      const d = await r.json();
      if (!r.ok) return json({ error: d?.error?.message || "Fehler bei OpenAI" }, 502);
      return json({ text: (d.text || "").trim() });
    }

    if (deepgram) {
      const params = new URLSearchParams({ model: "nova-2", language: "de", smart_format: "true", punctuate: "true" });
      for (const w of hint.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50)) params.append("keywords", w);
      const r = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
        method: "POST",
        headers: { Authorization: `Token ${deepgram}`, "Content-Type": audio.type || "audio/mp4" },
        body: await audio.arrayBuffer(),
      });
      const d = await r.json();
      if (!r.ok) return json({ error: d?.err_msg || "Fehler bei Deepgram" }, 502);
      return json({ text: (d?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "").trim() });
    }

    return json({ error: "Kein Schlüssel für die Spracherkennung hinterlegt" }, 500);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
