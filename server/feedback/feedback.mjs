// Feedback and error reports from the Ride Forge app, kept on this server.
// The app posts to https://<route server>/feedback/report (the tunnel sends
// /feedback/ here): a rider's message from Settings → Send feedback, or an
// error the app hit. Each goes on a line of ~/ride-forge-feedback/<YYYY-MM>.jsonl
// (no IP addresses kept); read them with server/feedback/show.sh. Messages
// (not errors) also send a phone notification when NTFY_TOPIC is set.
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";

const PORT = Number(process.env.FEEDBACK_PORT || 8996);
const DIR = process.env.FEEDBACK_DIR || `${homedir()}/ride-forge-feedback`;
const MAX_BYTES = 16_000;
/** Per sender per hour, and for everyone per day: enough for testing, not for spam. */
const PER_HOUR = { feedback: 10, error: 30 };
const PER_DAY = 1000;
mkdirSync(DIR, { recursive: true });

const recent = new Map(); // sender|kind → times (ms)
let today = { day: "", count: 0 };
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const text = (v, n) => (typeof v === "string" ? v.slice(0, n) : undefined);

function allowed(sender, kind) {
  const day = new Date().toISOString().slice(0, 10);
  if (today.day !== day) today = { day, count: 0 };
  if (today.count >= PER_DAY) return false;
  const key = `${sender}|${kind}`;
  const hourAgo = Date.now() - 3_600_000;
  const times = (recent.get(key) ?? []).filter((t) => t > hourAgo);
  if (times.length >= PER_HOUR[kind]) return false;
  times.push(Date.now());
  recent.set(key, times);
  today.count++;
  return true;
}

function notify(message) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  fetch(`https://ntfy.sh/${topic}`, { method: "POST", headers: { Title: "Ride Forge feedback" }, body: message.slice(0, 500) }).catch(() => undefined);
}

createServer((req, res) => {
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  if (req.method === "GET" && req.url === "/feedback/health") return res.writeHead(200, cors).end("ok");
  if (req.method !== "POST" || req.url !== "/feedback/report") return res.writeHead(404, cors).end();
  let body = "";
  let tooBig = false;
  req.on("data", (c) => {
    body += c;
    if (body.length > MAX_BYTES) tooBig = true;
  });
  req.on("end", () => {
    if (tooBig) return res.writeHead(413, cors).end();
    let r;
    try {
      r = JSON.parse(body);
    } catch {
      return res.writeHead(400, cors).end();
    }
    const kind = r.kind === "error" ? "error" : "feedback";
    const message = text(r.message, 4000)?.trim();
    if (!message) return res.writeHead(400, cors).end();
    // The sender is only used to limit how often, never kept.
    const sender = req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "?";
    if (!allowed(sender, kind)) return res.writeHead(429, cors).end();
    const entry = {
      at: new Date().toISOString(),
      kind,
      message,
      detail: text(r.detail, 8000),
      version: text(r.version, 40),
      platform: text(r.platform, 20),
      device: text(r.device, 300),
      screen: text(r.screen, 40),
      country: text(req.headers["cf-ipcountry"], 4),
    };
    appendFileSync(`${DIR}/${entry.at.slice(0, 7)}.jsonl`, JSON.stringify(entry) + "\n");
    if (kind === "feedback") notify(`${entry.version ?? "?"}: ${message}`);
    console.log(`${kind} from ${entry.platform ?? "?"} ${entry.version ?? "?"}: ${message.slice(0, 120)}`);
    res.writeHead(204, cors).end();
  });
}).listen(PORT, "127.0.0.1", () => console.log(`feedback on localhost:${PORT}, kept in ${DIR}`));
