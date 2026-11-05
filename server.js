'use strict';
/*
 * রসুই ঘর: QR অর্ডার সিস্টেম
 * কোনো বাইরের প্যাকেজ লাগে না। শুধু Node.js 18 বা তার নতুন ভার্সন।
 *
 *   ADMIN_PASSWORD=আপনার-পাসওয়ার্ড node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { qrSvg } = require('./lib/qr');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const PASS_FILE = path.join(DATA_DIR, 'admin-password.txt');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SESSION_MS = 12 * 60 * 60 * 1000;
const STATUSES = ['new', 'preparing', 'ready', 'served', 'cancelled'];

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* অ্যাডমিন পাসওয়ার্ড: ADMIN_PASSWORD সেট থাকলে সেটাই। না থাকলে প্রথমবার চালুর সময় একটি এলোমেলো পাসওয়ার্ড তৈরি হয়। */
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
let passwordNote = '';
if (!ADMIN_PASSWORD) {
  try { ADMIN_PASSWORD = fs.readFileSync(PASS_FILE, 'utf8').trim(); } catch (_) { /* নতুন তৈরি হবে */ }
  if (ADMIN_PASSWORD) {
    passwordNote = `অ্যাডমিন পাসওয়ার্ড দেখুন এই ফাইলে: ${PASS_FILE}`;
  } else {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    ADMIN_PASSWORD = Array.from({ length: 10 }, () => chars[crypto.randomInt(chars.length)]).join('');
    fs.writeFileSync(PASS_FILE, ADMIN_PASSWORD + '\n', { mode: 0o600 });
    passwordNote = `অ্যাডমিন পাসওয়ার্ড (প্রথমবার তৈরি হলো): ${ADMIN_PASSWORD}\n   এটি ${PASS_FILE} ফাইলেও রাখা আছে।`;
  }
}

/* ---------------- ডাটাবেস (একটি JSON ফাইল) ---------------- */

const uid = (n = 6) => crypto.randomBytes(n).toString('hex');

function seedDb() {
  const cats = [
    ['c_rice', 'ভাত ও পোলাও'], ['c_curry', 'ভুনা ও কারি'],
    ['c_fast', 'ফাস্ট ফুড'], ['c_drink', 'পানীয় ও মিষ্টি'],
  ].map(([id, name], i) => ({ id, name, order: i }));
  const it = (id, categoryId, name, desc, price) => ({ id, categoryId, name, desc, price, image: '', available: true });
  return {
    settings: {
      name: 'রসুই ঘর', tagline: 'পছন্দের খাবার বেছে নিন, সরাসরি আপনার টেবিলে পৌঁছে যাবে।',
      tableCount: 12, acceptingOrders: true, baseUrl: '',
    },
    categories: cats,
    items: [
      it('i1', 'c_rice', 'কাচ্চি বিরিয়ানি', 'খাসির মাংস, আলু, জর্দা ও বোরহানি', 320),
      it('i2', 'c_rice', 'মোরগ পোলাও ও রোস্ট', 'সুগন্ধি চালের পোলাও, আস্ত রোস্ট', 280),
      it('i3', 'c_rice', 'তেহারি', 'গরুর মাংস দিয়ে ঝরঝরে তেহারি', 220),
      it('i4', 'c_rice', 'খিচুড়ি ও ইলিশ ভাজা', 'ভুনা খিচুড়ি, এক টুকরা ইলিশ, ডিম', 380),
      it('i5', 'c_curry', 'গরুর ভুনা', 'ধীরে কষানো, ৪ পিস মাংস', 260),
      it('i6', 'c_curry', 'দেশি মুরগির ভুনা', 'ঘরোয়া মসলায়, ২ পিস', 210),
      it('i7', 'c_curry', 'মসুর ডাল', 'রসুনের ফোড়নে', 60),
      it('i8', 'c_curry', 'শুঁটকি ভর্তা', 'ঝাল ও ঝাঁঝালো', 90),
      it('i9', 'c_fast', 'চিকেন বার্গার', 'মুচমুচে চিকেন, সালাদ, সস', 220),
      it('i10', 'c_fast', 'ফ্রেঞ্চ ফ্রাই', 'বড় প্যাকেট', 120),
      it('i11', 'c_fast', 'চিকেন ফ্রাই (৩ পিস)', 'মশলা মাখানো, মুচমুচে', 200),
      it('i12', 'c_drink', 'বোরহানি', 'গ্লাস', 60),
      it('i13', 'c_drink', 'মিষ্টি লাচ্ছি', 'ঘন দইয়ের', 90),
      it('i14', 'c_drink', 'দুধ চা', 'কাপ', 30),
      it('i15', 'c_drink', 'ফিরনি', 'মাটির বাটি', 80),
    ],
    orders: [],
    seq: 100,
  };
}

