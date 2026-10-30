/**
 * Pengelompokan warna palet menjadi OBJEK (badan, baju, rambut, mata, kacamata, ...)
 * lalu urutan tumpukan (z-index) objek dari belakang ke depan.
 *
 * Tanpa AI: murni heuristik geometri.
 * - Dua warna digabung jadi satu objek bila mirip DAN berbatasan panjang (bayangan kulit, sorot rambut).
 * - Latar = objek yang menyentuh tepi gambar -> lapisan paling belakang (persegi penuh).
 * - Objek non-latar terbesar = "badan" -> tepat di atas latar, bentuknya dilengkapi sampai ke bawah
 *   objek lain (hull cembung), jadi tidak berlubang saat dipindah/dihapus layer di atasnya.
 * - Objek lain urut dari luas terbesar ke terkecil.
 */

export type ObjectGroup = {
  /** posisi tumpukan: 0 = paling belakang */
  z: number;
  /** indeks warna (peringkat palet): [0] = warna dasar (siluet penuh), sisanya urut tumpukan */
  ranks: number[];
  area: number;
  isBg: boolean;
  isBase: boolean;
  name: string;
};

const hexOf = (c: number) => c.toString(16).padStart(6, "0");

function dist(a: number, b: number) {
  return Math.hypot((a >> 16) - (b >> 16), ((a >> 8) & 255) - ((b >> 8) & 255), (a & 255) - (b & 255));
}

export function groupObjects(
  rk: Int16Array,
  ranked: number[],
  W: number,
  H: number,
  o: { mergeDist?: number; mergeContact?: number } = {},
): { groups: ObjectGroup[]; objOfRank: Int16Array } {
  const K = ranked.length;
  const cnt = new Float64Array(K);
  const perim = new Float64Array(K);
  const border = new Float64Array(K);
  const contact = new Map<number, number>();
  const pair = (a: number, b: number) => {
    perim[a]++;
    perim[b]++;
    const key = a < b ? a * K + b : b * K + a;
    contact.set(key, (contact.get(key) ?? 0) + 1);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const a = rk[i];
      if (a < 0) continue;
      cnt[a]++;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border[a]++;
      if (x < W - 1) {
        const b = rk[i + 1];
        if (b >= 0 && b !== a) pair(a, b);
      }
      if (y < H - 1) {
        const b = rk[i + W];
        if (b >= 0 && b !== a) pair(a, b);
      }
    }
  }

  // gabungkan warna mirip yang berbatasan panjang (union-find)
  const parent = Array.from({ length: K }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const maxD = o.mergeDist ?? 80;
  const minC = o.mergeContact ?? 0.08;
  [...contact.entries()]
    .sort((p, q) => q[1] - p[1])
    .forEach(([key, c]) => {
      const a = Math.floor(key / K);
      const b = key % K;
      if (dist(ranked[a], ranked[b]) < maxD && c >= minC * Math.min(perim[a], perim[b])) parent[find(a)] = find(b);
    });

  const members = new Map<number, number[]>();
  for (let r = 0; r < K; r++) {
    if (cnt[r] === 0) continue;
    const root = find(r);
    if (!members.has(root)) members.set(root, []);
    members.get(root)!.push(r);
  }
  type Raw = { ranks: number[]; area: number; border: number };
  const raws: Raw[] = [...members.values()].map((ranks) => ({
    ranks,
    area: ranks.reduce((s, r) => s + cnt[r], 0),
    border: ranks.reduce((s, r) => s + border[r], 0),
  }));

  // latar: objek yang paling banyak menyentuh tepi, minimal separuh keliling
  let bgIdx = -1;
  raws.forEach((r, i) => {
    if (r.border >= (W + H) && (bgIdx < 0 || r.border > raws[bgIdx].border)) bgIdx = i;
  });
  const rest = raws.map((_, i) => i).filter((i) => i !== bgIdx).sort((a, b) => raws[b].area - raws[a].area);
  const ordered = bgIdx >= 0 ? [bgIdx, ...rest] : rest;

  const objOfRank = new Int16Array(K).fill(-1);
  let objN = 0;
  const groups: ObjectGroup[] = ordered.map((ri, z) => {
    const raw = raws[ri];
    const base = [...raw.ranks].sort((a, b) => cnt[b] - cnt[a])[0];
    const ranks = [base, ...raw.ranks.filter((r) => r !== base).sort((a, b) => a - b)];
    ranks.forEach((r) => (objOfRank[r] = z));
    const isBg = ri === bgIdx;
    const isBase = z === (bgIdx >= 0 ? 1 : 0);
    const name = isBg ? "latar" : isBase ? "badan-utama" : `objek-${++objN}-${hexOf(ranked[base])}`;
    return { z, ranks, area: raw.area, isBg, isBase, name };
  });
  return { groups, objOfRank };
}

// ---------------------------------------------------------------------------

