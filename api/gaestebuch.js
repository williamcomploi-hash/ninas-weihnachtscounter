/* Das Gästebuch.
 *
 *   GET    /api/gaestebuch                    → { eintraege: [...] }
 *   POST   /api/gaestebuch {name, text}       → { eintrag }
 *   DELETE /api/gaestebuch {id, passwort}     → { weg: true }
 *
 * DAS PASSWORT STEHT NICHT IN DER SEITE. Es liegt als Umgebungsvariable
 * ADMIN_PASSWORT bei Vercel und wird nur hier geprüft. Stünde es im Quelltext,
 * wäre das Löschen nicht bloß erratbar, sondern für jeden Besucher offen —
 * dann hätte jemand in fünf Minuten alles geleert.
 *
 * Was gespeichert wird: ein selbstgewählter Name (darf ein Fantasiename sein),
 * ein kurzer Text und der Zeitpunkt. Keine Adresse, kein Gerät, keine Kennung.
 * Die Bremse arbeitet mit einem Fingerabdruck, der von selbst verfällt.
 */

import { sql, lagerDa, vorbereiten, bremse, herkunft, kurz, antworte } from "./_lager.js";

const HOECHSTENS = 200;    /* so viele werden angezeigt */
const NAME_MAX   = 24;
const TEXT_MAX   = 300;
const PAUSE_SEK  = 120;    /* ein Eintrag alle zwei Minuten je Adresse */

/** Nimmt der Zeichenkette alles, was Ärger macht.
 *  Exportiert, weil api/wunsch.js dieselbe Säuberung braucht — eine Fassung
 *  für beide, damit eine Verschärfung hier nicht dort vergessen wird. */
export function saeubern(roh, hoechstens) {
  return String(roh ?? "")
    .normalize("NFKC")                 /* Vollbreite, Ligaturen usw. auf die Grundform */
    .replace(/\p{Cf}/gu, "")           /* unsichtbare Formatzeichen (Zero-Width, Richtungsmarken) */
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")   /* Steuerzeichen raus */
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, hoechstens);
}

/** Vergleichsform eines Namens: NFKC, ohne Formatzeichen und Leerraum, Kleinschreibung.
 *  Damit „a d m i n", „ａｄｍｉｎ" oder „ad​min" denselben Schlüssel ergeben wie „admin".
 *  Was hier bewusst NICHT passiert: Homoglyphen anderer Schriften (kyrillisches „а") werden
 *  nicht auf lateinisch abgebildet — die fängt die Schriftprüfung unten ab. */
function vergleichsname(name) {
  return String(name ?? "")
    .normalize("NFKC")
    .replace(/[\p{Cf}\s]/gu, "")
    .toLowerCase();
}

/** Sieht der Name aus wie „admin", ist es aber nicht? Ein „admin" mit einem einzigen
 *  fremden Buchstaben (kyrillisches а, griechisches ο …) ist auf dem Bildschirm nicht
 *  vom echten zu unterscheiden. Darum: 5 Zeichen, mindestens eines nicht-lateinisch,
 *  und die lateinischen davon passen an ihrer Stelle zu „admin" → gesperrt. */
export function sieht_aus_wie_admin(name) {
  const v = vergleichsname(name);
  if (v === "admin") return true;
  const z = [...v];
  if (z.length !== 5) return false;
  let fremd = false;
  for (let i = 0; i < 5; i++) {
    if (/[a-z]/.test(z[i])) { if (z[i] !== "admin"[i]) return false; }
    else if (/\p{L}/u.test(z[i])) fremd = true;
    else return false;
  }
  return fremd;
}

/** Verweise werden entwertet — ein Gästebuch ist keine Anzeigenfläche. */
export function ohneVerweise(text) {
  return text.replace(/(https?:\/\/|www\.)\S+/gi, "[Link entfernt]");
}