let db;
function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      const bad = DB_FILE + '.broken-' + Date.now();
      try { fs.renameSync(DB_FILE, bad); console.error('db.json নষ্ট ছিল, কপি রাখা হলো:', bad); } catch (_) { /* ignore */ }
    }
    db = seedDb();
    saveDb();
  }
}
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

let SECRET;
try { SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (_) {
  SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 });
}
loadDb();

/* ---------------- ছোট সহায়ক ফাংশন ---------------- */

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };

const BN = '০১২৩৪৫৬৭৮৯';
const toLatinDigits = (s) => String(s).replace(/[০-৯]/g, (d) => BN.indexOf(d));
const cleanStr = (v, max, required = false) => {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim() : '';
  if (required && !s) bad('প্রয়োজনীয় তথ্য ফাঁকা আছে');
  if (s.length > max) bad('লেখা অনেক বড়');
  return s;
};
const cleanPrice = (v) => {
  const n = Math.round(Number(toLatinDigits(v)));
  if (!Number.isFinite(n) || n < 0 || n > 1000000) bad('দাম সঠিক নয়');
  return n;
};

function clientIp(req) {
  if (TRUST_PROXY) {
    const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (f) return f;
  }
  return req.socket.remoteAddress || '';
}

const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) || [];
  const recent = b.filter((t) => now - t < windowMs);
  if (recent.length >= max) { buckets.set(key, recent); return false; }
  recent.push(now);
  buckets.set(key, recent);
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.some((t) => now - t < 3600000)) buckets.delete(k); }, 600000).unref();

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return; // বাকি অংশ ফেলে দিয়ে পরিষ্কার উত্তর পাঠানো হবে
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; reject(new HttpError(413, 'ফাইল বা তথ্য অনেক বড়')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, 100 * 1024);
  if (!buf.length) return {};
  try { const v = JSON.parse(buf.toString('utf8')); return v && typeof v === 'object' ? v : bad('ভুল তথ্য'); } catch (_) { return bad('ভুল তথ্য'); }
}

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/* ---------------- অ্যাডমিন লগইন (সাইন করা কুকি) ---------------- */

