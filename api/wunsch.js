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
 * Was gespeichert wird: Titel, selbstgewählter Name, Zeitpunkt — und je Like
 * der Abdruck. Kein Klartext einer Adresse, kein Cookie.
 */

import { sql, lagerDa, vorbereiten, bremse, herkunft, kurz, abdruck, antworte } from "./_lager.js";
import { saeubern, sieht_aus_wie_admin, ohneVerweise } from "./gaestebuch.js";

const HOECHSTENS = 50;     /* so viele werden angezeigt — die meistgelikten */
const NAME_MAX   = 24;
const TITEL_MAX  = 80;
const ID_MAX     = 40;     /* Kennungen sind ~13 Zeichen; mehr ist kein echter Aufruf */
const PAUSE_SEK  = 120;    /* ein Vorschlag alle zwei Minuten je Adresse */
const LIKES_JE_MINUTE = 60;/* reicht für flottes Durchklicken, nicht für ein Skript */

/* Zweck-Kennung im Abdruck: trennt ihn von künftigen anderen Abdrücken. Wird sie
   geändert, gelten alle bisherigen Likes als „von niemandem" — dann darf jeder
   noch einmal liken. Also stehen lassen. */
const ZWECK = "wunsch-like";

/** Nur JSON und nur von der eigenen Seite — dieselbe Prüfung wie im Gästebuch
 *  (dort steht sie im Handler). Ohne sie könnte eine fremde Seite per
 *  no-cors-fetch (text/plain, kein Preflight) im Namen jedes Besuchers
 *  Vorschläge anlegen oder liken (CSRF). Kommt eine Domain dazu: hier UND in
 *  gaestebuch.js nachtragen. */
function vonDerEigenenSeite(req) {
  const typ = String(req.headers["content-type"] || "").toLowerCase();
  if (!typ.startsWith("application/json")) return false;
  const sfs    = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  const origin = String(req.headers["origin"] || "").toLowerCase();
  const eigene = origin === "https://ninasxmas.com" || origin === "https://www.ninasxmas.com"
              || origin.endsWith(".vercel.app");   /* Vorschau-Deploys */
  return sfs ? (sfs === "same-origin" || sfs === "none") : eigene;
}

function koerper(req) {
  return typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
}

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

    /* ---------------- lesen ----------------
       Sortiert nach Likes, bei Gleichstand der neuere zuerst — sonst stünde
       ein frischer Vorschlag mit null Likes ganz unten hinter allen alten und
       würde nie gesehen. `geliked` sagt, ob DIESER Aufrufer (sein Abdruck)
       schon geliked hat; der Abdruck selbst geht nie an den Browser. */
    if (req.method === "GET") {
      const ich = abdruck(req, ZWECK);
      const zeilen = await sql`
        select w.id, w.name, w.titel, w.zeit,
               count(l.fingerabdruck)::int                       as likes,
               coalesce(bool_or(l.fingerabdruck = ${ich}), false) as geliked
          from wunsch w
          left join wunsch_likes l on l.wunsch_id = w.id
         group by w.id
         order by likes desc, w.zeit desc
         limit ${HOECHSTENS}`;
      return antworte(res, 200, { wuensche: zeilen });
    }

    /* ---------------- vorschlagen / liken ---------------- */
    if (req.method === "POST") {
      if (!vonDerEigenenSeite(req)) {
        return antworte(res, 403, { fehler: "So nicht." });
      }
      const roh = koerper(req);
      const wer = kurz(herkunft(req));

      /* ---- Like setzen oder zurücknehmen ----
         Zwei getrennte Aktionen statt eines Umschalters: kommt ein Doppelklick
         doppelt an, bleibt „like, like" ein Like — ein Umschalter würde es
         gleich wieder zurücknehmen und die Anzeige stünde falsch. */
      if (roh.aktion === "like" || roh.aktion === "unlike") {
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
             einfach „geliked", mit unveränderter Zahl. */
          await sql`insert into wunsch_likes (wunsch_id, fingerabdruck)
                    values (${id}, ${ich}) on conflict do nothing`;
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
      const erwartet = process.env.ADMIN_PASSWORT || "";
      if (!erwartet) {
        return antworte(res, 503, { fehler: "Es ist kein Passwort hinterlegt." });
      }

      const wer = kurz(herkunft(req));
      if (!(await bremse(`wunschweg:${wer}`, 10, 300))) {
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
