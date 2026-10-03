/* Snoopys geheime Aktionen (Kraulen, Laserpointer): das Geheimwort.
 *
 *   GET  /api/snoopy                 → { eingerichtet, frei: [...] }
 *   POST /api/snoopy {geheimwort}    → { eingerichtet, frei: [...] }  + Cookie
 *
 * DAS GEHEIMWORT STEHT NICHT IN DER SEITE UND NICHT IM REPO. Es liegt als
 * Umgebungsvariable bei Vercel und wird nur hier geprüft.
 *
 * WELCHES WORT (Entscheid des Inhabers, 03.10.2026): Vorerst dasselbe wie
 * beim Admin — ADMIN_PASSWORT, das schon für das Löschen im Gästebuch und in
 * der Wunschliste gilt. Für später ist ein eigenes Wort vorbereitet: ist
 * SNOOPY_GEHEIMWORT gesetzt, hat es Vorrang, und ADMIN_PASSWORT spielt hier
 * keine Rolle mehr. Fehlen beide, bleiben die Aktionen gesperrt, und die
 * Seite sagt freundlich, dass sie noch nicht eingerichtet sind (503 mit
 * eingerichtet:false). Absichtlich kein Ersatzwert im Code: der stünde
 * öffentlich auf GitHub und wäre damit kein Geheimnis.
 *
 * DRITTE PFLICHT: WUNSCH_SALZ. Damit wird die Freigabe unterschrieben (siehe
 * schluessel() unten). Fehlt es, gilt die Route als nicht eingerichtet —
 * auch wenn ein Wort da ist. Eine Unterschrift ohne eigenes Geheimnis wäre
 * fälschbar, und mit dem Passwort als Schlüssel würde GET zum Prüforakel.
 *
 * SOLANGE ADMIN_PASSWORT GILT, IST DAS GEHEIMWORT DAS ADMIN-PASSWORT. Wer es
 * kennt, kann im Gästebuch und in der Wunschliste löschen. Darum zählen
 * Versuche hier zusätzlich auf die gemeinsame Admin-Bremse (adminBremse in
 * _lager.js), und die Seite blendet das Getippte aus (index.html).
 *
 * DIE FREIGABE IST KEIN ADMIN-RECHT. Das Cookie unten öffnet nur Kraulen und
 * Laser. Die Admin-Wege (DELETE in gaestebuch.js, wunsch.js, keks.js) lesen
 * keine Cookies, sie verlangen das Passwort bei JEDER Anfrage im Körper —
 * wer hier freigeschaltet ist, kann dort nichts, was er nicht ohnehin
 * könnte. Wer später einmal ein Admin-Cookie baut: eigener Name, eigener
 * Schlüssel, und dieses hier darf dort nie gelten.
 *
 * Nichts hier schreibt das Wort oder die Eingabe irgendwohin — kein
 * console.log, keine Fehlermeldung mit Inhalt. Wer hier etwas protokollieren
 * will: niemals roh.geheimwort.
 *
 * WAS „FREI" HEISST: Nach dem richtigen Wort setzt der Server ein Cookie mit
 * einer unterschriebenen Freigabe (welche Aktionen, bis wann). HttpOnly — das
 * Skript der Seite kommt nicht heran, nur der Server liest es. Die Seite
 * merkt sich im localStorage bloß, DASS sie beim nächsten Laden nachfragen
 * soll; ob die Freigabe gilt, sagt GET hier. Kein Klartext, kein Wort im
 * Browser.
 *
 * VORBEREITET FÜR SPÄTER (Inhaber: „evtl. zum Kauf — nicht jetzt"): Die
 * Freigabe trägt eine Liste von Aktionen (AKTIONEN unten), nicht bloß „ja".
 * Ein späterer Weg — etwa ein Kauf — müsste nur dasselbe Cookie mit
 * unterschrift() ausstellen, die Seite bräuchte keine Änderung. Heute gibt
 * es diesen Weg nicht: kein Bezahlweg, keine Preise, nichts davon ist gebaut.
 *
 * Die ehrliche Grenze: Kraulen und Laser laufen ganz im Browser. Wer die
 * Entwicklerwerkzeuge bedienen kann, schaltet sie auch ohne Wort ein. Was
 * hier geschützt ist, ist das Wort selbst (nie im Client, gebremst
 * durchprobierbar). Für ein Spielzeug auf einer Geschenkseite genügt das;
 * für einen echten Verkauf müsste der Inhalt (etwa die neuen Bilder) erst
 * mit gültiger Freigabe vom Server kommen.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lagerDa, salzDa, vorbereiten, bremse, adminBremse, bremsAbdruck, antworte } from "./_lager.js";
import { vonDerEigenenSeite } from "./wunsch.js";

/* Welche Aktionen die Freigabe öffnet. Die Seite (index.html, SNOOPY_AKTIONEN)
   kennt dieselben Namen — wer hier eine dazunimmt, nimmt sie dort mit. */
