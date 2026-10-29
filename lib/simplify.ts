/**
 * Penyederhana path SVG (hasil Potrace): gabungkan deretan segmen Bezier yang
 * menyambung mulus jadi satu kurva (fit kuadrat terkecil dengan tangen ujung tetap).
 * Efek: gelombang/gerigi kecil hilang, jumlah simpul turun drastis, sudut tajam
 * (sambungan tidak mulus) dan garis lurus tetap dipertahankan.
 */
type Pt = { x: number; y: number };
type Seg = { c: boolean; p0: Pt; p1: Pt; p2: Pt; p3: Pt };

const SAMPLES = 8; // titik sampel per segmen asal
const MAX_RUN = 24; // maks segmen asal yang digabung jadi satu kurva
const COS_SMOOTH = Math.cos((20 * Math.PI) / 180); // sambungan <= 20 derajat dianggap mulus

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const len = (a: Pt) => Math.hypot(a.x, a.y);
const unit = (a: Pt): Pt | null => {
  const l = len(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : null;
};

function startDir(s: Seg): Pt {
  const c = s.c ? [sub(s.p1, s.p0), sub(s.p2, s.p0), sub(s.p3, s.p0)] : [sub(s.p3, s.p0)];
  for (const v of c) {
    const u = unit(v);
    if (u) return u;
  }
  return { x: 1, y: 0 };
}

function endDir(s: Seg): Pt {
  const c = s.c ? [sub(s.p3, s.p2), sub(s.p3, s.p1), sub(s.p3, s.p0)] : [sub(s.p3, s.p0)];
  for (const v of c) {
    const u = unit(v);
    if (u) return u;
  }
  return { x: 1, y: 0 };
}

const smoothJoint = (a: Seg, b: Seg) => a.c && b.c && dot(endDir(a), startDir(b)) >= COS_SMOOTH;

function bez(s: Seg, t: number): Pt {
  const m = 1 - t;
  const b0 = m * m * m;
  const b1 = 3 * t * m * m;
  const b2 = 3 * t * t * m;
  const b3 = t * t * t;
  return {
    x: b0 * s.p0.x + b1 * s.p1.x + b2 * s.p2.x + b3 * s.p3.x,
    y: b0 * s.p0.y + b1 * s.p1.y + b2 * s.p2.y + b3 * s.p3.y,
  };
}

function bezD1(s: Seg, t: number): Pt {
  const m = 1 - t;
  const a = mul(sub(s.p1, s.p0), 3 * m * m);
  const b = mul(sub(s.p2, s.p1), 6 * m * t);
  const c = mul(sub(s.p3, s.p2), 3 * t * t);
  return add(add(a, b), c);
}

function bezD2(s: Seg, t: number): Pt {
  const m = 1 - t;
  const a = mul(add(sub(s.p2, mul(s.p1, 2)), s.p0), 6 * m);
  const b = mul(add(sub(s.p3, mul(s.p2, 2)), s.p1), 6 * t);
  return add(a, b);
}

/** Cari alpha1/alpha2 (panjang handle) terbaik untuk titik + parameter u yang diberikan */
function solve(pts: Pt[], u: number[], P0: Pt, P3: Pt, t1: Pt, t2: Pt, pathLen: number): Seg | null {
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let k = 0; k < pts.length; k++) {
    const t = u[k];
    const m = 1 - t;
    const b0 = m * m * m;
    const b1 = 3 * t * m * m;
    const b2 = 3 * t * t * m;
    const b3 = t * t * t;
    const A1 = mul(t1, b1);
    const A2 = mul(t2, b2);
    const tmp = sub(pts[k], add(mul(P0, b0 + b1), mul(P3, b2 + b3)));
    c00 += dot(A1, A1);
    c01 += dot(A1, A2);
    c11 += dot(A2, A2);
    x0 += dot(A1, tmp);
    x1 += dot(A2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  const chord = len(sub(P3, P0));
  const base = (chord > 1e-6 ? chord : pathLen / 3) / 3;
  let a1 = base;
  let a2 = base;
  if (Math.abs(det) > 1e-9) {
    a1 = (x0 * c11 - x1 * c01) / det;
    a2 = (c00 * x1 - c01 * x0) / det;
  }
  // handle tak wajar -> fallback; kurva fit harus tetap "jinak"
  if (!(a1 > 1e-6 * pathLen) || !(a2 > 1e-6 * pathLen) || a1 > pathLen || a2 > pathLen) {
    a1 = base;
    a2 = base;
  }
  return { c: true, p0: P0, p1: add(P0, mul(t1, a1)), p2: add(P3, mul(t2, a2)), p3: P3 };
}

/** Gabungkan segs[i..k] jadi satu kurva bila simpangan maksimum <= tol, selain itu null */
function fitRun(orig: Seg[], segs: Seg[], i: number, k: number, tol: number, tOut: Pt, tIn: Pt): Seg | null {
  const pts: Pt[] = [];
  for (let s = i; s <= k; s++) {
    for (let j = 0; j < SAMPLES; j++) pts.push(bez(orig[s], j / SAMPLES));
  }
  pts.push(orig[k].p3);

  const u: number[] = [0];
  for (let j = 1; j < pts.length; j++) u.push(u[j - 1] + len(sub(pts[j], pts[j - 1])));
  const total = u[u.length - 1];
  if (total < 1e-9) return null;
  for (let j = 0; j < u.length; j++) u[j] /= total;

  const P0 = segs[i].p0;
  const P3 = segs[k].p3;
  const t1 = tOut;
  const t2 = mul(tIn, -1);

  let best: Seg | null = null;
  for (let it = 0; it < 4; it++) {
    const cur = solve(pts, u, P0, P3, t1, t2, total);
    if (!cur) return null;
    best = cur;
    // reparameterisasi Newton-Raphson
    for (let j = 1; j < pts.length - 1; j++) {
      const t = u[j];
      const d = sub(bez(cur, t), pts[j]);
      const d1 = bezD1(cur, t);
      const den = dot(d1, d1) + dot(d, bezD2(cur, t));
      if (Math.abs(den) > 1e-12) u[j] = Math.min(1, Math.max(0, t - dot(d, d1) / den));
    }
  }
  if (!best) return null;

  // Ukur simpangan sebenarnya: jarak tiap titik asal ke kurva hasil (cari titik terdekat)
  let maxErr = 0;
  const N = 48;
  const curve: Pt[] = [];
  for (let j = 0; j <= N; j++) curve.push(bez(best, j / N));
  for (const p of pts) {
    let md = Infinity;
    for (let j = 0; j < curve.length - 1; j++) {
      const a = curve[j];
      const ab = sub(curve[j + 1], a);
      const l2 = dot(ab, ab);
      const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2)) : 0;
      const q = add(a, mul(ab, t));
      const d = len(sub(p, q));
      if (d < md) md = d;
    }
    if (md > maxErr) maxErr = md;
    if (maxErr > tol) return null;
  }
  return best;
}


