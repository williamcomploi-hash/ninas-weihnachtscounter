/* Der Keks-Zähler.
 *
 *   GET  /api/keks           → { stand }
 *   POST /api/keks {anzahl}  → { stand }
 *
 * Gespeichert wird eine einzige Zahl. Kein Name, keine Adresse, kein Gerät —
 * es gibt hier nichts, was einer Person zuzuordnen wäre.
 */

import { sql, lagerDa, vorbereiten, bremse, herkunft, kurz, antworte } from "./_lager.js";

const HOECHSTENS_JE_ANFRAGE = 25;   /* mehr als 25 auf einmal ist kein Klopfen mehr */
const JE_MINUTE = 120;              /* je Adresse */

export default async function handler(req, res) {
  if (!lagerDa) {
    return antworte(res, 503, { fehler: "Der Speicher ist noch nicht angebunden." });
  }

  try {
    await vorbereiten();

    if (req.method === "GET") {
      const [zeile] = await sql`select stand from keks where name = 'gesamt'`;
      return antworte(res, 200, { stand: Number(zeile?.stand) || 0 });
    }

    if (req.method === "POST") {
      const wer = kurz(herkunft(req));
      if (!(await bremse(`keks:${wer}`, JE_MINUTE, 60))) {
        const [zeile] = await sql`select stand from keks where name = 'gesamt'`;
        return antworte(res, 429, {
          stand: Number(zeile?.stand) || 0,
          fehler: "Zu schnell. Gleich wieder.",
        });
      }

      const roh = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      let anzahl = Math.floor(Number(roh.anzahl));
      if (!Number.isFinite(anzahl) || anzahl < 1) anzahl = 1;
      if (anzahl > HOECHSTENS_JE_ANFRAGE) anzahl = HOECHSTENS_JE_ANFRAGE;

      /* Erhöhen und den neuen Stand in einem Zug — so kommen gleichzeitige
         Klicks von verschiedenen Leuten nicht durcheinander. */
      const [zeile] = await sql`
        update keks set stand = stand + ${anzahl}
        where name = 'gesamt'
        returning stand`;

      return antworte(res, 200, { stand: Number(zeile?.stand) || 0 });
    }

    res.setHeader("Allow", "GET, POST");
    return antworte(res, 405, { fehler: "So nicht." });
  } catch (e) {
    return antworte(res, 500, { fehler: "Der Zähler ist gerade nicht erreichbar." });
  }
}