const AKTIONEN = ["kraulen", "laser"];

/* Fünf Versuche je fünf Minuten und Adresse. Strenger als das Löschen im
   Gästebuch (zehn): solange hier ADMIN_PASSWORT gilt, ist diese Route ein
   weiterer Weg, das Admin-Passwort durchzuprobieren, und soll die
   bestehenden nicht nennenswert lockern. Eigener Bremsschlüssel (nicht
   „loeschen:"). Solange ADMIN_PASSWORT gilt, zählt jeder Versuch zusätzlich
   auf die gemeinsame Admin-Bremse (zehn je fünf Minuten über alle Wege) —
   dann kann sich ein Kind, das sich hier oft vertippt, kurz die Verwaltung
   sperren. Das ist der Preis dafür, dass beides dasselbe Wort ist.
   Länger als fünf Minuten nicht: die Bremstabelle soll keinen Abdruck
   länger halten, als die Bremse ihn braucht (siehe bremse() in _lager.js). */
const VERSUCHE   = 5;
const SPERRE_SEK = 300;
const ZWECK_BREMSE = "snoopy-bremse";

/* 120 Tage: reicht über den ganzen Advent bis weit in den Jänner, ohne dass
   eine Freigabe ewig lebt. Wer das Wort danach noch weiß, gibt es neu ein. */
const GILT_SEK = 120 * 24 * 3600;
const KEKS_NAME = "snoopy_frei";
/* Mehr ist kein Geheimwort, sondern ein Skript. Das Feld in index.html
   (maxlength am #snoopy-zauberwort) hat dieselbe Grenze — wer eine ändert,
   ändert die andere mit, sonst schneidet eines von beiden ab. */
const WORT_MAX  = 200;

/** Vergleichsform des Worts.
 *  NACHSICHTIG nur für ein eigenes SNOOPY_GEHEIMWORT: Leerraum außen weg,
 *  NFKC, Kleinschreibung — Handytastaturen schreiben das erste Zeichen groß
 *  und hängen gern ein Leerzeichen an; „Snoopy " soll dasselbe sein wie
 *  „snoopy". Gilt für das hinterlegte Wort genauso, egal wie es in Vercel
 *  eingetragen wurde.
 *  GENAU für ADMIN_PASSWORT, Zeichen für Zeichen wie beim Löschen: wäre der
 *  Vergleich hier unabhängig von Groß-/Kleinschreibung, ließe sich über diese
 *  Route erst die kleingeschriebene Form erraten und danach nur noch die
 *  Schreibweise — das Admin-Passwort würde dadurch schwächer. */
function vergleichsform(wort, nachsichtig) {
  const s = String(wort ?? "");
  return nachsichtig ? s.normalize("NFKC").trim().toLowerCase() : s;
}

/** Das gültige Wort und woher es kommt: SNOOPY_GEHEIMWORT vor ADMIN_PASSWORT
 *  (siehe Kopf). `quelle` geht in die Unterschrift ein — wechselt der
 *  Inhaber später auf ein eigenes Wort, verfallen die alten Freigaben. */
function hinterlegt() {
  const eigenes = process.env.SNOOPY_GEHEIMWORT || "";
  if (eigenes) return { wort: vergleichsform(eigenes, true), quelle: "snoopy", nachsichtig: true };
  return { wort: process.env.ADMIN_PASSWORT || "", quelle: "admin", nachsichtig: false };
}

/* Gleich lange Vergleichswerte für timingSafeEqual: beide Seiten werden mit
   einem zufälligen, nur in dieser Funktionsinstanz lebenden Schlüssel
   gehasht. timingSafeEqual verlangt gleiche Länge — ohne das Hashen verriete
   schon der Längenvergleich, wie lang das Wort ist. */