const line = (a: Pt, b: Pt): Seg => ({ c: false, p0: a, p1: a, p2: b, p3: b });

/** Jarak titik p ke garis lurus a-b */
function distLine(p: Pt, a: Pt, b: Pt): number {
  const ab = sub(b, a);
  const l = len(ab);
  if (l < 1e-9) return len(sub(p, a));
  return Math.abs((p.x - a.x) * ab.y - (p.y - a.y) * ab.x) / l;
}

/** Kurva yang praktis lurus: tubuh kurva (bukan cuma handle) menempel garis a-b */
function nearlyStraight(s: Seg, d: number, minLen: number): boolean {
  if (!s.c) return false;
  const ab = sub(s.p3, s.p0);
  const l2 = dot(ab, ab);
  // hanya tepi panjang yang sengaja lurus; potongan pendek (lengkung halus / sudut membulat) dibiarkan
  if (l2 < minLen * minLen) return false;
  const ua = unit(ab);
  if (!ua || dot(startDir(s), ua) < 0.94 || dot(endDir(s), ua) < 0.94) return false;
  for (const h of [s.p1, s.p2]) {
    const t = dot(sub(h, s.p0), ab) / l2;
    if (t < -0.15 || t > 1.15) return false;
    if (distLine(h, s.p0, s.p3) > d * 2.5) return false;
  }
  for (const t of [0.2, 0.4, 0.6, 0.8]) if (distLine(bez(s, t), s.p0, s.p3) > d) return false;
  return true;
}

