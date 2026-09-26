/* Der gemeinsame Speicher.
 *
 * Dahinter liegt Neon (Postgres), das Vercel unter Storage angelegt hat.
 *
 * WARUM NICHT REDIS: Die kostenlose Redis-Stufe bei Vercel hält alles nur im
 * Arbeitsspeicher — „No persistence". Ein Neustart der Datenbank, und der
 * Kekszähler steht auf null und das Gästebuch ist leer. Für eine Zahl wäre das
 * ärgerlich, für Einträge, die jemand für Nina geschrieben hat, nicht
 * hinnehmbar. Neon schreibt auf Platte.
 *
 * Angebunden über die HTTP-Schnittstelle des Neon-Treibers: kein
 * Verbindungsaufbau, kein offener Anschluss, keine Verbindungsgrenze — das
 * Richtige für Funktionen, die nur Sekundenbruchteile leben.
 */

import { neon } from "@neondatabase/serverless";
import { createHmac } from "node:crypto";

/* Wie die Variable heißt, hängt davon ab, welches Präfix beim Verbinden in
   Vercel gesetzt wurde — DATABASE_URL, POSTGRES_URL, STORAGE_URL … Statt die
   Namen zu raten, wird die erste Umgebungsvariable genommen, die tatsächlich
   eine Postgres-Adresse enthält. Bevorzugt die gebündelte Verbindung
   (pgbouncer), weil Funktionen kurz leben und viele davon gleichzeitig laufen.

   Ohne das müsste bei jedem Umbenennen in der Oberfläche auch hier etwas
   geändert werden — und dann steht die Seite still, ohne dass jemand weiß warum. */
function findeAdresse() {
  const passt = ([, wert]) =>
    typeof wert === "string" && /^postgres(ql)?:\/\//i.test(wert);

  const alle = Object.entries(process.env).filter(passt);
  if (!alle.length) return "";

  /* Ungebündelte Verbindungen zuletzt — sie sind für lange Sitzungen gedacht. */
  const gebuendelt = alle.filter(([name]) => !/UNPOOLED|NON_?POOLING/i.test(name));
  const reihe = gebuendelt.length ? gebuendelt : alle;

  const lieber = ["DATABASE_URL", "POSTGRES_URL", "STORAGE_URL", "NEON_DATABASE_URL"];
  for (const name of lieber) {
    const treffer = reihe.find(([n]) => n === name);
    if (treffer) return treffer[1];
  }
  return reihe[0][1];
}

const URL_ = findeAdresse();

export const lagerDa = Boolean(URL_);

const sql = lagerDa ? neon(URL_) : null;
export { sql };

/* Die Tabellen entstehen beim ersten Zugriff. Absichtlich hier und nicht in
   einer eigenen Migration: es sind wenige Tabellen, sie ändern sich nicht, und
   ein Ablauf, den jemand von Hand anstoßen müsste, wird irgendwann vergessen. */
let vorbereitet = null;
export function vorbereiten() {
  if (!lagerDa) throw new Error("Kein Speicher angebunden");
  if (!vorbereitet) {
    vorbereitet = (async () => {
      await sql`create table if not exists keks (
        name  text primary key,
        stand bigint not null default 0
      )`;
      await sql`insert into keks (name, stand) values ('gesamt', 0)
                on conflict (name) do nothing`;
      await sql`create table if not exists gaestebuch (
        id   text primary key,
        name text not null,
        text text not null,
        zeit timestamptz not null default now()
      )`;
      await sql`create index if not exists gaestebuch_zeit on gaestebuch (zeit desc)`;
      await sql`create table if not exists bremse (
        schluessel text primary key,
        zaehler    integer not null,
        bis        timestamptz not null
      )`;
      /* Wunsch-Trailer: Vorschläge und ihre Likes. Die Likes in eigener Tabelle
         mit (wunsch_id, fingerabdruck) als Primärschlüssel — damit ist ein
         zweites Like desselben Abdrucks auf denselben Vorschlag schon von der
         Datenbank her unmöglich, auch wenn zwei Klicks gleichzeitig ankommen.
         Ein Zähler als Spalte in „wunsch" wäre schneller zu lesen, könnte aber
         nicht wissen, WER schon geliked hat. on delete cascade: löscht die
         Verwaltung einen Vorschlag, gehen seine Likes mit. */
      await sql`create table if not exists wunsch (
        id    text primary key,
        name  text not null,
        titel text not null,
        zeit  timestamptz not null default now()
      )`;
      await sql`create table if not exists wunsch_likes (
        wunsch_id     text not null references wunsch (id) on delete cascade,
        fingerabdruck text not null,
        zeit          timestamptz not null default now(),
        primary key (wunsch_id, fingerabdruck)
      )`;
    })().catch(e => { vorbereitet = null; throw e; });
  }
  return vorbereitet;
}