export default async function handler(req, res) {
  if (!lagerDa) {
    return antworte(res, 503, { fehler: "Der Speicher ist noch nicht angebunden." });
  }

  try {
    await vorbereiten();

    /* ---------------- lesen ---------------- */
    if (req.method === "GET") {
      const zeilen = await sql`
        select id, name, text, zeit from gaestebuch
        order by zeit desc limit ${HOECHSTENS}`;
      return antworte(res, 200, { eintraege: zeilen });
    }

    /* ---------------- schreiben ---------------- */
    if (req.method === "POST") {
      /* Nur JSON und nur von der eigenen Seite: sonst kann eine fremde Seite per no-cors-fetch
       * (text/plain, kein Preflight) im Namen jedes Besuchers Einträge anlegen (CSRF). */
      const typ = String(req.headers["content-type"] || "").toLowerCase();
      if (!typ.startsWith("application/json")) {
        return antworte(res, 403, { fehler: "So nicht." });
      }
      const sfs    = String(req.headers["sec-fetch-site"] || "").toLowerCase();
      const origin = String(req.headers["origin"] || "").toLowerCase();
      const eigene = origin === "https://ninasxmas.com" || origin === "https://www.ninasxmas.com"
                  || origin.endsWith(".vercel.app");   /* Vorschau-Deploys */
      const vonHier = sfs ? (sfs === "same-origin" || sfs === "none") : eigene;
      if (!vonHier) {
        return antworte(res, 403, { fehler: "So nicht." });
      }

      const wer = kurz(herkunft(req));
      if (!(await bremse(`buch:${wer}`, 1, PAUSE_SEK))) {
        return antworte(res, 429, {
          fehler: "Zwei Minuten Pause zwischen zwei Einträgen. Sonst wird es hier schnell voll.",
        });
      }

      const roh  = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const name = saeubern(roh.name, NAME_MAX) || "Jemand";
      const text = ohneVerweise(saeubern(roh.text, TEXT_MAX));

      /* „admin" ist der Löschname — als Absender gesperrt, damit niemand Einträge der Betreiberin
       * vortäuscht. Geprüft wird die Vergleichsform (ohne Leerraum/unsichtbare Zeichen) und
       * zusätzlich das Aussehen: ein „admin" mit einem kyrillischen а zählt genauso. */
      if (sieht_aus_wie_admin(name)) {
        return antworte(res, 400, { fehler: "Der Name ist vergeben. Nimm einen anderen." });
      }

      if (text.length < 2) {
        return antworte(res, 400, { fehler: "Schreib ein paar Worte, dann geht es." });
      }

      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const [eintrag] = await sql`
        insert into gaestebuch (id, name, text) values (${id}, ${name}, ${text})
        returning id, name, text, zeit`;

      return antworte(res, 200, { eintrag });
    }

    /* ---------------- löschen ---------------- */
    if (req.method === "DELETE") {
      const roh = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const erwartet = process.env.ADMIN_PASSWORT || "";

      if (!erwartet) {
        return antworte(res, 503, { fehler: "Es ist kein Passwort hinterlegt." });
      }

      /* Auch Rateversuche werden gebremst. */
      const wer = kurz(herkunft(req));
      if (!(await bremse(`loeschen:${wer}`, 10, 300))) {
        return antworte(res, 429, { fehler: "Zu viele Versuche. In fünf Minuten wieder." });
      }

      if (String(roh.name || "") !== "admin" || String(roh.passwort || "") !== erwartet) {
        return antworte(res, 401, { fehler: "Name oder Passwort stimmt nicht." });
      }

      const id = String(roh.id || "");
      if (!id) return antworte(res, 400, { fehler: "Welcher Eintrag?" });

      const weg = await sql`delete from gaestebuch where id = ${id} returning id`;
      if (!weg.length) return antworte(res, 404, { fehler: "Den gibt es nicht mehr." });

      return antworte(res, 200, { weg: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return antworte(res, 405, { fehler: "So nicht." });
  } catch (e) {
    return antworte(res, 500, { fehler: "Das Gästebuch ist gerade nicht erreichbar." });
  }
}