const VERGLEICHS_SCHLUESSEL = randomBytes(32);
function gleich(a, b) {
  const ha = createHmac("sha256", VERGLEICHS_SCHLUESSEL).update(a).digest();
  const hb = createHmac("sha256", VERGLEICHS_SCHLUESSEL).update(b).digest();
  return timingSafeEqual(ha, hb);
}

/* Unterschriftsschlüssel der Freigabe: allein aus WUNSCH_SALZ, NIE aus dem
   Passwort. Früher stand hier „WUNSCH_SALZ || wort" — ohne Salz war das
   Passwort selbst der Schlüssel. Dann konnte jeder für ein VERMUTETES
   Passwort ein Cookie selbst unterschreiben und per GET fragen, ob es gilt:
   ein Prüforakel ohne Bremse und ohne Herkunftsprüfung, mit dem sich
   ADMIN_PASSWORT ungebremst durchprobieren ließ (Befund B1 von Jonas,
   03.10.2026). Jetzt gilt: kein Salz, keine Freigabe — `eingerichtet` ist
   dann false (siehe handler), GET gibt nie etwas frei, POST antwortet 503.
   Mit dem Salz ist eine Unterschrift ohne das Salz nicht zu bauen, GET
   verrät also nichts über das Passwort.

   Der Preis: ein neues Passwort macht alte Freigaben NICHT mehr ungültig
   (es geht nicht mehr in den Schlüssel ein). Alle wieder aussperren geht
   über einen Wechsel der Quelle — SNOOPY_GEHEIMWORT setzen — oder über
   KEKS_VERSION unten. WUNSCH_SALZ dafür zu ändern hieße, alle Like-Abdrücke
   neu zu machen; das nicht. Mehr als Kraulen und Laser öffnet eine alte
   Freigabe ohnehin nicht. */
const KEKS_VERSION = "v1";   /* hochzählen (v2 …), um alle Freigaben zu beenden */
function schluessel(quelle) {
  return createHmac("sha256", process.env.WUNSCH_SALZ || "")
    .update("snoopy-freigabe:" + KEKS_VERSION + ":" + quelle)
    .digest();
}

const b64 = puffer => Buffer.from(puffer).toString("base64url");

/** Freigabe: „<KEKS_VERSION>.<bis>.<aktionen>.<unterschrift>". bis in Sekunden seit 1970.
 *  Exportiert nicht — ein späterer Kaufweg gehört in diese Datei, nicht daneben. */
function unterschrift(h, bis, aktionen) {
  const inhalt = `${KEKS_VERSION}.${bis}.${aktionen.join(",")}`;
  const sig = b64(createHmac("sha256", schluessel(h.quelle)).update(inhalt).digest());
  return `${inhalt}.${sig}`;
}

/** Liest und prüft die Freigabe aus dem Cookie. Gibt die freien Aktionen
 *  zurück — leer, wenn keine, abgelaufen, gefälscht, kein Wort oder kein
 *  Salz hinterlegt. Die Salz-Prüfung steht hier noch einmal, obwohl der
 *  handler schon `eingerichtet` prüft: ohne Salz darf diese Funktion unter
 *  keinen Umständen etwas freigeben, auch nicht, wenn sie später von
 *  anderswo aufgerufen wird. */
function freigabe(req, h) {
  if (!h.wort || !salzDa) return [];
  const kekse = String(req.headers.cookie || "");
  const treffer = kekse.split(";").map(s => s.trim())
    .find(s => s.startsWith(KEKS_NAME + "="));
  if (!treffer) return [];
  const wert = treffer.slice(KEKS_NAME.length + 1);
  const teile = wert.split(".");
  if (teile.length !== 4 || teile[0] !== KEKS_VERSION) return [];
  const bis = Number(teile[1]);
  if (!Number.isFinite(bis) || bis * 1000 < Date.now()) return [];
  const aktionen = teile[2].split(",").filter(a => AKTIONEN.includes(a));
  const erwartet = unterschrift(h, teile[1], teile[2].split(","));
  /* Über gleich(), nicht ===: auch die Unterschrift soll sich nicht Zeichen
     für Zeichen über die Antwortzeit erraten lassen. gleich() hasht beide
     Seiten, darum stört eine falsche Länge den Vergleich nicht. */
  return gleich(wert, erwartet) ? aktionen : [];
}

