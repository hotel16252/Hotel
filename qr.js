'use strict';
/*
 * Minimal QR Code generator (byte mode, error correction level M, versions 1-10).
 * No dependencies. Handles UTF-8 text up to ~213 bytes, enough for any shop URL.
 */

const EC = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
  6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]],
  10: [26, [[4, 43], [1, 44]]],
};
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const EXP = new Array(512);
const LOG = new Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}
function rsRemainder(data, gen) {
  const n = gen.length - 1;
  const res = new Array(n).fill(0);
  for (const b of data) {
    const f = b ^ res.shift();
    res.push(0);
    for (let i = 0; i < n; i++) res[i] ^= mul(gen[i + 1], f);
  }
  return res;
}

function buildCodewords(bytes) {
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const dataCw = EC[v][1].reduce((s, [c, d]) => s + c * d, 0);
    const ccBits = v < 10 ? 8 : 16;
    if (4 + ccBits + bytes.length * 8 <= dataCw * 8) { version = v; break; }
  }
  if (!version) throw new Error('QR text too long');
  const [ecPer, groups] = EC[version];
  const dataCw = groups.reduce((s, [c, d]) => s + c * d, 0);

  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCw * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data.push(v);
  }
  for (let pad = 0xec; data.length < dataCw; pad ^= 0xec ^ 0x11) data.push(pad);

  const gen = rsGenerator(ecPer);
  const blocks = [];
  let pos = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const d = data.slice(pos, pos + size);
      pos += size;
      blocks.push({ d, e: rsRemainder(d, gen) });
    }
  }
  const out = [];
  const maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecPer; i++) for (const b of blocks) out.push(b.e[i]);
  return { version, codewords: out };
}

function makeMatrix(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const { version, codewords } = buildCodewords(bytes);
  const size = 17 + 4 * version;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };
  const bit = (v, i) => ((v >>> i) & 1) !== 0;

  function drawFormat(mask) {
    const data = (0 << 3) | mask; // level M = 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(bits, i));
    setFn(8, 7, bit(bits, 6)); setFn(8, 8, bit(bits, 7)); setFn(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(bits, i));
    setFn(8, size - 8, true);
  }

  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const ap = ALIGN[version];
  for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      setFn(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      setFn(a, b, bit(bits, i)); setFn(b, a, bit(bits, i));
    }
  }

  let k = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && k < total) {
          mod[y][x] = bit(codewords[k >>> 3], 7 - (k & 7));
          k++;
        }
      }
    }
  }

  const masks = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0,
    (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0,
  ];
  const applyMask = (m) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && masks[m](x, y)) mod[y][x] = !mod[y][x];
  };

  function penalty() {
    let p = 0;
    const line = (get) => {
      let run = 1, prev = get(0);
      for (let i = 1; i < size; i++) {
        const c = get(i);
        if (c === prev) run++; else { if (run >= 5) p += 3 + run - 5; run = 1; prev = c; }
      }
      if (run >= 5) p += 3 + run - 5;
    };
    for (let i = 0; i < size; i++) { line((j) => mod[i][j]); line((j) => mod[j][i]); }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = mod[y][x];
      if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3;
    }
    const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const rpat = pat.slice().reverse();
    const scan = (get) => {
      for (let i = 0; i + 11 <= size; i++) {
        let a = true, b = true;
        for (let j = 0; j < 11; j++) {
          const v = get(i + j) ? 1 : 0;
          if (v !== pat[j]) a = false;
          if (v !== rpat[j]) b = false;
        }
        if (a) p += 40;
        if (b) p += 40;
      }
    };
    for (let i = 0; i < size; i++) { scan((j) => mod[i][j]); scan((j) => mod[j][i]); }
    let dark = 0;
    for (const row of mod) for (const c of row) if (c) dark++;
    const kk = Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1;
    p += Math.max(0, kk) * 10;
    return p;
  }

  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const s = penalty();
    if (s < bestScore) { bestScore = s; best = m; }
    applyMask(m);
  }
  applyMask(best); drawFormat(best);
  return mod;
}

function qrSvg(text, { margin = 4, dark = '#000000', light = '#ffffff' } = {}) {
  const m = makeMatrix(text);
  const n = m.length + margin * 2;
  let d = '';
  for (let y = 0; y < m.length; y++) {
    let x = 0;
    while (x < m.length) {
      if (!m[y][x]) { x++; continue; }
      let len = 0;
      while (x + len < m.length && m[y][x + len]) len++;
      d += `M${x + margin} ${y + margin}h${len}v1h-${len}z`;
      x += len;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

module.exports = { qrSvg, makeMatrix };
