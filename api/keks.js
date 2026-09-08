/* Der Keks-Zähler.
 *
 *   GET  /api/keks           → { stand }
 *   POST /api/keks {anzahl}  → { stand }
 *
 * Gespeichert wird eine einzige Zahl. Kein Name, keine Adresse, kein Gerät —
 * es gibt hier nichts, was einer Person zuzuordnen wäre.
 */

import { befehl, lagerDa, bremse, herkunft, kurz, antworte } from "./_lager.js";

const SCHLUESSEL = "keks:gesamt";
const HOECHSTENS_JE_ANFRAGE = 25;   /* mehr als 25 auf einmal ist kein Klopfen mehr */
const JE_MINUTE = 120;              /* je Adresse */

export default async function handler(req, res) {
  if (!lagerDa) {
    return antworte(res, 503, { fehler: "Der Speicher ist noch nicht angebunden." });
  }

  try {
    if (req.method === "GET") {
      const stand = Number(await befehl("GET", SCHLUESSEL)) || 0;
      return antworte(res, 200, { stand });
    }

    if (req.method === "POST") {
      const wer = kurz(herkunft(req));
      if (!(await bremse(`bremse:keks:${wer}`, JE_MINUTE, 60))) {
        const stand = Number(await befehl("GET", SCHLUESSEL)) || 0;
        return antworte(res, 429, { stand, fehler: "Zu schnell. Gleich wieder." });
      }

      const roh = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      let anzahl = Math.floor(Number(roh.anzahl));
      if (!Number.isFinite(anzahl) || anzahl < 1) anzahl = 1;
      if (anzahl > HOECHSTENS_JE_ANFRAGE) anzahl = HOECHSTENS_JE_ANFRAGE;

      const stand = Number(await befehl("INCRBY", SCHLUESSEL, anzahl)) || 0;
      return antworte(res, 200, { stand });
    }

    res.setHeader("Allow", "GET, POST");
    return antworte(res, 405, { fehler: "So nicht." });
  } catch (e) {
    return antworte(res, 500, { fehler: "Der Zähler ist gerade nicht erreichbar." });
  }
}