/** Der JSON-Körper als Objekt oder null — dieselbe Vorsicht wie koerper() in
 *  wunsch.js (dort nicht exportiert; vier Zeilen, darum hier noch einmal). */
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

const NICHT_EINGERICHTET =
  "Die geheimen Aktionen sind noch nicht eingerichtet. Schau später wieder vorbei.";

export default async function handler(req, res) {
  const h = hinterlegt();
  /* Eingerichtet heißt: ein Wort UND das Salz für die Unterschrift. */
  const eingerichtet = Boolean(h.wort) && salzDa;

  try {
    /* ---------------- nachfragen ----------------
       Braucht keine Datenbank: die Freigabe prüft sich selbst. Kein
       Prüforakel: ein Cookie lässt sich ohne WUNSCH_SALZ nicht unterschreiben,
       und ohne WUNSCH_SALZ gibt freigabe() nie etwas frei. Darum braucht GET
       keine Bremse — es lässt sich damit nichts erraten. */
    if (req.method === "GET") {
      return antworte(res, 200, { eingerichtet, frei: freigabe(req, h) });
    }

    /* ---------------- Geheimwort prüfen ---------------- */
    if (req.method === "POST") {
      if (!vonDerEigenenSeite(req)) {
        return antworte(res, 403, { fehler: "So nicht." });
      }
      /* Ohne Wort vor der Bremse: niemand soll für einen Versuch gebremst
         werden, der ohnehin nichts bewirken kann (wie bei den Likes). */
      if (!eingerichtet) {
        return antworte(res, 503, { eingerichtet, frei: [], fehler: NICHT_EINGERICHTET });
      }
      /* Ohne Speicher keine Bremse — und ohne Bremse kein Prüfen. Lieber
         gesperrt als unbegrenzt durchprobierbar. */
      if (!lagerDa) {
        return antworte(res, 503, { eingerichtet, frei: [],
          fehler: "Gerade kann das Geheimwort nicht geprüft werden. Später noch einmal." });
      }
      await vorbereiten();

      /* Jeder Versuch zählt, auch der richtige — sonst ließe sich mit einem
         bekannten Wort zwischendurch die Bremse zurücksetzen. Gesalzener
         Abdruck wie im Wunsch-Trailer, nicht kurz(). */
      const wer = bremsAbdruck(req, ZWECK_BREMSE);
      if (!(await bremse(`snoopy:${wer}`, VERSUCHE, SPERRE_SEK))) {
        return antworte(res, 429, { eingerichtet, frei: [],
          fehler: "Zu viele Versuche. In fünf Minuten wieder." });
      }
      /* Solange das Admin-Passwort gilt, ist das hier eine Admin-Prüfung und
         zählt auf die gemeinsame Bremse aller Wege (siehe _lager.js). */
      if (h.quelle === "admin" && !(await adminBremse(req))) {
        return antworte(res, 429, { eingerichtet, frei: [],
          fehler: "Zu viele Versuche. In fünf Minuten wieder." });
      }

      const roh = koerper(req);
      if (!roh) return antworte(res, 400, { fehler: "Die Anfrage war nicht lesbar." });
      const eingabe = vergleichsform(String(roh.geheimwort ?? "").slice(0, WORT_MAX), h.nachsichtig);
      if (!eingabe || !gleich(eingabe, h.wort)) {
        return antworte(res, 401, { eingerichtet, frei: [],
          fehler: "Das ist nicht das Geheimwort." });
      }

      const bis = Math.floor(Date.now() / 1000) + GILT_SEK;
      /* Path=/api/snoopy: das Cookie geht nur an diese Route mit, nicht an
         jede Bild- und Seitenanfrage. SameSite=Strict: keine fremde Seite
         schickt es mit. Secure: nur über HTTPS (localhost zählt für Chrome
         ebenfalls als sicher). */
      res.setHeader("Set-Cookie",
        `${KEKS_NAME}=${unterschrift(h, bis, AKTIONEN)}; Max-Age=${GILT_SEK}; ` +
        `Path=/api/snoopy; HttpOnly; Secure; SameSite=Strict`);
      return antworte(res, 200, { eingerichtet, frei: AKTIONEN });
    }

    res.setHeader("Allow", "GET, POST");
    return antworte(res, 405, { fehler: "So nicht." });
  } catch (e) {
    return antworte(res, 500, { fehler: "Snoopy ist gerade nicht erreichbar." });
  }
}
