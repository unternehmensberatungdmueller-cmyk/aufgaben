// Versteht einen deutschen Satz wie
// "Morgen um 10 Uhr Herrn Becker wegen Vertrag anrufen, Priorität 1"
// und zerlegt ihn in Aufgabe, Kunde, Priorität, Datum und Uhrzeit.
(function (root) {
  const L = "[A-Za-zÄÖÜäöüß0-9]";
  const B = `(?<!${L})`;          // Wortanfang (auch mit Umlauten)
  const E = `(?!${L})`;           // Wortende
  const NUM = { ein: 1, eins: 1, eine: 1, einen: 1, einer: 1, einem: 1, zwei: 2, drei: 3, vier: 4, fünf: 5,
    sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12, dreizehn: 13, vierzehn: 14,
    fünfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19, zwanzig: 20 };
  const NUMW = Object.keys(NUM).sort((a, b) => b.length - a.length).join("|");
  const N = `(\\d{1,2}|${NUMW})`;
  const num = (s) => (/^\d+$/.test(s) ? +s : NUM[s.toLowerCase()]);
  const DAYS = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"];
  const MONTHS = ["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"];
  const PRE = `(?:(?:bis|am|zum|ab|für|spätestens)\\s+)*`;

  function parse(text, opts = {}) {
    const now = opts.now ? new Date(opts.now) : new Date();
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    let t = " " + text + " ";
    const res = {};
    const take = (re, fn) => {
      const m = t.match(re);
      if (!m) return false;
      if (fn(m) === false) return false;
      t = t.slice(0, m.index) + " " + t.slice(m.index + m[0].length);
      return true;
    };
    const rx = (s) => new RegExp(s, "i");

    // ---- Priorität ----
    const PMAP = { 1: 1, eins: 1, hoch: 1, hohe: 1, 2: 2, zwei: 2, mittel: 2, mittlere: 2, 3: 3, drei: 3, niedrig: 3, niedrige: 3 };
    take(rx(`${B}(?:mit\\s+)?(?:priorität|prio)\\s*(1|2|3|eins|zwei|drei|hoch|mittel|niedrig)${E}`), (m) => { res.prio = PMAP[m[1].toLowerCase()]; })
      || take(rx(`${B}(?:mit\\s+)?(hohe|mittlere|niedrige)[rn]?\\s+(?:priorität|prio)${E}`), (m) => { res.prio = PMAP[m[1].toLowerCase()]; })
      || take(rx(`${B}(?:nicht\\s+(?:so\\s+)?(?:dringend|wichtig|eilig)|unwichtig|hat\\s+zeit)${E}`), () => { res.prio = 3; })
      || take(rx(`${B}(?:sehr\\s+)?(?:dringend|wichtig|eilig|sofort)${E}`), () => { res.prio = 1; });

    // ---- Uhrzeit ----
    const hhmm = (h, m) => { h = num(h); m = m ? +m : 0; return h >= 0 && h <= 24 && m < 60 ? [h % 24, m] : null; };
    take(rx(`${B}(?:von\\s+)?${N}(?:[:.](\\d{2}))?\\s*(?:uhr\\s*)?(?:bis|-|–)\\s*${N}(?:[:.](\\d{2}))?\\s*uhr${E}`), (m) => {
      const a = hhmm(m[1], m[2]), b = hhmm(m[3], m[4]);
      if (!a || !b) return false;
      res.time = a; res.endTime = b;
    }) || take(rx(`${B}(?:um|gegen|ab|bis|spätestens)?\\s*${N}(?:[:.](\\d{2}))?\\s*uhr${E}(?:\\s+(morgens|früh|vormittags|mittags|nachmittags|abends))?`), (m) => {
      const a = hhmm(m[1], m[2]);
      if (!a) return false;
      if (m[3] && /nachmittags|abends/i.test(m[3]) && a[0] < 12) a[0] += 12;
      res.time = a;
    }) || take(rx(`${B}(?:um|gegen|ab)\\s+(\\d{1,2})[:.](\\d{2})${E}`), (m) => {
      const a = hhmm(m[1], m[2]);
      if (!a) return false;
      res.time = a;
    });

    // ---- Datum ----
    const setDate = (d) => { res.date = new Date(d); };
    const plus = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
    const didDate =
      take(rx(`${B}${PRE}übermorgen${E}`), () => setDate(plus(2)))
      || take(rx(`${B}${PRE}morgen${E}(?:\\s+(?:früh|vormittag|nachmittag|abend))?`), (m) => {
        setDate(plus(1));
        if (!res.time && /früh|vormittag/i.test(m[0])) res.time = [9, 0];
        if (!res.time && /nachmittag/i.test(m[0])) res.time = [15, 0];
        if (!res.time && /abend/i.test(m[0])) res.time = [19, 0];
      })
      || take(rx(`${B}${PRE}heute(?:\\s+(?:noch|abend|nachmittag|vormittag))?${E}`), () => setDate(today))
      || take(rx(`${B}${PRE}(\\d{1,2})\\.\\s*(\\d{1,2})\\.(\\d{2,4})?`), (m) => {
        let y = m[3] ? +m[3] : today.getFullYear(); if (y < 100) y += 2000;
        const d = new Date(y, +m[2] - 1, +m[1]);
        if (d.getMonth() !== +m[2] - 1) return false;
        if (!m[3] && d < today) d.setFullYear(y + 1);
        setDate(d);
      })
      || take(rx(`${B}${PRE}(\\d{1,2})\\.?\\s+(${MONTHS.join("|")})(?:\\s+(\\d{4}))?${E}`), (m) => {
        const mo = MONTHS.indexOf(m[2].toLowerCase());
        let y = m[3] ? +m[3] : today.getFullYear();
        const d = new Date(y, mo, +m[1]);
        if (!m[3] && d < today) d.setFullYear(y + 1);
        setDate(d);
      })
      || take(rx(`${B}${PRE}in\\s+${N}\\s+(tag|tagen|woche|wochen|monat|monaten)${E}`), (m) => {
        const n = num(m[1]); const u = m[2].toLowerCase();
        if (u.startsWith("tag")) setDate(plus(n));
        else if (u.startsWith("woche")) setDate(plus(7 * n));
        else { const d = new Date(today); d.setMonth(d.getMonth() + n); setDate(d); }
      })
      || take(rx(`${B}${PRE}(?:(nächste[nrs]?|kommende[nrs]?|diese[nrs]?)\\s+)?(${DAYS.join("|")})${E}`), (m) => {
        const wd = DAYS.indexOf(m[2].toLowerCase());
        let diff = (wd - today.getDay() + 7) % 7;
        if (m[1] && /nächst|kommend/i.test(m[1]) && diff === 0) diff = 7;
        setDate(plus(diff));
      })
      || take(rx(`${B}${PRE}(?:ende\\s+(?:der|dieser)\\s+woche|diese\\s+woche)${E}`), () => {
        setDate(plus(Math.max(0, (5 - today.getDay() + 7) % 7)));
      })
      || take(rx(`${B}${PRE}(?:nächste|kommende)\\s+woche${E}`), () => {
        setDate(plus(((1 - today.getDay() + 7) % 7) || 7));
      })
      || take(rx(`${B}${PRE}ende\\s+(?:des\\s+)?monats${E}`), () => {
        setDate(new Date(today.getFullYear(), today.getMonth() + 1, 0));
      });
    // Nur Uhrzeit genannt: heute, oder morgen falls schon vorbei
    if (!didDate && res.time) {
      const d = new Date(today); d.setHours(res.time[0], res.time[1]);
      setDate(d < now ? plus(1) : today);
    }

    // ---- Kunde / Ansprechpartner ----
    const names = (opts.names || []).filter(Boolean);
    const low = t.toLowerCase();
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const n of [...names].sort((a, b) => b.length - a.length)) {
      if (n.length < 3) continue;
      if (new RegExp(`${B}${esc(n.toLowerCase())}${E}`).test(low)) { res.who = n; break; }
    }
    if (!res.who) {
      const m = t.match(new RegExp(`${B}([Hh]errn?|HERRN?|[Ff]rau|FRAU|[Ff]irma|FIRMA|[Ff]a\\.)\\s+([A-ZÄÖÜ][\\wäöüß-]+(?:\\s+(?!Bis|Am|Um|Und|Wegen|Für|Mit)[A-ZÄÖÜ][\\wäöüß-]+)?)`));
      if (m) {
        const last = m[2].split(/\s+/)[0];
        const hit = names.find((n) => n.toLowerCase().split(/\s+/).includes(last.toLowerCase()));
        const title = { herr: "Herr", herrn: "Herr", frau: "Frau", firma: "Firma", "fa.": "Firma" }[m[1].toLowerCase()];
        res.who = hit || (title === "Firma" ? "Firma " + m[2] : title + " " + last);
      }
    }

    // ---- Rest = Aufgabe ----
    let title = t.replace(/\s+/g, " ")
      .replace(/\s+([,.;!?])/g, "$1")
      .replace(new RegExp(`(?:^|\\s)(?:bis|am|um|zum|und|mit|für|,)(?=\\s*$)`, "i"), "")
      .replace(/^[\s,.;:–-]+|[\s,;:–-]+$/g, "")
      .replace(/^(?:(?:bitte|ich\s+muss|ich\s+soll|erinnere\s+mich(?:\s+daran)?|nicht\s+vergessen)[:,]?\s+)+/i, "")
      .replace(/\s*,\s*,/g, ",")
      .replace(/,$/, "")
      .trim();
    // mehrfach, weil nach dem Entfernen neue Füllwörter am Ende stehen können
    for (let k = 0; k < 3; k++) title = title.replace(/(?:\s+|^)(?:bis|am|um|zum|und|mit|für)$/i, "").replace(/[\s,;:–-]+$/, "").trim();
    if (title) title = title[0].toUpperCase() + title.slice(1);
    res.text = title;
    return res;
  }

  root.parseEingabe = parse;
  if (typeof module !== "undefined") module.exports = parse;
})(typeof window !== "undefined" ? window : globalThis);