/**
 * Perapih teks/bentuk geometris:
 * 1. kurva praktis lurus -> garis
 * 2. garis berurutan yang segaris -> satu garis
 * 3. sudut yang membulat kecil (garis, kurva pendek, garis) -> sudut tajam di titik potong
 */
function straighten(input: Seg[], tol: number): Seg[] {
  let a = input.map((sg) => (nearlyStraight(sg, tol * 0.6, tol * 30) ? line(sg.p0, sg.p3) : sg));
  const cornerMax = tol * 5;
  const cosMin = Math.cos((120 * Math.PI) / 180);
  const cosMax = Math.cos((35 * Math.PI) / 180);

  for (let guard = 0; guard < 2000 && a.length >= 3; guard++) {
    const n = a.length;
    let changed = false;
    for (let i = 0; i < n && !changed; i++) {
      const A = a[i];
      if (A.c) continue;
      const B = a[(i + 1) % n];

      // 2. garis + garis segaris
      if (!B.c) {
        const da = unit(sub(A.p3, A.p0));
        const db = unit(sub(B.p3, B.p0));
        if (da && db && dot(da, db) > 0.9 && distLine(A.p3, A.p0, B.p3) <= tol * 0.5) {
          const merged = line(A.p0, B.p3);
          const j = (i + 1) % n;
          a[i] = merged;
          a.splice(j, 1);
          changed = true;
        }
        continue;
      }

      // 3. sudut membulat: A (garis) + 1-2 kurva pendek + C (garis)
      for (let r = 1; r <= 2 && !changed; r++) {
        if (n < r + 3) break;
        let ok = true;
        for (let q = 1; q <= r; q++) if (!a[(i + q) % n].c) ok = false;
        const C = a[(i + r + 1) % n];
        if (!ok || C.c) continue;
        const start = a[(i + 1) % n].p0;
        const end = a[(i + r) % n].p3;
        const span = len(sub(end, start));
        let arc = 0;
        for (let q = 1; q <= r; q++) {
          const g = a[(i + q) % n];
          arc += len(sub(g.p1, g.p0)) + len(sub(g.p2, g.p1)) + len(sub(g.p3, g.p2));
        }
        if (span > cornerMax || arc > cornerMax * 2.5) continue;
        const da = unit(sub(A.p3, A.p0));
        const dc = unit(sub(C.p3, C.p0));
        if (!da || !dc) continue;
        if (len(sub(A.p3, A.p0)) < tol * 2 || len(sub(C.p3, C.p0)) < tol * 2) continue;
        const cs = dot(da, dc);
        if (cs > cosMax || cs < cosMin) continue;
        const cr = da.x * dc.y - da.y * dc.x;
        if (Math.abs(cr) < 1e-6) continue;
        const w = sub(C.p0, A.p0);
        const t = (w.x * dc.y - w.y * dc.x) / cr;
        const X = add(A.p0, mul(da, t));
        if (len(sub(X, start)) > cornerMax * 1.5 || len(sub(X, end)) > cornerMax * 1.5) continue;
        const iA = i;
        const iC = (i + r + 1) % n;
        a[iA] = line(A.p0, X);
        a[iC] = line(X, C.p3);
        // buang kurva di antara A dan C (indeks i+1 .. i+r, melingkar)
        const drop = new Set<number>();
        for (let q = 1; q <= r; q++) drop.add((i + q) % n);
        a = a.filter((_, idx) => !drop.has(idx));
        changed = true;
      }
    }
    if (!changed) break;
  }
  return a;
}

