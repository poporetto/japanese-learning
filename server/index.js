import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import webpush from 'web-push';

const port = Number(process.env.PORT || 8787);
const origin = process.env.APP_ORIGIN || '*';
const dataFile = process.env.PUSH_DATA_FILE || new URL('./push-data.json', import.meta.url).pathname;
const required = ['VAPID_SUBJECT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'CRON_SECRET'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}`);
webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

const templates = [
  { body: 'おはよう。今日も無理しすぎないでね。', band: 'morning' },
  { body: 'お昼、ちゃんと食べた？ 私は今からランチ。', band: 'day' },
  { body: '仕事が終わったよ。少しだけ話せたら嬉しいな。', band: 'evening' },
  { body: '今日のこと、あなたにも聞いてほしくなった。', band: 'evening' },
  { body: '週末だね。今日はどんな一日にしたい？', weekend: true },
];
const headers = { 'content-type': 'application/json', 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' };
const reply = (res, status, value) => { res.writeHead(status, headers); res.end(JSON.stringify(value)); };
async function body(req) { let raw = ''; for await (const chunk of req) raw += chunk; return raw ? JSON.parse(raw) : {}; }
async function load() { try { return JSON.parse(await readFile(dataFile, 'utf8')); } catch { return []; } }
async function save(rows) { await writeFile(dataFile, JSON.stringify(rows, null, 2)); }
const localParts = (timezone) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', weekday: 'short', hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts().map((p) => [p.type, p.value]));

async function dispatch() {
  const rows = await load(); const now = Date.now();
  for (const row of rows) {
    const p = localParts(row.timezone); const hour = Number(p.hour); const date = `${p.year}-${p.month}-${p.day}`;
    if (row.date !== date) { row.date = date; row.sentToday = 0; }
    const quiet = row.quietHours && (hour >= row.quietStart || hour < row.quietEnd);
    if (quiet || row.sentToday >= row.dailyMax || now < (row.nextAt || 0)) continue;
    const weekend = ['Sat', 'Sun'].includes(p.weekday); const band = hour < 11 ? 'morning' : hour < 17 ? 'day' : 'evening';
    const pool = templates.filter((t) => (!t.weekend || weekend) && (!t.band || t.band === band));
    const selected = pool[Math.floor(Math.random() * pool.length)] || templates[0];
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify({ title: '結衣 Yui', body: selected.body, url: './' }));
      row.sentToday++; row.nextAt = now + (3 + Math.random() * 3) * 3600000;
    } catch (error) { if ([404, 410].includes(error.statusCode)) row.expired = true; else row.lastError = error.message; }
  }
  await save(rows.filter((row) => !row.expired));
  return rows.filter((row) => !row.expired).length;
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return reply(res, 204, {});
  try {
    if (req.url === '/api/push/public-key' && req.method === 'GET') return reply(res, 200, { publicKey: process.env.VAPID_PUBLIC_KEY });
    if (req.url === '/api/push/subscribe' && req.method === 'POST') {
      const input = await body(req); if (!input.subscription?.endpoint) return reply(res, 400, { error: 'subscription required' });
      const rows = (await load()).filter((r) => r.subscription.endpoint !== input.subscription.endpoint);
      rows.push({ subscription: input.subscription, timezone: input.timezone || 'UTC', quietHours: input.quietHours !== false, quietStart: Number(input.quietStart ?? 23), quietEnd: Number(input.quietEnd ?? 7), dailyMax: Math.min(6, Math.max(1, Number(input.dailyMax || 4))), sentToday: 0, nextAt: Date.now() + 3600000 });
      await save(rows); return reply(res, 201, { ok: true });
    }
    if (req.url === '/api/push/unsubscribe' && req.method === 'DELETE') {
      const input = await body(req); await save((await load()).filter((r) => r.subscription.endpoint !== input.endpoint)); return reply(res, 200, { ok: true });
    }
    if (req.url === '/api/push/dispatch' && req.method === 'POST') {
      if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return reply(res, 401, { error: 'unauthorized' });
      return reply(res, 200, { ok: true, subscriptions: await dispatch() });
    }
    reply(res, 404, { error: 'not found' });
  } catch (error) { reply(res, 500, { error: error.message }); }
}).listen(port, () => console.log(`kaiwassap push listening on ${port}`));
