/* Der gemeinsame Speicher.
 *
 * Dahinter liegt Redis bei Upstash, das Vercel unter Storage anlegt. Angebunden
 * über die REST-Schnittstelle — damit braucht es keine Abhängigkeit, keinen
 * Verbindungsaufbau und keinen offenen Anschluss, was für Funktionen, die nur
 * Sekundenbruchteile leben, der richtige Weg ist.
 *
 * Die Zugangsdaten kommen aus den Umgebungsvariablen, die Vercel beim Anlegen
 * selbst setzt. Je nach Weg heißen sie unterschiedlich, deshalb beide Namen.
 */

const URL_    = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || "";
const SCHLUES = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export const lagerDa = Boolean(URL_ && SCHLUES);

/** Ein Redis-Befehl. Gibt `result` zurück oder wirft. */
export async function befehl(...teile) {
  if (!lagerDa) throw new Error("Kein Speicher angebunden");
  const antwort = await fetch(URL_, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SCHLUES}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(teile.map(String)),
  });
  if (!antwort.ok) throw new Error(`Speicher antwortet mit ${antwort.status}`);
  const d = await antwort.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

/** Die Adresse des Aufrufers — nur für die Bremse, wird nirgends gespeichert. */
export function herkunft(req) {
  const kopf = req.headers["x-forwarded-for"] || "";
  return String(kopf).split(",")[0].trim() || "unbekannt";
}

/**
 * Bremse: höchstens `wieviel` Vorgänge je `sekunden` und Adresse.
 * Gibt true zurück, wenn es weitergehen darf.
 *
 * Der Schlüssel trägt nur einen Zähler, keine Adresse im Klartext — und er
 * verfällt von selbst. Es bleibt also nichts liegen.
 */
export async function bremse(schluessel, wieviel, sekunden) {
  const n = Number(await befehl("INCR", schluessel));
  if (n === 1) await befehl("EXPIRE", schluessel, sekunden);
  return n <= wieviel;
}

/** Kurzer, gleichbleibender Fingerabdruck einer Zeichenkette (für Bremsschlüssel). */
export function kurz(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function antworte(res, code, daten) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(code).send(JSON.stringify(daten));
}
