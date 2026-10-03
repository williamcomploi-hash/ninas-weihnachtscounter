/* Wunsch-Trailer: welchen Film soll Snoopy als Nächstes auf den Arm nehmen?
 *
 *   GET    /api/wunsch                           → { wuensche: [...] }
 *   POST   /api/wunsch {titel, name}             → { wunsch }
 *   POST   /api/wunsch {aktion:"like",   id}     → { id, likes, geliked: true }
 *   POST   /api/wunsch {aktion:"unlike", id}     → { id, likes, geliked: false }
 *   DELETE /api/wunsch {id, name, passwort}      → { weg: true }
 *
 * Gebaut nach dem Muster von gaestebuch.js — dieselbe Säuberung (von dort
 * importiert, nicht abgeschrieben), dieselbe Herkunftsprüfung, dieselbe
 * Bremse, dasselbe Löschen mit ADMIN_PASSWORT.
 *
 * EINMAL LIKEN JE GERÄT: Der Server merkt sich je Like einen Abdruck aus der
 * Adresse des Aufrufers, gesalzen und gehasht (abdruck() in _lager.js). Die
 * Adresse selbst wird nirgends abgelegt. Der Primärschlüssel
 * (wunsch_id, fingerabdruck) macht ein zweites Like technisch unmöglich.
 * Was die Seite im Browser speichert (localStorage), ist nur Anzeige — ob
 * ein Like zählt, entscheidet allein der Server. Wer den Browser-Speicher
 * leert oder einen zweiten Browser nimmt, sieht beim nächsten Laden trotzdem
 * „schon geliked", weil der Server den Abdruck wiedererkennt.
 *
 * Die Grenze davon, bewusst hingenommen: alle Geräte hinter einem Anschluss
 * (Familie, Büro-WLAN) teilen sich eine Adresse und damit ein Like je
 * Vorschlag. Und wer das Netz wechselt (Handy: WLAN ↔ Mobilfunk), darf noch
 * einmal. Für eine Wunschliste auf einer Geschenkseite ist das genau richtig
 * einfach; alles Genauere hieße Anmeldung oder Geräte-Tracking.
 *
 * Was gespeichert wird: Titel, selbstgewählter Name, Zeitpunkt des
 * Vorschlags — und je Like nur der Abdruck, ohne Zeitpunkt. Kein Klartext
 * einer Adresse, kein Cookie. Die Abdrücke werden am 7. Jänner 2027 gelöscht
 * (LOESCHFRIST unten); so steht es auch im Hinweis unter der Liste in
 * index.html. Wer eines davon ändert, ändert das andere mit.
 *
 * Ohne Umgebungsvariable WUNSCH_SALZ sind Likes abgeschaltet (503), Liste und
 * Vorschläge laufen weiter — Begründung bei SALZ in _lager.js.
 */

import { sql, lagerDa, vorbereiten, bremse, adminBremse, herkunft, kurz, abdruck, bremsAbdruck,
         salzDa, antworte } from "./_lager.js";
import { saeubern, sieht_aus_wie_admin, ohneVerweise } from "./gaestebuch.js";

/* Angezeigt wird die Vereinigung aus den 40 meistgelikten und den 10
   neuesten Vorschlägen. Nur „die meistgelikten 50" hieß: ab dem 51.
   Vorschlag landete jeder neue mit null Likes hinter der Grenze und war für
   niemanden sichtbar — also konnte ihn auch niemand liken, und er kam nie
   mehr nach oben. Die zehn neuesten sind darum immer dabei. Die Liste ist
   so höchstens 50 lang, bei Überschneidung kürzer. */
const TOP_LIKES  = 40;
const NEUESTE    = 10;
const NAME_MAX   = 24;
const TITEL_MAX  = 80;
const ID_MAX     = 40;     /* Kennungen sind ~13 Zeichen; mehr ist kein echter Aufruf */
const PAUSE_SEK  = 120;    /* ein Vorschlag alle zwei Minuten je Adresse */
const LIKES_JE_MINUTE = 60;/* reicht für flottes Durchklicken, nicht für ein Skript */

/* Zweck-Kennung im Abdruck: trennt ihn von künftigen anderen Abdrücken. Wird sie
   geändert, gelten alle bisherigen Likes als „von niemandem" — dann darf jeder
   noch einmal liken. Also stehen lassen. */
