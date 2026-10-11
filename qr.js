// QR code ساز کوچیک (حالت بایت، تصحیح خطای M، نسخه ۱ تا ۱۰). بر اساس الگوریتم Project Nayuki (MIT).
const ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLK = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

const raw = (v) => { let r = (16 * v + 128) * v + 64; if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; } return r; };
const dataCw = (v) => Math.floor(raw(v) / 8) - ECC[v] * BLK[v];
const mul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z; };
function rsDiv(d) {
  const r = new Array(d).fill(0); r[d - 1] = 1; let root = 1;
  for (let i = 0; i < d; i++) { for (let j = 0; j < d; j++) { r[j] = mul(r[j], root); if (j + 1 < d) r[j] ^= r[j + 1]; } root = mul(root, 2); }
  return r;
}
function rsRem(data, div) {
  const r = div.map(() => 0);
  for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => (r[i] ^= mul(c, f))); }
  return r;
}
const bit = (x, i) => ((x >>> i) & 1) !== 0;

export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let v = 1;
  for (; v <= 10; v++) if (4 + (v < 10 ? 8 : 16) + 8 * bytes.length <= dataCw(v) * 8) break;
  if (v > 10) throw new Error("متن برای QR زیادی بلنده");
  const bb = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, v < 10 ? 8 : 16); bytes.forEach((b) => put(b, 8));
  const cap = dataCw(v) * 8;
  put(0, Math.min(4, cap - bb.length)); put(0, (8 - (bb.length % 8)) % 8);
  for (let p = 0xec; bb.length < cap; p ^= 0xec ^ 0x11) put(p, 8);
  const data = []; for (let i = 0; i < bb.length; i += 8) data.push(parseInt(bb.slice(i, i + 8).join(""), 2));

  // بلاک‌ها و درهم‌سازی
  const nb = BLK[v], be = ECC[v], rawCw = Math.floor(raw(v) / 8), nShort = nb - (rawCw % nb), shortLen = Math.floor(rawCw / nb);
  const div = rsDiv(be), blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = data.slice(k, k + shortLen - be + (i < nShort ? 0 : 1)); k += dat.length;
    const ecc = rsRem(dat, div); if (i < nShort) dat.push(0); blocks.push(dat.concat(ecc));
  }
  const cw = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - be || j >= nShort) cw.push(b[i]); });

  const size = v * 4 + 17;
  const M = Array.from({ length: size }, () => new Array(size).fill(false));
  const F = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, d) => { M[y][x] = d; F[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= size || y >= size) continue; const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d !== 2 && d !== 4); } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  if (v > 1) {
    const n = Math.floor(v / 7) + 2, step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2, pos = [6];
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    pos.forEach((a, i) => pos.forEach((b, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(a + dx, b + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
  }
  const format = (mask) => {
    const d = mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const bits = ((d << 10) | r) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i));
    set(8, 7, bit(bits, 6)); set(8, 8, bit(bits, 7)); set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
    set(8, size - 8, true);
  };
  format(0);
  if (v >= 7) {
    let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const bits = (v << 12) | r;
    for (let i = 0; i < 18; i++) { const b = bit(bits, i), a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, b); set(c, a, b); }
  }
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!F[y][x] && i < cw.length * 8) { M[y][x] = bit(cw[i >>> 3], 7 - (i & 7)); i++; }
    }
  }
  const maskFn = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  const applyMask = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!F[y][x] && maskFn[m](x, y)) M[y][x] = !M[y][x]; };
  const penalty = () => {
    let p = 0, dark = 0;
    for (let y = 0; y < size; y++) for (let k = 0; k < 2; k++) {
      let run = 1;
      for (let x = 1; x <= size; x++) {
        const a = x < size ? (k ? M[x][y] : M[y][x]) : null, b = k ? M[x - 1][y] : M[y][x - 1];
        if (a === b) run++; else { if (run >= 5) p += run - 2; run = 1; }
      }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = M[y][x]; if (c === M[y][x + 1] && c === M[y + 1][x] && c === M[y + 1][x + 1]) p += 3; }
    // الگوهای شبیه finder (۱:۱:۳:۱:۱ با حاشیه‌ی روشن)
    const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const at = (x, y, k) => (x < 0 || x >= size ? 0 : k ? +M[x][y] : +M[y][x]);
    for (let y = 0; y < size; y++) for (let k = 0; k < 2; k++) for (let x = -4; x < size; x++) {
      let a = true, b = true;
      for (let t = 0; t < 11 && (a || b); t++) { const c = at(x + t, y, k); if (c !== A[t]) a = false; if (c !== B[t]) b = false; }
      if (a) p += 40; if (b) p += 40;
    }
    M.forEach((r) => r.forEach((c) => c && dark++));
    const t = size * size; p += (Math.ceil(Math.abs(dark * 20 - t * 10) / t) - 1) * 10;
    return p;
  };
  let best = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) { applyMask(m); format(m); const p = penalty(); if (p < bestP) { bestP = p; best = m; } applyMask(m); }
  applyMask(best); format(best);
  return M;
}

export function qrSvg(text, { border = 2, dark = "#0e1540" } = {}) {
  const M = qrMatrix(text), n = M.length + border * 2;
  let d = "";
  M.forEach((row, y) => row.forEach((c, x) => { if (c) d += `M${x + border},${y + border}h1v1h-1z`; }));
  return `<svg viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="${dark}"/></svg>`;
}
