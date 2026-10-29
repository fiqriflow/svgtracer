/**
 * Pelacak kontur + pencocok kurva Bezier sendiri (pengganti Potrace untuk lapisan warna).
 *
 * Alur: medan abu-abu halus (gelap = isi) -> kontur sub-piksel (marching squares) ->
 * deteksi sudut tajam -> pencocokan kubik Bezier per ruas (algoritma Schneider) ->
 * ruas yang praktis lurus dijadikan garis lurus. Hasilnya: bentuk rapi, simpul sedikit,
 * tanpa gerigi/gelombang, sudut tajam tetap tajam.
 */

export type FitOptions = {
  /** Buang bentuk/lubang berluas <= ini (px medan) */
  turd: number;
  /** Galat maksimum kurva terhadap kontur (px medan) */
  err: number;
  /** Sudut belok minimal (derajat) agar sebuah titik dianggap sudut tajam */
  corner: number;
  /** Jarak pengamatan sudut (px medan) */
  win: number;
  /** Jumlah lintasan penghalusan kontur ([1 2 1]/4, melingkar) sebelum dicocokkan */
  smooth?: number;
};

type P = { x: number; y: number };
type Bez = [P, P, P, P];

const THR = 128;
const PAD = 3;

const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: P, b: P): P => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: P, s: number): P => ({ x: a.x * s, y: a.y * s });
const dot = (a: P, b: P) => a.x * b.x + a.y * b.y;
const len = (a: P) => Math.hypot(a.x, a.y);
const unit = (a: P): P => {
  const l = len(a);
  return l < 1e-9 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};

// ---------------------------------------------------------------------------
// 1. Kontur (marching squares, interpolasi linear, hasil: lingkaran tertutup)
// ---------------------------------------------------------------------------

// Tiap kasus -> pasangan sisi [dari, ke]; sisi: 0=atas 1=kanan 2=bawah 3=kiri
const CASES: number[][][] = [
  [], [[3, 2]], [[2, 1]], [[3, 1]], [[0, 1]], [], [[0, 2]], [[0, 3]],
  [[0, 3]], [[0, 2]], [], [[0, 1]], [[3, 1]], [[2, 1]], [[3, 2]], [],
];