function mergeCurves(segs: Seg[], tol: number): Seg[] {
  const n = segs.length;
  if (n < 2) return segs;
  // Putar awal path ke sambungan yang tidak mulus (sudut) supaya kurva tidak terbelah di tengah sisi mulus
  let rot = -1;
  for (let k = 0; k < n; k++) {
    if (!smoothJoint(segs[(k + n - 1) % n], segs[k])) {
      rot = k;
      break;
    }
  }
  const list = rot > 0 ? [...segs.slice(rot), ...segs.slice(0, rot)] : segs;

  // Salinan path asli: simpangan selalu diukur terhadap bentuk ASLI, bukan yang sudah digeser
  const orig: Seg[] = list.map((sg) => ({ ...sg }));

  // Haluskan posisi simpul di sambungan mulus (rata-rata 1-2-1 dengan tetangga, 2 putaran):
  // simpul yang selang-seling maju/mundur (gerigi/gelombang) jadi rata. Sudut tidak disentuh.
  const smoothNode = list.map((_, j) => smoothJoint(list[(j + n - 1) % n], list[j]));
  for (let pass = 0; pass < 2; pass++) {
    const np = list.map((sg) => sg.p0);
    const shift = np.map((q, j) => {
      if (!smoothNode[j]) return { x: 0, y: 0 };
      const a = np[(j + n - 1) % n];
      const b = np[(j + 1) % n];
      const dx = (a.x + b.x) / 4 + q.x / 2 - q.x;
      const dy = (a.y + b.y) / 4 + q.y / 2 - q.y;
            const m = Math.hypot(dx, dy);
      // pergeseran besar = lengkung asli (bukan gerigi): jangan disentuh, supaya bentuk tidak menyusut
      if (m > tol * 0.6) return { x: 0, y: 0 };
      return { x: dx, y: dy };
    });
    for (let j = 0; j < n; j++) {
      const d = shift[j];
      if (!d.x && !d.y) continue;
      const prev = list[(j + n - 1) % n];
      const cur = list[j];
      prev.p3 = add(prev.p3, d);
      prev.p2 = add(prev.p2, d);
      cur.p0 = add(cur.p0, d);
      cur.p1 = add(cur.p1, d);
    }
  }

  // Tangen tiap simpul diambil dari titik tengah segmen tetangga (selisih terpusat),
  // bukan dari handle Potrace: getaran kecil di handle tidak ikut memaksa kurva bergelombang.
  // Simpul sudut memakai tangen satu sisi supaya sudut tetap tajam.
  const mid = (s: Seg) => bez(s, 0.5);
  const tanOut: Pt[] = [];
  const tanIn: Pt[] = [];
  for (let j = 0; j <= n; j++) {
    const prev = list[(j + n - 1) % n];
    const next = list[j % n];
    if (prev.c && next.c && smoothJoint(prev, next)) {
      const t = unit(sub(mid(next), mid(prev))) ?? startDir(next);
      tanOut.push(t);
      tanIn.push(t);
    } else {
      tanOut.push(unit(sub(mid(next), next.p0)) ?? startDir(next));
      tanIn.push(unit(sub(prev.p3, mid(prev))) ?? endDir(prev));
    }
  }

  const out: Seg[] = [];
  let i = 0;
  while (i < n) {
    const s = list[i];
    let best = s;
    let last = i;
    if (s.c) {
      let k = i + 1;
      while (k < n && k - i < MAX_RUN && smoothJoint(list[k - 1], list[k])) {
        const fit = fitRun(orig, list, i, k, tol, tanOut[i], tanIn[k + 1]);
        if (!fit) break;
        best = fit;
        last = k;
        k++;
      }
    }
    out.push(best);
    i = last + 1;
  }
  return out;
}


/* ---------- Deteksi garis lurus pada titik padat kontur (untuk teks / bentuk geometris) ---------- */

type Run = { i: number; j: number; a: Pt; b: Pt };

function flatten(segs: Seg[], step: number): Pt[] {
  const pts: Pt[] = [];
  for (const s of segs) {
    const L = s.c ? len(sub(s.p1, s.p0)) + len(sub(s.p2, s.p1)) + len(sub(s.p3, s.p2)) : len(sub(s.p3, s.p0));
    const m = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < m; k++) {
      const t = k / m;
      pts.push(s.c ? bez(s, t) : { x: s.p0.x + (s.p3.x - s.p0.x) * t, y: s.p0.y + (s.p3.y - s.p0.y) * t });
    }
  }
  return pts;
}