const ZWECK = "wunsch-like";
/* Eigene Zweck-Kennung für die Bremsschlüssel — getrennt vom Like-Abdruck,
   damit man aus der Bremstabelle nicht ablesen kann, welche Likes zu wem
   gehören. Darf geändert werden; es verfallen dann nur laufende Bremsen. */
const ZWECK_BREMSE = "wunsch-bremse";

/* Löschfrist der Like-Abdrücke: 7. Jänner 2027, 0 Uhr Wiener Zeit (im Jänner
   gilt MEZ = UTC+1, darum 23 Uhr UTC am Vortag). Ab dann löscht JEDER Aufruf
   von /api/wunsch alle Zeilen aus wunsch_likes — kein Zeitplan, kein Cron,
   den jemand einrichten müsste: irgendwer öffnet die Seite schon, und bis
   dahin ist der Befehl ein Leerlauf auf einer leeren Tabelle (billig und
   beliebig oft wiederholbar). Mit den Abdrücken sind auch die Like-Zahlen
   weg; nach Weihnachten ist das gewollt. Wer danach noch liked, dessen
   Abdruck lebt nur bis zum nächsten Aufruf. Die Vorschläge selbst bleiben. */
const LOESCHFRIST = Date.parse("2027-01-06T23:00:00Z");

/** Nur JSON und nur von der eigenen Seite — dieselbe Prüfung wie im Gästebuch
 *  (dort steht sie im Handler). Ohne sie könnte eine fremde Seite per
 *  no-cors-fetch (text/plain, kein Preflight) im Namen jedes Besuchers
 *  Vorschläge anlegen oder liken (CSRF). Kommt eine Domain dazu: hier UND in
 *  gaestebuch.js nachtragen.
 *  Exportiert, weil api/snoopy.js (Geheimwort) dieselbe Prüfung braucht —
 *  dort verhindert sie, dass eine fremde Seite das Geheimwort über die
 *  Browser ihrer Besucher durchprobieren lässt (jeder Besucher eine andere
 *  Adresse, die Bremse griffe ins Leere). Eine Fassung für beide. */
export function vonDerEigenenSeite(req) {
  const typ = String(req.headers["content-type"] || "").toLowerCase();
  if (!typ.startsWith("application/json")) return false;
  const sfs    = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  const origin = String(req.headers["origin"] || "").toLowerCase();
  const eigene = origin === "https://ninasxmas.com" || origin === "https://www.ninasxmas.com"
              || origin.endsWith(".vercel.app");   /* Vorschau-Deploys */
  return sfs ? (sfs === "same-origin" || sfs === "none") : eigene;
}

/** Der JSON-Körper als Objekt — oder null, wenn keiner da ist, er kaputt ist
 *  oder kein Objekt ergibt (`null`, eine Zahl, eine Liste). Der Aufrufer
 *  antwortet dann 400. Früher warf JSON.parse bis in den äußeren catch
 *  (500 „nicht erreichbar", obwohl nur die Anfrage falsch war), und ein
 *  Körper `null` lief als Objekt weiter, bis `roh.aktion` knallte.
 *  Der Zugriff auf req.body steht mit im try: Vercel parst den Körper erst
 *  beim Lesen und wirft dabei selbst, wenn das JSON kaputt ist. */
function koerper(req) {
  let roh;
  try {
    roh = req.body;
    if (typeof roh === "string") roh = roh ? JSON.parse(roh) : null;
  } catch {
    return null;
  }
  return roh && typeof roh === "object" && !Array.isArray(roh) ? roh : null;
}
const KAPUTT = "Die Anfrage war nicht lesbar.";

/** Aktuelle Like-Zahl eines Vorschlags. */
async function likesVon(id) {
  const [z] = await sql`select count(*)::int as n from wunsch_likes where wunsch_id = ${id}`;
  return Number(z?.n) || 0;
}