function contours(field: Uint8Array, w: number, h: number): P[][] {
  const PW = w + PAD * 2;
  const PH = h + PAD * 2;
  const g = new Uint8Array(PW * PH).fill(255);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const o = (y + PAD) * PW + PAD;
    for (let x = 0; x < w; x++) g[o + x] = field[row + x];
    for (let k = 1; k <= 2; k++) {
      g[o - k] = field[row];
      g[o + w - 1 + k] = field[row + w - 1];
    }
  }
  for (let k = 1; k <= 2; k++) {
    g.copyWithin((PAD - k) * PW + 1, PAD * PW + 1, PAD * PW + PW - 1);
    g.copyWithin((PAD + h - 1 + k) * PW + 1, (PAD + h - 1) * PW + 1, (PAD + h - 1) * PW + PW - 1);
  }

  const e0: number[] = [];
  const e1: number[] = [];
  const edgeKey = (side: number, x: number, y: number) => {
    // 0 atas: H(x,y) 1 kanan: V(x+1,y) 2 bawah: H(x,y+1) 3 kiri: V(x,y)
    if (side === 0) return (y * PW + x) * 2;
    if (side === 1) return (y * PW + x + 1) * 2 + 1;
    if (side === 2) return ((y + 1) * PW + x) * 2;
    return (y * PW + x) * 2 + 1;
  };
  for (let y = 0; y < PH - 1; y++) {
    for (let x = 0; x < PW - 1; x++) {
      const i = y * PW + x;
      const a = g[i] < THR ? 8 : 0;
      const b = g[i + 1] < THR ? 4 : 0;
      const c = g[i + PW + 1] < THR ? 2 : 0;
      const d = g[i + PW] < THR ? 1 : 0;
      const k = a | b | c | d;
      if (k === 0 || k === 15) continue;
      if (k === 5 || k === 10) {
        const centerIn = (g[i] + g[i + 1] + g[i + PW] + g[i + PW + 1]) / 4 < THR;
        // k=5 (b,d dalam): pusat dalam -> potong a & c ; k=10 (a,c dalam): pusat dalam -> potong b & d
        const pairs =
          (k === 5) === centerIn
            ? [[0, 3], [2, 1]]
            : [[0, 1], [3, 2]];
        for (const [s0, s1] of pairs) {
          e0.push(edgeKey(s0, x, y));
          e1.push(edgeKey(s1, x, y));
        }
        continue;
      }
      for (const [s0, s1] of CASES[k]) {
        e0.push(edgeKey(s0, x, y));
        e1.push(edgeKey(s1, x, y));
      }
    }
  }
  const nSeg = e0.length;
  const adj = new Map<number, number[]>();
  const link = (key: number, s: number) => {
    const l = adj.get(key);
    if (l) l.push(s);
    else adj.set(key, [s]);
  };
  for (let s = 0; s < nSeg; s++) {
    link(e0[s], s);
    link(e1[s], s);
  }
  const pos = (key: number): P => {
    const idx = key >> 1;
    const px = idx % PW;
    const py = (idx - px) / PW;
    if ((key & 1) === 0) {
      const v1 = g[idx];
      const v2 = g[idx + 1];
      return { x: px + (THR - v1) / (v2 - v1) - PAD + 0.5, y: py - PAD + 0.5 };
    }
    const v1 = g[idx];
    const v2 = g[idx + PW];
    return { x: px - PAD + 0.5, y: py + (THR - v1) / (v2 - v1) - PAD + 0.5 };
  };

  const visited = new Uint8Array(nSeg);
  const loops: P[][] = [];
  for (let s0 = 0; s0 < nSeg; s0++) {
    if (visited[s0]) continue;
    const pts: P[] = [];
    let cur = s0;
    let key = e0[s0];
    for (;;) {
      visited[cur] = 1;
      pts.push(pos(key));
      const out = e0[cur] === key ? e1[cur] : e0[cur];
      const l = adj.get(out);
      if (!l) break;
      const next = l[0] === cur ? l[1] : l[0];
      if (next === undefined || visited[next]) break;
      cur = next;
      key = out;
    }
    if (pts.length >= 4) loops.push(pts);
  }
  return loops;
}

const areaOf = (p: P[]) => {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const q = p[(i + 1) % n];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return a / 2;
};

// ---------------------------------------------------------------------------
// 2. Pencocokan kubik Bezier (Schneider, Graphics Gems)
// ---------------------------------------------------------------------------

const bezAt = (b: Bez, t: number): P => {
  const s = 1 - t;
  const a = s * s * s;
  const c1 = 3 * s * s * t;
  const c2 = 3 * s * t * t;
  const d = t * t * t;
  return {
    x: a * b[0].x + c1 * b[1].x + c2 * b[2].x + d * b[3].x,
    y: a * b[0].y + c1 * b[1].y + c2 * b[2].y + d * b[3].y,
  };
};
const bezD1 = (b: Bez, t: number): P => {
  const s = 1 - t;
  return {
    x: 3 * s * s * (b[1].x - b[0].x) + 6 * s * t * (b[2].x - b[1].x) + 3 * t * t * (b[3].x - b[2].x),
    y: 3 * s * s * (b[1].y - b[0].y) + 6 * s * t * (b[2].y - b[1].y) + 3 * t * t * (b[3].y - b[2].y),
  };
};
const bezD2 = (b: Bez, t: number): P => {
  const s = 1 - t;
  return {
    x: 6 * s * (b[2].x - 2 * b[1].x + b[0].x) + 6 * t * (b[3].x - 2 * b[2].x + b[1].x),
    y: 6 * s * (b[2].y - 2 * b[1].y + b[0].y) + 6 * t * (b[3].y - 2 * b[2].y + b[1].y),
  };
};

function chordParam(d: P[]): number[] {
  const u = [0];
  for (let i = 1; i < d.length; i++) u.push(u[i - 1] + len(sub(d[i], d[i - 1])));
  const tot = u[u.length - 1] || 1;
  for (let i = 1; i < u.length; i++) u[i] /= tot;
  return u;
}