/** Simpangan maks semua titik i..j (termasuk ujung) terhadap garis TLS-nya, plus apakah semuanya di satu sisi */
function lineStats(P: Pt[], i: number, j: number): { dev: number; oneSided: number } {
  const N = P.length;
  const m = j - i + 1;
  let cx = 0;
  let cy = 0;
  for (let k = i; k <= j; k++) {
    cx += P[k % N].x;
    cy += P[k % N].y;
  }
  cx /= m;
  cy /= m;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let k = i; k <= j; k++) {
    const dx = P[k % N].x - cx;
    const dy = P[k % N].y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const nx = -Math.sin(th);
  const ny = Math.cos(th);
  let dev = 0;
  let pos = 0;
  let neg = 0;
  for (let k = i; k <= j; k++) {
    const sd = (P[k % N].x - cx) * nx + (P[k % N].y - cy) * ny;
    const d = Math.abs(sd);
    if (d > dev) dev = d;
    if (d > 0.02) (sd > 0 ? pos++ : neg++);
  }
  const tot = pos + neg;
  return { dev, oneSided: tot ? Math.max(pos, neg) / tot : 0 };
}

/** Seberapa "melengkung" titik i..j terhadap tali busur: simpangan maks dan porsi titik di satu sisi (busur = hampir semua satu sisi) */
function chordBow(P: Pt[], i: number, j: number): { dev: number; oneSided: number } {
  const N = P.length;
  const a = P[i % N];
  const b = P[j % N];
  const ab = sub(b, a);
  const l = len(ab);
  if (l < 1e-9) return { dev: Infinity, oneSided: 1 };
  let dev = 0;
  let pos = 0;
  let neg = 0;
  for (let k = i + 1; k < j; k++) {
    const q = P[k % N];
    const sd = ((q.x - a.x) * ab.y - (q.y - a.y) * ab.x) / l;
    if (Math.abs(sd) > dev) dev = Math.abs(sd);
    if (Math.abs(sd) > 0.01) (sd > 0 ? pos++ : neg++);
  }
  const tot = pos + neg;
  return { dev, oneSided: tot ? Math.max(pos, neg) / tot : 0 };
}

/** Garis kuadrat terkecil total (TLS) lewat titik i..j, arah searah a->b; ujung = proyeksi titik awal/akhir; sumbu dikunci bila nyaris tegak/datar */
function fitLineRun(P: Pt[], i: number, j: number): Run {
  const N = P.length;
  let cx = 0;
  let cy = 0;
  const m = j - i + 1;
  for (let k = i; k <= j; k++) {
    cx += P[k % N].x;
    cy += P[k % N].y;
  }
  cx /= m;
  cy /= m;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let k = i; k <= j; k++) {
    const dx = P[k % N].x - cx;
    const dy = P[k % N].y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let d: Pt = { x: Math.cos(th), y: Math.sin(th) };
  const chord = sub(P[j % N], P[i % N]);
  if (dot(d, chord) < 0) d = mul(d, -1);
  let c: Pt = { x: cx, y: cy };
  const AX = Math.sin((1.5 * Math.PI) / 180);
  if (Math.abs(d.y) < AX) d = { x: d.x > 0 ? 1 : -1, y: 0 }; // datar persis
  else if (Math.abs(d.x) < AX) d = { x: 0, y: d.y > 0 ? 1 : -1 }; // tegak persis
  const proj = (q: Pt): Pt => add(c, mul(d, dot(sub(q, c), d)));
  c = { x: cx, y: cy };
  return { i, j, a: proj(P[i % N]), b: proj(P[j % N]) };
}