export default async function handler(req, res) {
  if (!lagerDa) {
    return antworte(res, 503, { fehler: "Der Speicher ist noch nicht angebunden." });
  }

  try {
    await vorbereiten();

    /* Löschfrist: siehe LOESCHFRIST oben. Vor allem anderen, damit auch ein
       GET nach der Frist keine alten Abdrücke mehr auswertet. */
    if (Date.now() >= LOESCHFRIST) {
      await sql`delete from wunsch_likes`;
    }

    /* ---------------- lesen ----------------
       Auswahl: die TOP_LIKES meistgelikten ∪ die NEUESTE neuesten (union
       entfernt Doppelte), danach wie immer sortiert — nach Likes, bei
       Gleichstand der neuere zuerst. `geliked` sagt, ob DIESER Aufrufer (sein
       Abdruck) schon geliked hat; der Abdruck selbst geht nie an den Browser.
       Ohne Salz ist `ich` null, der Vergleich ergibt null und coalesce macht
       daraus false — die Liste kommt dann ohne gefüllte Herzen. */
    if (req.method === "GET") {
      const ich = abdruck(req, ZWECK);
      const zeilen = await sql`
        with gezaehlt as (
          select w.id, w.name, w.titel, w.zeit,
                 count(l.fingerabdruck)::int                       as likes,
                 coalesce(bool_or(l.fingerabdruck = ${ich}), false) as geliked
            from wunsch w
            left join wunsch_likes l on l.wunsch_id = w.id
           group by w.id
        ), auswahl as (
          (select id from gezaehlt order by likes desc, zeit desc limit ${TOP_LIKES})
          union
          (select id from gezaehlt order by zeit desc limit ${NEUESTE})
        )
        select g.* from gezaehlt g
         where g.id in (select id from auswahl)
         order by g.likes desc, g.zeit desc`;
      return antworte(res, 200, { wuensche: zeilen });
    }

    /* ---------------- vorschlagen / liken ---------------- */
    if (req.method === "POST") {
      if (!vonDerEigenenSeite(req)) {
        return antworte(res, 403, { fehler: "So nicht." });
      }
      const roh = koerper(req);
      if (!roh) return antworte(res, 400, { fehler: KAPUTT });

      /* Bremsschlüssel gesalzen wie der Like-Abdruck, nicht mehr kurz():
         auch Bremszeilen liegen in der Datenbank, und ein ungesalzener
         32-Bit-Hash ist faktisch die Adresse (siehe abdruck in _lager.js). */
      const wer = bremsAbdruck(req, ZWECK_BREMSE);

      /* ---- Like setzen oder zurücknehmen ----
         Zwei getrennte Aktionen statt eines Umschalters: kommt ein Doppelklick
         doppelt an, bleibt „like, like" ein Like — ein Umschalter würde es
         gleich wieder zurücknehmen und die Anzeige stünde falsch. */
      if (roh.aktion === "like" || roh.aktion === "unlike") {
        /* Ohne Salz keine Likes — vor der Bremse, damit niemand für einen
           Klick gebremst wird, der ohnehin nichts bewirken kann. */
        if (!salzDa) {
          return antworte(res, 503, { fehler: "Likes sind gerade nicht eingerichtet." });
        }
        if (!(await bremse(`wunschlike:${wer}`, LIKES_JE_MINUTE, 60))) {
          return antworte(res, 429, { fehler: "Zu schnell. Gleich wieder." });
        }
        const id = String(roh.id || "").slice(0, ID_MAX);
        if (!id) return antworte(res, 400, { fehler: "Welcher Vorschlag?" });

        const [da] = await sql`select 1 as ja from wunsch where id = ${id}`;
        if (!da) return antworte(res, 404, { fehler: "Den Vorschlag gibt es nicht mehr." });

        const ich = abdruck(req, ZWECK);
        if (roh.aktion === "like") {
          /* on conflict do nothing: ein zweites Like desselben Abdrucks
             prallt am Primärschlüssel ab, ohne Fehler — die Antwort sagt dann
             einfach „geliked", mit unveränderter Zahl. „zeit" bleibt leer
             (siehe _lager.js).
             23503 = Fremdschlüssel verletzt: die Verwaltung hat den Vorschlag
             zwischen der Prüfung oben und diesem Insert gelöscht. Das ist
             kein Serverfehler, sondern dasselbe wie „gibt es nicht" → 404. */
          try {
            await sql`insert into wunsch_likes (wunsch_id, fingerabdruck)
                      values (${id}, ${ich}) on conflict do nothing`;
          } catch (e) {
            if (e?.code === "23503") {
              return antworte(res, 404, { fehler: "Den Vorschlag gibt es nicht mehr." });
            }
            throw e;
          }
        } else {
          await sql`delete from wunsch_likes
                     where wunsch_id = ${id} and fingerabdruck = ${ich}`;
        }
        return antworte(res, 200, {
          id, likes: await likesVon(id), geliked: roh.aktion === "like",
        });
      }

      /* ---- neuer Vorschlag ---- */
      /* Zu lang wird abgelehnt statt still gekürzt (anders als im Gästebuch):
         ein abgeschnittener Filmtitel ist ein falscher Filmtitel. Das Feld in
         der Seite lässt ohnehin nicht mehr zu — hier landet nur, wer an der
         Seite vorbei schickt. Gemessen wird nach dem Säubern, damit
         unsichtbare Zeichen nicht mitzählen. */
      const nameVoll  = saeubern(roh.name, Infinity);
      const titelVoll = saeubern(roh.titel, Infinity);
      if (nameVoll.length > NAME_MAX) {
        return antworte(res, 400, { fehler: `Der Name darf höchstens ${NAME_MAX} Zeichen haben.` });
      }
      if (titelVoll.length > TITEL_MAX) {
        return antworte(res, 400, { fehler: `Höchstens ${TITEL_MAX} Zeichen, bitte.` });
      }

      const name  = nameVoll || "Anonym";
      /* Verweise entwerten, dann nochmals kürzen: „[Link entfernt]" ist länger
         als manche Adresse und darf die Grenze nicht sprengen. */
      const titel = ohneVerweise(titelVoll).slice(0, TITEL_MAX).trim();

      /* „admin" ist der Löschname — als Absender gesperrt, wie im Gästebuch. */
      if (sieht_aus_wie_admin(name)) {
        return antworte(res, 400, { fehler: "Der Name ist vergeben. Nimm einen anderen." });
      }
      if (titel.length < 2) {
        return antworte(res, 400, { fehler: "Schreib einen Filmtitel oder eine Idee." });
      }

      /* Die Bremse erst NACH der Prüfung (im Gästebuch steht sie davor): wer
         sich vertippt, einen zu langen Titel schickt oder „admin" heißen will,
         soll nach dem Korrigieren nicht zwei Minuten warten müssen. Gebremst
         wird, was tatsächlich gespeichert würde. */
      if (!(await bremse(`wunsch:${wer}`, 1, PAUSE_SEK))) {
        return antworte(res, 429, {
          fehler: "Zwei Minuten Pause zwischen zwei Vorschlägen.",
        });
      }

      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const [z] = await sql`
        insert into wunsch (id, name, titel) values (${id}, ${name}, ${titel})
        returning id, name, titel, zeit`;

      return antworte(res, 200, { wunsch: { ...z, likes: 0, geliked: false } });
    }

    /* ---------------- löschen ----------------
       Wie im Gästebuch: nur mit ADMIN_PASSWORT, Rateversuche gebremst. Die
       Likes gehen per „on delete cascade" mit. Eigener Bremsschlüssel, damit
       Aufräumen im Gästebuch und hier sich nicht gegenseitig aufbraucht. */
    if (req.method === "DELETE") {
      const roh = koerper(req);
      if (!roh) return antworte(res, 400, { fehler: KAPUTT });
      const erwartet = process.env.ADMIN_PASSWORT || "";
      if (!erwartet) {
        return antworte(res, 503, { fehler: "Es ist kein Passwort hinterlegt." });
      }

      const wer = kurz(herkunft(req));
      if (!(await bremse(`wunschweg:${wer}`, 10, 300))) {
        return antworte(res, 429, { fehler: "Zu viele Versuche. In fünf Minuten wieder." });
      }
      /* Dazu die gemeinsame Admin-Bremse über alle Wege (siehe _lager.js). */
      if (!(await adminBremse(req))) {
        return antworte(res, 429, { fehler: "Zu viele Versuche. In fünf Minuten wieder." });
      }

      if (String(roh.name || "") !== "admin" || String(roh.passwort || "") !== erwartet) {
        return antworte(res, 401, { fehler: "Name oder Passwort stimmt nicht." });
      }

      const id = String(roh.id || "").slice(0, ID_MAX);
      if (!id) return antworte(res, 400, { fehler: "Welcher Vorschlag?" });

      const weg = await sql`delete from wunsch where id = ${id} returning id`;
      if (!weg.length) return antworte(res, 404, { fehler: "Den gibt es nicht mehr." });

      return antworte(res, 200, { weg: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return antworte(res, 405, { fehler: "So nicht." });
  } catch (e) {
    return antworte(res, 500, { fehler: "Die Wunschliste ist gerade nicht erreichbar." });
  }
}