const sign = (v) => crypto.createHmac('sha256', SECRET + ':' + ADMIN_PASSWORD).update(v).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function makeSession() { const exp = String(Date.now() + SESSION_MS); return exp + '.' + sign(exp); }
function isAdmin(req) {
  const m = /(?:^|;\s*)rg_admin=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  return !!exp && !!sig && Number(exp) > Date.now() && safeEq(sig, sign(exp));
}
const isHttps = (req) => !!req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
const cookie = (req, value, maxAge) =>
  `rg_admin=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

/* ---------------- লাইভ আপডেট (SSE) ---------------- */

const streams = new Set();
function broadcast(kind) {
  for (const res of streams) res.write(`event: change\ndata: ${kind}\n\n`);
}
setInterval(() => { for (const res of streams) res.write(': ping\n\n'); }, 25000).unref();

/* ---------------- মেনু ও অর্ডারের যুক্তি ---------------- */

const publicSettings = () => ({
  name: db.settings.name, tagline: db.settings.tagline, acceptingOrders: !!db.settings.acceptingOrders,
});
const sortedCats = () => db.categories.slice().sort((a, b) => a.order - b.order);
const findItem = (id) => db.items.find((i) => i.id === id);

function createOrder(body, ip) {
  if (!db.settings.acceptingOrders) bad('এই মুহূর্তে অর্ডার নেওয়া বন্ধ আছে', 409);
  if (!rateLimit('order:' + ip, 60, 10 * 60 * 1000)) bad('অল্প সময়ে অনেক অর্ডার হয়েছে, একটু পরে চেষ্টা করুন', 429);
  const table = toLatinDigits(cleanStr(body.table, 10, true));
  if (!/^[0-9A-Za-zঀ-৿ -]{1,10}$/.test(table)) bad('টেবিল নম্বর সঠিক নয়');
  const note = cleanStr(body.note, 200);
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 40) bad('কার্ট ফাঁকা');
  const lines = [];
  const seen = new Set();
  let total = 0;
  for (const raw of body.items) {
    const item = findItem(raw && raw.id);
    const qty = Number(raw && raw.qty);
    if (!item || seen.has(item.id)) bad('একটি খাবার পাওয়া যায়নি, মেনু রিফ্রেশ করুন');
    if (!item.available) bad(`"${item.name}" এখন নেই`, 409);
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) bad('পরিমাণ সঠিক নয়');
    seen.add(item.id);
    lines.push({ itemId: item.id, name: item.name, price: item.price, qty });
    total += item.price * qty;
  }
  const order = {
    id: uid(8), code: ++db.seq, table, note, items: lines, total,
    status: 'new', createdAt: Date.now(), updatedAt: Date.now(),
  };
  db.orders.push(order);
  if (db.orders.length > 3000) {
    const keep = db.orders.filter((o) => o.status === 'new' || o.status === 'preparing' || o.status === 'ready');
    const rest = db.orders.filter((o) => !keep.includes(o)).slice(-2000);
    db.orders = [...rest, ...keep].sort((a, b) => a.createdAt - b.createdAt);
  }
  saveDb();
  broadcast('orders');
  return order;
}

/* ---------------- ছবি আপলোড ---------------- */

function imageKind(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}
function removeUnusedUpload(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  if (db.items.some((i) => i.image === url)) return;
  const file = path.join(UPLOAD_DIR, path.basename(url));
  fs.unlink(file, () => {});
}

/* চালু হওয়ার সময় কোনো খাবারে ব্যবহার হচ্ছে না এমন পুরোনো (১ ঘণ্টার বেশি) ছবি মুছে ফেলা */
function pruneUploads() {
  const used = new Set(db.items.map((i) => path.basename(i.image || '')));
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const full = path.join(UPLOAD_DIR, f);
    try { if (!used.has(f) && Date.now() - fs.statSync(full).mtimeMs > 3600 * 1000) fs.unlinkSync(full); } catch (_) { /* ignore */ }
  }
}
pruneUploads();

/* ---------------- API ---------------- */

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/menu' && m === 'GET') {
    return send(res, 200, { settings: publicSettings(), categories: sortedCats(), items: db.items });
  }
  if (p === '/api/orders' && m === 'POST') {
    const o = createOrder(await readJson(req), clientIp(req));
    return send(res, 201, { id: o.id, code: o.code, total: o.total, status: o.status });
  }
  let mm = /^\/api\/orders\/([0-9a-f]{16})$/.exec(p);
  if (mm && m === 'GET') {
    const o = db.orders.find((x) => x.id === mm[1]);
    if (!o) bad('অর্ডার পাওয়া যায়নি', 404);
    return send(res, 200, { code: o.code, table: o.table, status: o.status, items: o.items, total: o.total, createdAt: o.createdAt });
  }
  if (p === '/api/qr' && m === 'GET') {
    const text = url.searchParams.get('text') || '';
    if (!text || text.length > 200) bad('লিংক ঠিক নয়');
    let svg;
    try { svg = qrSvg(text); } catch (_) { return bad('লিংক অনেক লম্বা'); }
    return send(res, 200, svg, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
  }

  /* ---- এখান থেকে নিচে শুধু অ্যাডমিন ---- */
  if (p === '/api/admin/login' && m === 'POST') {
    const ip = clientIp(req);
    if (!rateLimit('login:' + ip, 8, 10 * 60 * 1000)) bad('অনেকবার ভুল হয়েছে, ১০ মিনিট পরে চেষ্টা করুন', 429);
    const body = await readJson(req);
    if (typeof body.password !== 'string' || !safeEq(body.password, ADMIN_PASSWORD)) bad('পাসওয়ার্ড ঠিক নয়', 401);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, makeSession(), SESSION_MS / 1000) });
  }
  if (p === '/api/admin/logout' && m === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
  }
  if (!p.startsWith('/api/admin/')) bad('পাওয়া যায়নি', 404);
  if (!isAdmin(req)) bad('আগে লগইন করুন', 401);
  if (m !== 'GET' && !req.headers['x-rg']) bad('অনুরোধ গ্রহণযোগ্য নয়', 403);

  if (p === '/api/admin/me') return send(res, 200, { ok: true });

  if (p === '/api/admin/stream' && m === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return undefined;
  }

  if (p === '/api/admin/orders' && m === 'GET') {
    const since = Date.now() - 48 * 3600 * 1000;
    const list = db.orders.filter((o) => o.createdAt >= since || ['new', 'preparing', 'ready'].includes(o.status));
    return send(res, 200, { orders: list.sort((a, b) => b.createdAt - a.createdAt) });
  }
  mm = /^\/api\/admin\/orders\/([0-9a-f]{16})$/.exec(p);
  if (mm) {
    const o = db.orders.find((x) => x.id === mm[1]);
    if (!o) bad('অর্ডার পাওয়া যায়নি', 404);
    if (m === 'PATCH') {
      const b = await readJson(req);
      if (!STATUSES.includes(b.status)) bad('অবস্থা ঠিক নয়');
      o.status = b.status; o.updatedAt = Date.now();
      saveDb(); broadcast('orders');
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      db.orders = db.orders.filter((x) => x !== o);
      saveDb(); broadcast('orders');
      return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/admin/settings') {
    if (m === 'GET') return send(res, 200, db.settings);
    if (m === 'PUT') {
      const b = await readJson(req);
      const tc = Math.round(Number(toLatinDigits(b.tableCount)));
      if (!Number.isFinite(tc) || tc < 0 || tc > 200) bad('টেবিলের সংখ্যা ০ থেকে ২০০ এর মধ্যে দিন');
      let baseUrl = cleanStr(b.baseUrl, 150).replace(/\/+$/, '');
      if (baseUrl && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(baseUrl)) bad('সাইটের ঠিকানা http:// বা https:// দিয়ে শুরু করুন');
      db.settings = {
        name: cleanStr(b.name, 60, true), tagline: cleanStr(b.tagline, 140),
        tableCount: tc, acceptingOrders: !!b.acceptingOrders, baseUrl,
      };
      saveDb(); broadcast('menu');
      return send(res, 200, db.settings);
    }
  }

  if (p === '/api/admin/categories' && m === 'POST') {
    const b = await readJson(req);
    const c = { id: 'c_' + uid(4), name: cleanStr(b.name, 40, true), order: db.categories.length ? Math.max(...db.categories.map((x) => x.order)) + 1 : 0 };
    db.categories.push(c);
    saveDb(); broadcast('menu');
    return send(res, 201, c);
  }
  if (p === '/api/admin/categories/order' && m === 'PUT') {
    const b = await readJson(req);
    if (!Array.isArray(b.ids) || b.ids.length !== db.categories.length || !b.ids.every((id) => db.categories.some((c) => c.id === id))) bad('ক্রম ঠিক নয়');
    b.ids.forEach((id, i) => { db.categories.find((c) => c.id === id).order = i; });
    saveDb(); broadcast('menu');
    return send(res, 200, { ok: true });
  }
  mm = /^\/api\/admin\/categories\/([\w-]+)$/.exec(p);
  if (mm) {
    const c = db.categories.find((x) => x.id === mm[1]);
    if (!c) bad('ক্যাটাগরি পাওয়া যায়নি', 404);
    if (m === 'PATCH') {
      const b = await readJson(req);
      c.name = cleanStr(b.name, 40, true);
      saveDb(); broadcast('menu');
      return send(res, 200, c);
    }
    if (m === 'DELETE') {
      if (db.items.some((i) => i.categoryId === c.id)) bad('এই ক্যাটাগরিতে খাবার আছে। আগে খাবারগুলো সরান বা অন্য ক্যাটাগরিতে নিন।', 409);
      db.categories = db.categories.filter((x) => x !== c);
      saveDb(); broadcast('menu');
      return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/admin/items' && m === 'POST') {
    const b = await readJson(req);
    if (!db.categories.some((c) => c.id === b.categoryId)) bad('ক্যাটাগরি বেছে নিন');
    if (db.items.length >= 500) bad('আইটেমের সীমা শেষ');
    const item = {
      id: 'i_' + uid(4), categoryId: b.categoryId, name: cleanStr(b.name, 80, true),
      desc: cleanStr(b.desc, 160), price: cleanPrice(b.price),
      image: validImage(b.image), available: b.available !== false,
    };
    db.items.push(item);
    saveDb(); broadcast('menu');
    return send(res, 201, item);
  }
  mm = /^\/api\/admin\/items\/([\w-]+)$/.exec(p);
  if (mm) {
    const item = findItem(mm[1]);
    if (!item) bad('খাবার পাওয়া যায়নি', 404);
    if (m === 'PATCH') {
      const b = await readJson(req);
      const old = item.image;
      if ('categoryId' in b) { if (!db.categories.some((c) => c.id === b.categoryId)) bad('ক্যাটাগরি ঠিক নয়'); item.categoryId = b.categoryId; }
      if ('name' in b) item.name = cleanStr(b.name, 80, true);
      if ('desc' in b) item.desc = cleanStr(b.desc, 160);
      if ('price' in b) item.price = cleanPrice(b.price);
      if ('available' in b) item.available = !!b.available;
      if ('image' in b) item.image = validImage(b.image);
      saveDb(); broadcast('menu');
      if (old !== item.image) removeUnusedUpload(old);
      return send(res, 200, item);
    }
    if (m === 'DELETE') {
      db.items = db.items.filter((x) => x !== item);
      saveDb(); broadcast('menu');
      removeUnusedUpload(item.image);
      return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/admin/upload' && m === 'POST') {
    const buf = await readBody(req, 3 * 1024 * 1024);
    const kind = imageKind(buf);
    if (!kind) bad('শুধু JPG, PNG বা WEBP ছবি দিন');
    const name = uid(10) + '.' + kind;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    return send(res, 201, { url: '/uploads/' + name });
  }

  return bad('পাওয়া যায়নি', 404);
}

function validImage(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || !/^\/uploads\/[0-9a-f]{20}\.(jpg|png|webp)$/.test(v)) bad('ছবি ঠিক নয়');
  if (!fs.existsSync(path.join(UPLOAD_DIR, path.basename(v)))) bad('ছবি পাওয়া যায়নি');
  return v;
}

/* ---------------- স্ট্যাটিক ফাইল ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function serveFile(req, res, root, rel, cacheControl) {
  const file = path.resolve(root, '.' + path.sep + rel);
  if (file !== root && !file.startsWith(root + path.sep)) return send(res, 404, 'পাওয়া যায়নি');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'পাওয়া যায়নি');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': cacheControl });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
    return undefined;
  });
}

/* ---------------- সার্ভার ---------------- */

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  try {
    const url = new URL(req.url, 'http://x');
    let p;
    try { p = decodeURIComponent(url.pathname); } catch (_) { return send(res, 400, 'ভুল ঠিকানা'); }
    if (p.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'অনুমোদিত নয়');
    if (p === '/') return serveFile(req, res, PUBLIC_DIR, 'index.html', 'no-cache');
    if (p === '/admin' || p === '/admin/') return serveFile(req, res, PUBLIC_DIR, 'admin.html', 'no-cache');
    if (p.startsWith('/uploads/')) return serveFile(req, res, UPLOAD_DIR, p.slice(9), 'public, max-age=31536000, immutable');
    return serveFile(req, res, PUBLIC_DIR, p.slice(1), 'no-cache');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: 'সার্ভারে সমস্যা হয়েছে' });
  }
});

server.listen(PORT, () => {
  console.log(`চালু হয়েছে: http://localhost:${PORT}`);
  console.log(`অ্যাডমিন:   http://localhost:${PORT}/admin`);
  if (passwordNote) console.log('\n🔑 ' + passwordNote + '\n');
});