/** Schneider: fit deretan titik jadi satu/lebih kurva Bezier dengan tangen ujung tetap */
function fitPoints(pts: Pt[], t1: Pt, t2: Pt, tol: number, depth = 0): Seg[] {
  const P0 = pts[0];
  const P3 = pts[pts.length - 1];
  const chord = len(sub(P3, P0));
  if (pts.length <= 2) {
    const h = chord / 3;
    return [{ c: true, p0: P0, p1: add(P0, mul(t1, h)), p2: add(P3, mul(t2, h)), p3: P3 }];
  }
  const u: number[] = [0];
  for (let k = 1; k < pts.length; k++) u.push(u[k - 1] + len(sub(pts[k], pts[k - 1])));
  const total = u[u.length - 1];
  if (total < 1e-9) return [line(P0, P3)];
  for (let k = 0; k < u.length; k++) u[k] /= total;

  let cur: Seg | null = null;
  for (let it = 0; it < 4; it++) {
    cur = solve(pts, u, P0, P3, t1, t2, total);
    if (!cur) break;
    for (let k = 1; k < pts.length - 1; k++) {
      const t = u[k];
      const d = sub(bez(cur, t), pts[k]);
      const d1 = bezD1(cur, t);
      const den = dot(d1, d1) + dot(d, bezD2(cur, t));
      if (Math.abs(den) > 1e-12) u[k] = Math.min(1, Math.max(0, t - dot(d, d1) / den));
    }
  }
  if (!cur) return [line(P0, P3)];

  const N = 40;
  const curve: Pt[] = [];
  for (let k = 0; k <= N; k++) curve.push(bez(cur, k / N));
  let maxErr = 0;
  let at = Math.floor(pts.length / 2);
  for (let k = 1; k < pts.length - 1; k++) {
    let md = Infinity;
    for (let q = 0; q < curve.length - 1; q++) {
      const a = curve[q];
      const ab = sub(curve[q + 1], a);
      const l2 = dot(ab, ab);
      const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(pts[k], a), ab) / l2)) : 0;
      const d = len(sub(pts[k], add(a, mul(ab, t))));
      if (d < md) md = d;
    }
    if (md > maxErr) {
      maxErr = md;
      at = k;
    }
  }
  if (maxErr <= tol || depth >= 5 || pts.length < 6) return [cur];
  const w = Math.min(6, at, pts.length - 1 - at);
  const tc = unit(sub(pts[at + w], pts[at - w])) ?? t1;
  return [...fitPoints(pts.slice(0, at + 1), t1, mul(tc, -1), tol, depth + 1), ...fitPoints(pts.slice(at), tc, t2, tol, depth + 1)];
}

/**
 * Cari tepi yang seharusnya lurus langsung dari titik-titik padat kontur (tahan terhadap tepi yang
 * terpecah jadi banyak kurva kecil bergelombang). Tepi jadi garis lurus (datar/tegak dikunci persis),
 * sudut tajam dibentuk dari titik potong dua garis, sisanya difit ulang sebagai kurva mulus.
 * Mengembalikan null bila tidak ada garis lurus (pakai penggabung kurva biasa).
 */
