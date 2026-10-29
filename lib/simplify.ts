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

function simplifySub(segs: Seg[], tol: number): Seg[] {
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