function genBezier(d: P[], u: number[], t1: P, t2: P): Bez {
  const n = d.length;
  const p0 = d[0];
  const p3 = d[n - 1];
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < n; i++) {
    const t = u[i];
    const s = 1 - t;
    const b0 = s * s * s;
    const b1 = 3 * s * s * t;
    const b2 = 3 * s * t * t;
    const b3 = t * t * t;
    const a1 = mul(t1, b1);
    const a2 = mul(t2, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(d[i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  const segLen = len(sub(p3, p0));
  let al = 0;
  let ar = 0;
  if (Math.abs(det) > 1e-12) {
    al = (x0 * c11 - x1 * c01) / det;
    ar = (c00 * x1 - c01 * x0) / det;
  }
  const eps = 1e-6 * segLen;
  if (al < eps || ar < eps) {
    al = ar = segLen / 3;
  }
  return [p0, add(p0, mul(t1, al)), add(p3, mul(t2, ar)), p3];
}

function maxError(d: P[], b: Bez, u: number[]): [number, number] {
  let worst = 0;
  let split = Math.floor(d.length / 2);
  for (let i = 1; i < d.length - 1; i++) {
    const q = bezAt(b, u[i]);
    const dx = q.x - d[i].x;
    const dy = q.y - d[i].y;
    const e = dx * dx + dy * dy;
    if (e >= worst) {
      worst = e;
      split = i;
    }
  }
  return [worst, split];
}

function reparam(d: P[], b: Bez, u: number[]): number[] {
  return u.map((t, i) => {
    const q = sub(bezAt(b, t), d[i]);
    const q1 = bezD1(b, t);
    const q2 = bezD2(b, t);
    const num = dot(q, q1);
    const den = dot(q1, q1) + dot(q, q2);
    if (Math.abs(den) < 1e-12) return t;
    return Math.min(1, Math.max(0, t - num / den));
  });
}

function fitCubic(d: P[], t1: P, t2: P, err: number, out: Bez[], depth = 0): void {
  const n = d.length;
  if (n === 2) {
    const dist = len(sub(d[1], d[0])) / 3;
    out.push([d[0], add(d[0], mul(t1, dist)), add(d[1], mul(t2, dist)), d[1]]);
    return;
  }
  let u = chordParam(d);
  let b = genBezier(d, u, t1, t2);
  let [e, split] = maxError(d, b, u);
  if (e < err) {
    out.push(b);
    return;
  }
  if (e < err * 16) {
    for (let k = 0; k < 6; k++) {
      u = reparam(d, b, u);
      b = genBezier(d, u, t1, t2);
      [e, split] = maxError(d, b, u);
      if (e < err) {
        out.push(b);
        return;
      }
    }
  }
  if (depth > 40 || n < 4) {
    out.push(b);
    return;
  }
  split = Math.min(n - 2, Math.max(1, split));
  const tc = unit(sub(d[split - 1], d[split + 1]));
  fitCubic(d.slice(0, split + 1), t1, tc, err, out, depth + 1);
  fitCubic(d.slice(split), mul(tc, -1), t2, err, out, depth + 1);
}

// ---------------------------------------------------------------------------
// 3. Satu kontur -> path
// ---------------------------------------------------------------------------

const fmt = (n: number) => String(Math.round(n * 100) / 100);

function smoothClosed(pts: P[], passes: number): P[] {
  let cur = pts;
  const n = pts.length;
  for (let k = 0; k < passes; k++) {
    const nx = new Array<P>(n);
    for (let i = 0; i < n; i++) {
      const a = cur[(i + n - 1) % n];
      const b = cur[i];
      const c = cur[(i + 1) % n];
      nx[i] = { x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4 };
    }
    cur = nx;
  }
  return cur;
}

function contourToPath(raw: P[], o: FitOptions): string {
  const pts = smoothClosed(raw, o.smooth ?? 0);
  const n = pts.length;
  const seg = new Array<number>(n);
  const cum = new Array<number>(n + 1);
  cum[0] = 0;
  for (let i = 0; i < n; i++) {
    seg[i] = len(sub(pts[(i + 1) % n], pts[i]));
    cum[i + 1] = cum[i] + seg[i];
  }
  const total = cum[n];
  // Indeks titik pada jarak busur >= dist dari i (arah maju/mundur), berputar
  const stepIdx = (i: number, dist: number, dir: 1 | -1) => {
    let acc = 0;
    let j = i;
    for (let k = 0; k < n; k++) {
      const nj = (j + dir + n) % n;
      acc += dir === 1 ? seg[j] : seg[nj];
      j = nj;
      if (acc >= dist) break;
    }
    return j;
  };

  // Sudut tajam: sudut belok antara arah masuk dan keluar pada jarak `win`
  const corners: number[] = [];
  if (total > o.win * 5) {
    const ang = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = sub(pts[i], pts[stepIdx(i, o.win, -1)]);
      const b = sub(pts[stepIdx(i, o.win, 1)], pts[i]);
      const la = len(a);
      const lb = len(b);
      if (la < o.win * 0.5 || lb < o.win * 0.5) continue;
      const c = Math.max(-1, Math.min(1, dot(a, b) / (la * lb)));
      ang[i] = (Math.acos(c) * 180) / Math.PI;
    }
    for (let i = 0; i < n; i++) {
      if (ang[i] < o.corner) continue;
      let isMax = true;
      let acc = 0;
      for (let k = 1; k < n && acc < o.win; k++) {
        const j = (i + k) % n;
        acc += seg[(i + k - 1) % n];
        if (ang[j] > ang[i] || (ang[j] === ang[i] && j < i)) {
          isMax = false;
          break;
        }
      }
      if (isMax) {
        acc = 0;
        for (let k = 1; k < n && acc < o.win; k++) {
          const j = (i - k + n) % n;
          acc += seg[j];
          if (ang[j] > ang[i] || (ang[j] === ang[i] && j < i)) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) corners.push(i);
    }
  }

  const tanLen = o.win * 0.8;
  const beziers: Bez[] = [];
  if (corners.length === 0) {
    const ext: P[] = pts.concat([pts[0]]);
    const a = unit(sub(pts[stepIdx(0, tanLen, 1)], pts[stepIdx(0, tanLen, -1)]));
    fitCubic(ext, a, mul(a, -1), o.err * o.err, beziers);
  } else {
    for (let k = 0; k < corners.length; k++) {
      const s = corners[k];
      const e = corners[(k + 1) % corners.length];
      const sl: P[] = [pts[s]];
      let i = s;
      do {
        i = (i + 1) % n;
        sl.push(pts[i]);
      } while (i !== e);
      if (sl.length < 2) continue;
      const m = Math.min(sl.length - 1, Math.max(1, Math.round(tanLen)));
      const t1 = unit(sub(sl[Math.min(sl.length - 1, m)], sl[0]));
      const t2 = unit(sub(sl[Math.max(0, sl.length - 1 - m)], sl[sl.length - 1]));
      fitCubic(sl, t1, t2, o.err * o.err, beziers);
    }
  }

  let d = `M${fmt(beziers[0][0].x)} ${fmt(beziers[0][0].y)}`;
  for (const b of beziers) {
    // Ruas praktis lurus -> garis lurus (rapi, hemat simpul)
    const ch = sub(b[3], b[0]);
    const cl = len(ch);
    let straight = false;
    if (cl > 1e-6) {
      const nx = -ch.y / cl;
      const ny = ch.x / cl;
      const d1 = Math.abs((b[1].x - b[0].x) * nx + (b[1].y - b[0].y) * ny);
      const d2 = Math.abs((b[2].x - b[0].x) * nx + (b[2].y - b[0].y) * ny);
      straight = d1 < 0.35 && d2 < 0.35;
    }
    d += straight
      ? `L${fmt(b[3].x)} ${fmt(b[3].y)}`
      : `C${fmt(b[1].x)} ${fmt(b[1].y)} ${fmt(b[2].x)} ${fmt(b[2].y)} ${fmt(b[3].x)} ${fmt(b[3].y)}`;
  }
  return d + "Z";
}

/** Medan abu-abu (gelap = isi) -> data path `d` (fill-rule evenodd); "" bila kosong */
export function traceField(field: Uint8Array, w: number, h: number, o: FitOptions): string {
  const loops = contours(field, w, h);
  let d = "";
  for (const l of loops) {
    if (Math.abs(areaOf(l)) <= o.turd) continue;
    d += contourToPath(l, o);
  }
  return d;
}