function snapLines(segs: Seg[], tol: number): Seg[] | null {
  const STEP = 1;
  const P = flatten(segs, STEP);
  const N = P.length;
  if (N < 12) return null;
  const dTol = tol * 0.8;
  const minLen = tol * 12;
  const cornerMax = tol * 14;
  const strongLen = tol * 30; // garis tanpa sudut di ujungnya harus cukup panjang, kalau tidak itu lengkung

  // titik awal: paling jauh dari pusat (hampir pasti bukan di tengah tepi lurus)
  let cx = 0;
  let cy = 0;
  for (const q of P) {
    cx += q.x;
    cy += q.y;
  }
  cx /= N;
  cy /= N;
  let s0 = 0;
  let far = -1;
  for (let k = 0; k < N; k++) {
    const d = (P[k].x - cx) ** 2 + (P[k].y - cy) ** 2;
    if (d > far) {
      far = d;
      s0 = k;
    }
  }

  const runs: Run[] = [];
  let pos = s0;
  const end = s0 + N;
  while (pos < end) {
    let best = -1;
    for (let j = pos + 2; j <= end; j++) {
      const st = lineStats(P, pos, j);
      if (st.dev > dTol) break;
      // lengkung landai (sisi tunggal & cukup menyimpang) bukan garis: jangan dipoligonkan
      const bow = chordBow(P, pos, j);
      if (bow.dev > tol * 0.08 && bow.oneSided > 0.9) continue;
      best = j;
    }
    if (best > 0 && len(sub(P[best % N], P[pos % N])) >= minLen) {
      runs.push(fitLineRun(P, pos, best));
      pos = best;
    } else pos++;
  }
  if (!runs.length) return null;

  // Gabungkan garis berurutan yang segaris (terpecah oleh goyangan kecil)
  for (let r = 0; r + 1 < runs.length; ) {
    const A = runs[r];
    const B = runs[r + 1];
    const da = unit(sub(A.b, A.a));
    const db = unit(sub(B.b, B.a));
    if (
      da &&
      db &&
      len(sub(B.a, A.b)) <= cornerMax &&
      dot(da, db) >= Math.cos((4 * Math.PI) / 180) &&
      distLine(B.a, A.a, A.b) <= dTol &&
      distLine(A.b, B.a, B.b) <= dTol
    ) {
      runs.splice(r, 2, fitLineRun(P, A.i, B.j));
    } else r++;
  }

  // Saring: garis pendek tanpa sudut di ujung = potongan lengkung (lingkaran jangan jadi poligon)
  const COS_C = Math.cos((30 * Math.PI) / 180);
  const COS_H = Math.cos((140 * Math.PI) / 180);
  const dirR = (r: Run) => unit(sub(r.b, r.a)) ?? { x: 1, y: 0 };
  const cornerBetween = (A: Run, B: Run) => {
    if (len(sub(B.a, A.b)) > cornerMax) return false;
    const cs = dot(dirR(A), dirR(B));
    return cs <= COS_C && cs >= COS_H;
  };
  const smoothAdj = (A: Run, B: Run) => len(sub(B.a, A.b)) <= cornerMax && dot(dirR(A), dirR(B)) > COS_C;
  const kept = runs.filter((r, idx) => {
    const L = len(sub(r.b, r.a));
    const prev = runs[(idx + runs.length - 1) % runs.length];
    const next = runs[(idx + 1) % runs.length];
    // rantai garis yang menyambung landai di kedua sisi = lengkung besar yang terpecah, bukan tepi lurus
    if (runs.length >= 3 && L < tol * 60 && smoothAdj(prev, r) && smoothAdj(r, next)) return false;
    if (L >= strongLen) return true;
    if (runs.length < 2) return false;
    return cornerBetween(prev, r) || cornerBetween(r, next);
  });
  if (!kept.length) return null;
  runs.length = 0;
  runs.push(...kept);

  const R = runs.length;
  if (R < 2) return null; // satu garis saja: kontur tidak bisa dibangun ulang dengan aman
  const dirOf = (r: Run) => unit(sub(r.b, r.a)) ?? { x: 1, y: 0 };

  // Sudut: dua garis berurutan dengan jarak pendek di antaranya -> titik potong
  const joinCorner: boolean[] = new Array(R).fill(false); // join antara run r-1 dan r
  for (let r = 0; r < R; r++) {
    const A = runs[(r + R - 1) % R];
    const B = runs[r];
    if (R === 1) break;
    const da = dirOf(A);
    const db = dirOf(B);
    const gap = len(sub(B.a, A.b));
    if (gap > cornerMax) continue;
    const cs = dot(da, db);
    if (cs > COS_C || cs < COS_H) continue;
    const cr = da.x * db.y - da.y * db.x;
    if (Math.abs(cr) < 1e-6) continue;
    const w = sub(B.a, A.a);
    const t = (w.x * db.y - w.y * db.x) / cr;
    const X = add(A.a, mul(da, t));
    if (len(sub(X, A.b)) > cornerMax * 1.5 || len(sub(X, B.a)) > cornerMax * 1.5) continue;
    joinCorner[r] = true;
    A.b = X;
    B.a = X;
  }

  const out: Seg[] = [];
  for (let r = 0; r < R; r++) {
    const A = runs[(r + R - 1) % R];
    const B = runs[r];
    if (!joinCorner[r]) {
      // bagian antara garis: kurva halus dengan tangen = arah garis
      const from = A.j;
      let to = B.i;
      if (to < from) to += N;
      const mid: Pt[] = [];
      const dA = dirOf(A);
      const dB = dirOf(B);
      for (let k = from + 1; k < to; k++) {
        const q = P[k % N];
        // buang titik yang masih "di dalam" garis (di belakang ujung A / melewati awal B)
        if (dot(sub(q, A.b), dA) <= 0 || dot(sub(q, B.a), dB) >= 0) continue;
        mid.push(q);
      }
      const part = [A.b, ...mid, B.a];
      if (len(sub(B.a, A.b)) < 1e-6 && !mid.length) {
        // menyatu
      } else if (!mid.length) {
        out.push(line(A.b, B.a));
      } else {
        out.push(...fitPoints(part, dirOf(A), mul(dirOf(B), -1), tol * 1.2));
      }
    }
    out.push(line(B.a, B.b));
  }
  // potongan kurva kecil hasil fit digabung lagi bila sambungannya mulus
  const result = mergeCurves(out, tol);

  // Pengaman: hasil tidak boleh menyimpang dari kontur asli (bila ya, pakai jalur biasa)
  const Q = flatten(result, 2);
  if (Q.length < 3) return null;
  for (let k = 0; k < N; k += 3) {
    let md = Infinity;
    for (let q = 0; q < Q.length; q++) {
      const a = Q[q];
      const b = Q[(q + 1) % Q.length];
      const ab = sub(b, a);
      const l2 = dot(ab, ab);
      const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(P[k], a), ab) / l2)) : 0;
      const d = len(sub(P[k], add(a, mul(ab, t))));
      if (d < md) md = d;
      if (md <= tol * 2) break;
    }
    if (md > tol * 2) return null;
  }
  return result;
}