/** Die Adresse des Aufrufers — nur für die Bremse, wird nirgends gespeichert. */
export function herkunft(req) {
  const kopf = req.headers["x-forwarded-for"] || "";
  return String(kopf).split(",")[0].trim() || "unbekannt";
}

/** Kurzer, gleichbleibender Fingerabdruck (für Bremsschlüssel). */
export function kurz(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/* Salz für den Like-Abdruck. Bevorzugt eine eigene Umgebungsvariable
   WUNSCH_SALZ; fehlt sie, dient die Datenbankadresse als Geheimnis — sie
   enthält das Datenbankpasswort, steht nie in der Seite und ist ohnehin da.
   Absichtlich NICHT ADMIN_PASSWORT: das wird eher einmal geändert, und jede
   Änderung des Salzes macht alle Abdrücke neu — dann dürfte jeder jeden
   Vorschlag ein zweites Mal liken. Dasselbe gilt, wenn WUNSCH_SALZ später
   gesetzt oder das Datenbankpasswort gedreht wird: die Likes bleiben stehen,
   nur die Sperre „schon geliked" beginnt von vorn. */
const SALZ = process.env.WUNSCH_SALZ || URL_;

/**
 * Abdruck für „einmal liken": dieselbe Herkunft wie bei der Bremse
 * (herkunft), aber gesalzen und mit HMAC-SHA-256 statt mit kurz().
 *
 * Warum nicht einfach kurz(herkunft(req)) wie die Bremse: die Bremszeilen
 * verfallen nach Minuten, der Like-Abdruck bleibt liegen. Ein ungesalzener
 * 32-Bit-Hash einer IPv4-Adresse lässt sich in Sekunden durch alle vier
 * Milliarden Adressen zurückrechnen — gespeichert wäre dann faktisch die
 * Adresse. Mit geheimem Salz geht das nicht, solange das Salz nicht bekannt
 * ist. 24 Hexzeichen (96 Bit) genügen gegen Zufallstreffer bei weitem.
 *
 * `zweck` trennt die Abdrücke verschiedener Verwendungen, damit derselbe
 * Wert nicht über Tabellen hinweg dieselbe Person verknüpft.
 */
export function abdruck(req, zweck) {
  return createHmac("sha256", SALZ)
    .update(zweck + ":" + herkunft(req))
    .digest("hex")
    .slice(0, 24);
}

/**
 * Bremse: höchstens `wieviel` Vorgänge je `sekunden`.
 * Gibt true zurück, wenn es weitergehen darf.
 *
 * Abgelaufene Zeilen werden beim Zugriff überschrieben, alte nebenbei
 * weggeräumt — es sammelt sich also nichts an.
 */
export async function bremse(schluessel, wieviel, sekunden) {
  const [zeile] = await sql`
    insert into bremse (schluessel, zaehler, bis)
      values (${schluessel}, 1, now() + make_interval(secs => ${sekunden}))
    on conflict (schluessel) do update set
      zaehler = case when bremse.bis < now() then 1 else bremse.zaehler + 1 end,
      bis     = case when bremse.bis < now()
                     then now() + make_interval(secs => ${sekunden})
                     else bremse.bis end
    returning zaehler`;

  /* Gelegentlich aufräumen — nicht bei jedem Aufruf, das wäre Verschwendung. */
  if (Math.random() < 0.02) {
    sql`delete from bremse where bis < now() - interval '1 day'`.catch(() => {});
  }
  return Number(zeile.zaehler) <= wieviel;
}

export function antworte(res, code, daten) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(code).send(JSON.stringify(daten));
}
