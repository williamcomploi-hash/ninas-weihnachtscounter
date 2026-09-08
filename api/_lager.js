/* Der gemeinsame Speicher.
 *
 * Dahinter liegt das Redis, das Vercel unter Storage angelegt hat. Angebunden
 * über `KV_REDIS_URL` — eine gewöhnliche Redis-Verbindung, kein REST-Zugang.
 *
 * VERBINDUNG WIRD WIEDERVERWENDET: Eine Funktion bei Vercel lebt nur
 * Sekundenbruchteile, aber der Prozess dahinter überlebt mehrere Aufrufe. Der
 * Client wird deshalb einmal aufgebaut und danach behalten. Ohne das käme bei
 * jedem Klick ein neuer Verbindungsaufbau dazu — und die freie Stufe hat eine
 * Obergrenze an gleichzeitigen Verbindungen.
 */

import { createClient } from "redis";

const URL_ = process.env.KV_REDIS_URL || process.env.REDIS_URL || "";

export const lagerDa = Boolean(URL_);

let klient = null;
let verbindet = null;

async function hol() {
  if (!lagerDa) throw new Error("Kein Speicher angebunden");

  if (klient && klient.isOpen) return klient;

  if (!verbindet) {
    klient = createClient({
      url: URL_,
      socket: {
        connectTimeout: 5000,
        /* Ein paar Versuche, dann aufgeben — eine Funktion darf nicht ewig warten. */
        reconnectStrategy: versuch => (versuch > 3 ? false : Math.min(versuch * 200, 800)),
      },
    });
    /* Ohne Zuhörer wirft ein Verbindungsfehler den ganzen Prozess um. */
    klient.on("error", () => {});
    verbindet = klient.connect().finally(() => { verbindet = null; });
  }

  await verbindet;
  return klient;
}

/** Ein Redis-Befehl, roh. Gibt die Antwort zurück oder wirft. */
export async function befehl(...teile) {
  const k = await hol();
  return k.sendCommand(teile.map(String));
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
