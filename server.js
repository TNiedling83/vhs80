// Live-Abstimmung für den Vortrag „80 Jahre VHS Lingen – Einstieg in die KI-Transformation“.
// Ohne Abhängigkeiten: Node-HTTP-Server, Zustand im Speicher (+ Sicherung in DATA_FILE).
//   GET  /                 Handy-Seite (zeigt die gerade offene Frage)
//   GET  /api/current      aktuelle Frage (öffentlich)
//   POST /api/vote         {voter, qid, option | text}
//   GET  /api/results?qid= Ergebnisse (öffentlich, für die Präsentation)
//   POST /api/open         {key, question:{qid,type,title,options[]}}  (Präsentation)
//   POST /api/close        {key}
//   POST /api/reset        {key, qid?}
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = +process.env.PORT || 3000;
// Ohne ADMIN_KEY kann niemand Fragen öffnen (Schlüssel nie ins Repo schreiben)
const KEY = process.env.ADMIN_KEY || require("crypto").randomBytes(24).toString("hex");
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "state.json");
const PUB = path.join(__dirname, "public");

let state = { current: null, questions: {}, votes: {} };
try { state = Object.assign(state, JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))); } catch (e) { /* frischer Start */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(state));
    } catch (e) { console.error("Speichern fehlgeschlagen:", e.message); }
  }, 500);
}

function send(res, code, body, type) {
  res.writeHead(code, {
    "Content-Type": type || "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch (e) { resolve({}); } });
  });
}

function clean(s, max) {
  return String(s || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function results(qid) {
  const q = state.questions[qid];
  const v = state.votes[qid] || {};
  const voters = Object.keys(v);
  if (!q) return { qid, total: 0, counts: [], words: [] };
  if (q.type === "text") {
    const words = {};
    voters.forEach((id) => {
      const w = v[id];
      const k = w.toLowerCase();
      if (!words[k]) words[k] = { text: w, n: 0 };
      words[k].n++;
    });
    return { qid, type: q.type, total: voters.length, words: Object.values(words).sort((a, b) => b.n - a.n).slice(0, 60) };
  }
  const counts = q.options.map(() => 0);
  voters.forEach((id) => { if (counts[v[id]] !== undefined) counts[v[id]]++; });
  return { qid, type: q.type, total: voters.length, counts };
}

const MIME = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".css": "text/css", ".js": "text/javascript", ".ico": "image/x-icon" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (req.method === "OPTIONS") return send(res, 204, "");

  if (p === "/api/health" || p === "/health") return send(res, 200, { ok: true });

  if (p === "/api/current" && req.method === "GET") {
    const q = state.current && state.questions[state.current];
    return send(res, 200, q ? { open: true, question: q } : { open: false });
  }

  if (p === "/api/results" && req.method === "GET") {
    return send(res, 200, results(url.searchParams.get("qid") || state.current));
  }

  if (p === "/api/vote" && req.method === "POST") {
    const b = await readBody(req);
    const voter = clean(b.voter, 64);
    const q = state.questions[b.qid];
    if (!voter || !q || state.current !== b.qid) return send(res, 409, { ok: false, reason: "closed" });
    state.votes[b.qid] = state.votes[b.qid] || {};
    if (q.type === "text") {
      const t = clean(b.text, q.max || 32);
      if (!t) return send(res, 400, { ok: false });
      state.votes[b.qid][voter] = t;
    } else {
      const o = +b.option;
      if (!(o >= 0 && o < q.options.length)) return send(res, 400, { ok: false });
      state.votes[b.qid][voter] = o;
    }
    save();
    return send(res, 200, { ok: true });
  }

  if ((p === "/api/open" || p === "/api/close" || p === "/api/reset") && req.method === "POST") {
    const b = await readBody(req);
    if (b.key !== KEY) return send(res, 403, { ok: false });
    if (p === "/api/open") {
      const q = b.question || {};
      const qid = clean(q.qid, 40);
      if (!qid) return send(res, 400, { ok: false });
      state.questions[qid] = {
        qid,
        type: q.type === "text" ? "text" : "choice",
        title: clean(q.title, 160),
        hint: clean(q.hint, 160),
        options: (q.options || []).slice(0, 8).map((o) => clean(o, 60)),
        max: Math.min(Math.max(+q.max || 32, 10), 160),
      };
      state.current = qid;
    } else if (p === "/api/close") {
      state.current = null;
    } else {
      if (b.qid) delete state.votes[b.qid]; else state.votes = {};
    }
    save();
    return send(res, 200, { ok: true, current: state.current });
  }

  // Statische Dateien (Handy-Seite)
  let rel = p === "/" ? "index.html" : path.normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, "");
  if (!path.extname(rel)) rel = rel.replace(/\/$/, "") + ".html"; // /spickzettel → spickzettel.html
  const file = path.join(PUB, rel);
  if (!file.startsWith(PUB)) return send(res, 403, "");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Nicht gefunden", "text/plain; charset=utf-8");
    send(res, 200, data, MIME[path.extname(file)] || "application/octet-stream");
  });
});

server.listen(PORT, () => console.log("VHS-Umfrage läuft auf Port " + PORT));
