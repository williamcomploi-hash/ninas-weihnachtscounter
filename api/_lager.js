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
import { createHmac, randomBytes } from "node:crypto";

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
        zeit          timestamptz,
        primary key (wunsch_id, fingerabdruck)
      )`;
      /* „zeit" wird seit der Datenschutz-Nachbesserung nicht mehr befüllt:
         Abdruck + Zeitpunkt zusammen verraten mehr als nötig (wann jemand
         von welchem Anschluss aus aktiv war), und gebraucht wird der
         Zeitpunkt für nichts — die Likes werden nur gezählt. Die Spalte
         bleibt stehen, damit die Tabelle nicht umgebaut werden muss; die
         beiden Zeilen nehmen der schon angelegten Tabelle nur Pflicht und
         Vorgabewert, sonst trüge Postgres bei jedem Insert still now() ein.
         Beides ändert nur den Katalog, keine Zeile, und darf beliebig oft
         laufen. Vorhandene Zeitstempel bleiben bis zur Löschfrist liegen. */
      await sql`alter table wunsch_likes alter column zeit drop not null`;
      await sql`alter table wunsch_likes alter column zeit drop default`;
    })().catch(e => { vorbereitet = null; throw e; });
  }
  return vorbereitet;
}

/** Die Adresse des Aufrufers. Sie selbst wird nirgends gespeichert — nur
 *  daraus gebildete Abdrücke: im Gästebuch kurz() als Bremsschlüssel (lebt
 *  höchstens bis zum Ablauf der Bremse, danach löscht der nächste Aufruf die
 *  Zeile), im Wunsch-Trailer abdruck()/bremsAbdruck() (gesalzen, siehe
 *  unten). Wer hier etwas Neues ablegt, muss den Hinweistext unter der
 *  Wunschliste in index.html mitziehen. */
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

/* Salz für den Like-Abdruck: ausschließlich die Umgebungsvariable
   WUNSCH_SALZ. Früher diente ersatzweise die Datenbankadresse als Geheimnis.
   Das ist entfernt, weil das Salz dann an einem fremden Wert hing: wer das
   Datenbankpasswort dreht (bei Neon ein Klick, etwa nach einem Leck), macht
   unbemerkt alle Abdrücke neu, und die Adresse steht in jeder Vercel-
   Umgebung, in die jemand die Datenbank einmal hineinverbindet. Fehlt
   WUNSCH_SALZ, sind Likes eben abgeschaltet (salzDa = false, api/wunsch.js
   antwortet 503) — Vorschläge und Liste gehen weiter. Lieber kein Like als
   ein Abdruck mit schwachem oder fremdem Geheimnis.

   Absichtlich NICHT ADMIN_PASSWORT: das wird eher einmal geändert, und jede
   Änderung des Salzes macht alle Abdrücke neu — dann dürfte jeder jeden
   Vorschlag ein zweites Mal liken. Also WUNSCH_SALZ einmal setzen (lang,
   zufällig) und stehen lassen. */
const SALZ = process.env.WUNSCH_SALZ || "";
export const salzDa = Boolean(SALZ);

/* Ersatzgeheimnis NUR für Bremsschlüssel, wenn WUNSCH_SALZ fehlt: zufällig je
   Funktionsinstanz, nirgends abgelegt, stirbt mit ihr. Eine Bremse muss nur
   zwei Minuten lang wiedererkennen, nicht über Instanzen hinweg — laufen
   mehrere Instanzen parallel, bremst sie etwas lockerer, mehr nicht. Für den
   Like-Abdruck taugt das nicht (der muss bis Jänner stabil bleiben), darum
   gibt es dort keinen Ersatz. */
const BREMS_ERSATZ = randomBytes(32).toString("hex");

function hmacAbdruck(geheimnis, zweck, req) {
  return createHmac("sha256", geheimnis)
    .update(zweck + ":" + herkunft(req))
    .digest("hex")
    .slice(0, 24);
}

/**
 * Abdruck für „einmal liken": dieselbe Herkunft wie bei der Bremse
 * (herkunft), aber gesalzen und mit HMAC-SHA-256 statt mit kurz().
 * Gibt null zurück, wenn kein Salz gesetzt ist — der Aufrufer muss das
 * prüfen (salzDa) und darf dann nichts ablegen.
 *
 * Warum nicht kurz(): ein ungesalzener 32-Bit-Hash einer IPv4-Adresse lässt
 * sich in Sekunden durch alle vier Milliarden Adressen zurückrechnen —
 * gespeichert wäre dann faktisch die Adresse. Mit geheimem Salz geht das
 * nicht, solange das Salz nicht bekannt ist. 24 Hexzeichen (96 Bit) genügen
 * gegen Zufallstreffer bei weitem.
 *
 * `zweck` trennt die Abdrücke verschiedener Verwendungen, damit derselbe
 * Wert nicht über Tabellen hinweg dieselbe Person verknüpft.
 */
export function abdruck(req, zweck) {
  return salzDa ? hmacAbdruck(SALZ, zweck, req) : null;
}

/**
 * Bremsschlüssel nach derselben Machart wie abdruck(), aber nie null: ohne
 * WUNSCH_SALZ mit dem zufälligen Ersatz (siehe BREMS_ERSATZ). So bleibt die
 * Bremse für Vorschläge auch dann wirksam, wenn Likes abgeschaltet sind.
 * Eigener `zweck` pflichtgemäß, damit ein Bremsschlüssel nie einem
 * Like-Abdruck gleicht.
 */
export function bremsAbdruck(req, zweck) {
  return hmacAbdruck(SALZ || BREMS_ERSATZ, zweck, req);
}

/**
 * Bremse: höchstens `wieviel` Vorgänge je `sekunden`.
 * Gibt true zurück, wenn es weitergehen darf.
 *
 * Abgelaufene Zeilen werden bei JEDEM Aufruf gelöscht, nicht nur
 * gelegentlich: ein Bremsschlüssel ist ein Abdruck der Adresse und soll
 * nicht länger liegen, als die Bremse ihn braucht (höchstens fünf Minuten).
 * Früher räumte nur jeder fünfzigste Aufruf auf, und das erst nach einem
 * Tag — dann lagen Abdrücke tagelang herum, obwohl die Seite etwas anderes
 * verspricht. Die zusätzliche Anfrage kostet Millisekunden; die Tabelle hat
 * nie mehr als eine Handvoll Zeilen. Absichtlich abgewartet und nicht
 * nebenher abgeschickt: eine Funktion, die schon geantwortet hat, darf
 * Vercel jederzeit einfrieren, dann bliebe das Löschen liegen.
 */
export async function bremse(schluessel, wieviel, sekunden) {
  await sql`delete from bremse where bis < now()`;
  const [zeile] = await sql`
    insert into bremse (schluessel, zaehler, bis)
      values (${schluessel}, 1, now() + make_interval(secs => ${sekunden}))
    on conflict (schluessel) do update set
      zaehler = case when bremse.bis < now() then 1 else bremse.zaehler + 1 end,
      bis     = case when bremse.bis < now()
                     then now() + make_interval(secs => ${sekunden})
                     else bremse.bis end
    returning zaehler`;
  return Number(zeile.zaehler) <= wieviel;
}

/**
 * Gemeinsame Bremse für JEDE Prüfung von ADMIN_PASSWORT: höchstens zehn
 * Versuche je fünf Minuten und Adresse, über alle Wege zusammen (Löschen im
 * Gästebuch, in der Wunschliste, Keks zurücksetzen, Snoopy-Geheimwort,
 * solange dort ADMIN_PASSWORT gilt). Gibt true zurück, wenn geprüft werden darf.
 *
 * Warum gemeinsam: jeder Weg hat seine eigene Bremse (10, 10, 5, 5). Einzeln
 * genommen ließ sich das Admin-Passwort so 30 Mal je fünf Minuten
 * durchprobieren — ein Angreifer wechselt einfach den Weg. Die Eigenbremsen
 * bleiben stehen; diese hier liegt zusätzlich darüber.
 *
 * Gezählt wird jede Prüfung, auch die richtige — sonst ließe sich mit einem
 * bekannten Passwort zwischendurch zurücksetzen. Die Folge im Alltag: wer
 * mehr als zehn Einträge in fünf Minuten löscht, wartet kurz. Das war mit
 * den Eigenbremsen je Weg vorher schon so.
 *
 * Gesalzener Abdruck (bremsAbdruck), eigener Zweck, damit der Schlüssel
 * keinem anderen Abdruck gleicht.
 */
export async function adminBremse(req) {
  return bremse(`admin:${bremsAbdruck(req, "admin-bremse")}`, 10, 300);
}

export function antworte(res, code, daten) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(code).send(JSON.stringify(daten));
}