/** Tahap: rapikan garis/sudut dulu, lalu gabung kurva sisanya, lalu rapikan lagi */
function simplifySub(segs: Seg[], tol: number): Seg[] {
  const snapped = snapLines(segs, tol);
  if (snapped) return snapped;
  return straighten(mergeCurves(straighten(segs, tol), tol), tol);
}

function parse(d: string): Seg[][] | null {
  const tok = d.match(/[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
  if (!tok) return null;
  const subs: Seg[][] = [];
  let cur: Seg[] = [];
  let start: Pt = { x: 0, y: 0 };
  let pos: Pt = { x: 0, y: 0 };
  let cmd = "";
  let i = 0;
  const num = () => Number(tok[i++]);
  const close = () => {
    if (!cur.length) return;
    if (len(sub(pos, start)) > 1e-3) cur.push({ c: false, p0: pos, p1: pos, p2: start, p3: start });
    subs.push(cur);
    cur = [];
  };
  while (i < tok.length) {
    const t = tok[i];
    if (/[A-Za-z]/.test(t)) {
      if (!/[MLCZ]/.test(t) && !/z/.test(t)) return null; // relatif/arc: tidak didukung
      cmd = t.toUpperCase();
      i++;
      if (cmd === "Z") {
        close();
        pos = start;
        continue;
      }
    }
    if (cmd === "M") {
      close();
      pos = { x: num(), y: num() };
      start = pos;
      cmd = "L"; // koordinat berikutnya setelah M = garis
    } else if (cmd === "L") {
      const p = { x: num(), y: num() };
      cur.push({ c: false, p0: pos, p1: pos, p2: p, p3: p });
      pos = p;
    } else if (cmd === "C") {
      const p1 = { x: num(), y: num() };
      const p2 = { x: num(), y: num() };
      const p3 = { x: num(), y: num() };
      cur.push({ c: true, p0: pos, p1, p2, p3 });
      pos = p3;
    } else return null;
  }
  close();
  return subs.length ? subs : null;
}

const f = (v: number) => (Math.round(v * 100) / 100).toString();
const pt = (p: Pt) => `${f(p.x)} ${f(p.y)}`;

function build(subs: Seg[][]): string {
  let d = "";
  for (const s of subs) {
    d += `M${pt(s[0].p0)}`;
    for (const g of s) d += g.c ? `C${pt(g.p1)} ${pt(g.p2)} ${pt(g.p3)}` : `L${pt(g.p3)}`;
    d += "z";
  }
  return d;
}

/** Sederhanakan atribut d="..." dalam tag <path> hasil Potrace. tol dalam satuan koordinat path. */
export function simplifyTag(tag: string, tol: number): string {
  if (!(tol > 0)) return tag;
  const m = tag.match(/ d="([^"]*)"/);
  if (!m) return tag;
  try {
    const subs = parse(m[1]);
    if (!subs) return tag;
    const d = build(subs.map((s) => simplifySub(s, tol)));
    return tag.replace(m[0], ` d="${d}"`);
  } catch {
    return tag;
  }
}