function dilate(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const tmp = new Uint8Array(W * H);
  const out = new Uint8Array(W * H);
  const pre = new Int32Array(Math.max(W, H) + 1);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) pre[x + 1] = pre[x] + mask[row + x];
    for (let x = 0; x < W; x++) tmp[row + x] = pre[Math.min(W, x + r + 1)] - pre[Math.max(0, x - r)] > 0 ? 1 : 0;
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) pre[y + 1] = pre[y] + tmp[y * W + x];
    for (let y = 0; y < H; y++) out[y * W + x] = pre[Math.min(H, y + r + 1)] - pre[Math.max(0, y - r)] > 0 ? 1 : 0;
  }
  return out;
}

export { dilate as dilateMask };

/** Hull cembung dari himpunan piksel (per-baris min/max -> monotone chain -> scanline) */
function hullMask(mask: Uint8Array, W: number, H: number): Uint8Array {
  const pts: [number, number][] = [];
  for (let y = 0; y < H; y++) {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) {
        if (lo < 0) lo = x;
        hi = x;
      }
    }
    if (lo >= 0) {
      pts.push([lo, y]);
      if (hi !== lo) pts.push([hi, y]);
    }
  }
  const out = new Uint8Array(W * H);
  if (pts.length < 3) return out;
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  for (let y = 0; y < H; y++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < hull.length; k++) {
      const [x1, y1] = hull[k];
      const [x2, y2] = hull[(k + 1) % hull.length];
      if ((y1 <= y && y <= y2) || (y2 <= y && y <= y1)) {
        if (y1 === y2) {
          lo = Math.min(lo, x1, x2);
          hi = Math.max(hi, x1, x2);
        } else {
          const x = x1 + ((y - y1) * (x2 - x1)) / (y2 - y1);
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
        }
      }
    }
    if (lo <= hi) for (let x = Math.max(0, Math.ceil(lo)); x <= Math.min(W - 1, Math.floor(hi)); x++) out[y * W + x] = 1;
  }
  return out;
}

/**
 * Area TERSEMBUNYI yang harus diisi siluet objek z: piksel milik objek DI ATASNYA yang
 *  (a) mengisi lubang tertutup objek (mata di dalam kulit),
 *  (b) menjembatani celah sempit (penutupan morfologi),
 *  (c) untuk objek dasar: seluruh bagian dalam hull cembung (badan di bawah baju/rambut).
 * Piksel latar atau objek di bawahnya TIDAK pernah diisi, jadi tampilan akhir identik.
 */
export function extensionMask(
  rk: Int16Array,
  objOfRank: Int16Array,
  z: number,
  W: number,
  H: number,
  base: boolean,
  closeR: number,
  under = 0,
): Uint8Array {
  const N = W * H;
  const own = new Uint8Array(N);
  const above = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const r = rk[i];
    if (r < 0) continue;
    const zz = objOfRank[r];
    if (zz === z) own[i] = 1;
    else if (zz > z) above[i] = 1;
  }
  const ext = new Uint8Array(N);

  // (a) lubang tertutup yang hampir seluruhnya milik objek di atas
  const reach = new Uint8Array(N);
  const queue = new Int32Array(N);
  let n = 0;
  let head = 0;
  const push = (i: number) => {
    if (!own[i] && !reach[i]) {
      reach[i] = 1;
      queue[n++] = i;
    }
  };
  for (let x = 0; x < W; x++) {
    push(x);
    push((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    push(y * W);
    push(y * W + W - 1);
  }
  while (head < n) {
    const i = queue[head++];
    const x = i % W;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (i >= W) push(i - W);
    if (i < N - W) push(i + W);
  }
  const seen = new Uint8Array(N);
  for (let s = 0; s < N; s++) {
    if (own[s] || reach[s] || seen[s]) continue;
    let m = 0;
    let h2 = 0;
    let up = 0;
    queue[m++] = s;
    seen[s] = 1;
    while (h2 < m) {
      const i = queue[h2++];
      if (above[i]) up++;
      const x = i % W;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < N - W ? i + W : -1];
      for (const j of nb) if (j >= 0 && !own[j] && !seen[j]) {
        seen[j] = 1;
        queue[m++] = j;
      }
    }
    if (up >= 0.85 * m) for (let k = 0; k < m; k++) if (above[queue[k]]) ext[queue[k]] = 1;
  }

  // (b) penutupan morfologi
  if (closeR > 0) {
    const dil = dilate(own, W, H, closeR);
    const inv = new Uint8Array(N);
    for (let i = 0; i < N; i++) inv[i] = dil[i] ? 0 : 1;
    const er = dilate(inv, W, H, closeR);
    for (let i = 0; i < N; i++) if (!er[i] && above[i]) ext[i] = 1;
  }

  // (d) tumpang-bawah: siluet menyelip beberapa px ke bawah objek di atasnya sepanjang batas bersama,
  // sehingga tepi antar-objek tidak menyisakan celah tipis (latar mengintip)
  if (under > 0) {
    const dil = dilate(own, W, H, under);
    for (let i = 0; i < N; i++) if (dil[i] && above[i]) ext[i] = 1;
  }

  // (c) objek dasar: siluet menyeluruh sampai ke bawah objek lain
  if (base) {
    const filled = new Uint8Array(N);
    for (let i = 0; i < N; i++) filled[i] = own[i] | ext[i];
    const hull = hullMask(filled, W, H);
    for (let i = 0; i < N; i++) if (hull[i] && above[i]) ext[i] = 1;
  }
  return ext;
}
