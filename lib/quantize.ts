/**
 * Median cut berbobot: pilih `k` warna dari piksel RGBA (piksel alpha < 128 diabaikan).
 * Kotak yang dipecah = yang paling "besar" (rentang warna x akar populasi),
 * supaya warna kecil tapi berbeda (pipi, lidah, dll) tetap dapat tempat.
 */
type Box = { bins: number[]; pop: number; range: number; axis: 0 | 1 | 2 };

const key5 = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

export function buildPalette(rgba: Uint8Array, channels: number, k: number): number[] {
  const hist = new Uint32Array(32768);
  for (let i = 0; i < rgba.length; i += channels) {
    if (channels === 4 && rgba[i + 3] < 128) continue;
    hist[key5(rgba[i], rgba[i + 1], rgba[i + 2])]++;
  }
  let total = 0;
  for (let i = 0; i < 32768; i++) total += hist[i];
  // Bin yang sangat langka (umumnya warna transisi anti-alias di tepi) tidak ikut membentuk palet
  const minPop = total * 0.0004;
  let all: number[] = [];
  for (let i = 0; i < 32768; i++) if (hist[i] >= minPop && hist[i] > 0) all.push(i);
  if (!all.length) for (let i = 0; i < 32768; i++) if (hist[i]) all.push(i);
  if (!all.length) return [];

  const comp = (bin: number, axis: number) => (axis === 0 ? bin >> 10 : axis === 1 ? (bin >> 5) & 31 : bin & 31);
  const makeBox = (bins: number[]): Box => {
    let pop = 0;
    const lo = [31, 31, 31];
    const hi = [0, 0, 0];
    for (const b of bins) {
      pop += hist[b];
      for (let a = 0; a < 3; a++) {
        const c = comp(b, a);
        if (c < lo[a]) lo[a] = c;
        if (c > hi[a]) hi[a] = c;
      }
    }
    const ranges = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const axis = (ranges[0] >= ranges[1] && ranges[0] >= ranges[2] ? 0 : ranges[1] >= ranges[2] ? 1 : 2) as 0 | 1 | 2;
    return { bins, pop, range: ranges[axis], axis };
  };

  const boxes: Box[] = [makeBox(all)];
  while (boxes.length < k) {
    let best = -1;
    let bestScore = 0;
    boxes.forEach((b, i) => {
      // jangan pecah kotak yang warnanya sudah rapat (< 2 satuan 5-bit ~ 16 level)
      if (b.bins.length < 2 || b.range < 2) return;
      const score = Math.sqrt(b.pop) * b.range;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best < 0) break;
    const b = boxes[best];
    const sorted = [...b.bins].sort((x, y) => comp(x, b.axis) - comp(y, b.axis));
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < sorted.length; i++) {
      acc += hist[sorted[i]];
      if (acc >= b.pop / 2) {
        cut = Math.min(sorted.length - 1, Math.max(1, i + 1));
        break;
      }
    }
    boxes.splice(best, 1, makeBox(sorted.slice(0, cut)), makeBox(sorted.slice(cut)));
  }

  // Warna rata-rata berbobot tiap kotak (dari bin 5-bit, dipulihkan ke 8-bit)
  return boxes.map((b) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    for (const bin of b.bins) {
      const n = hist[bin];
      r += (bin >> 10) * n;
      g += ((bin >> 5) & 31) * n;
      bl += (bin & 31) * n;
    }
    const to8 = (v: number) => Math.min(255, Math.round((v / b.pop) * 8 + 4));
    return (to8(r) << 16) | (to8(g) << 8) | to8(bl);
  });
}

/** Seberapa "datar" gambar ini: porsi piksel yang tercakup 16 warna dominan (0-1) */
export function flatness(rgba: Uint8Array, channels: number): number {
  const h = new Map<number, number>();
  let total = 0;
  for (let i = 0; i < rgba.length; i += channels) {
    if (channels === 4 && rgba[i + 3] < 128) continue;
    const k = ((rgba[i] >> 4) << 8) | ((rgba[i + 1] >> 4) << 4) | (rgba[i + 2] >> 4);
    h.set(k, (h.get(k) ?? 0) + 1);
    total++;
  }
  if (!total) return 0;
  const top = [...h.values()].sort((a, b) => b - a).slice(0, 16);
  return top.reduce((a, b) => a + b, 0) / total;
}

/** Peta tiap piksel ke indeks palet terdekat (-1 = transparan) */
export function assignPalette(rgba: Uint8Array, channels: number, palette: number[]): Int16Array {
  const n = rgba.length / channels;
  const out = new Int16Array(n);
  const cache = new Int16Array(32768).fill(-2);
  const pr = palette.map((c) => c >> 16);
  const pg = palette.map((c) => (c >> 8) & 255);
  const pb = palette.map((c) => c & 255);
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    if (channels === 4 && rgba[o + 3] < 128) {
      out[i] = -1;
      continue;
    }
    const kk = key5(rgba[o], rgba[o + 1], rgba[o + 2]);
    let idx = cache[kk];
    if (idx === -2) {
      let bestD = Infinity;
      idx = 0;
      for (let p = 0; p < palette.length; p++) {
        const dr = rgba[o] - pr[p];
        const dg = rgba[o + 1] - pg[p];
        const db = rgba[o + 2] - pb[p];
        const d = dr * dr * 3 + dg * dg * 4 + db * db * 2; // bobot persepsi kasar
        if (d < bestD) {
          bestD = d;
          idx = p;
        }
      }
      cache[kk] = idx;
    }
    out[i] = idx;
  }
  return out;
}

export type SoftMap = {
  /** Indeks palet utama */
  a: Int16Array;
  /** Indeks palet kedua (warna di seberang tepi) */
  b: Int16Array;
  /** Bobot warna b, 0-255 (0 = murni a) */
  w: Uint8Array;
};

/**
 * Penugasan lembut: tiap piksel = campuran 2 warna palet (a, b) dengan bobot.
 * Piksel anti-alias di tepi membawa posisi tepi sub-piksel, jadi kontur tidak bergerigi.
 *
 * Pasangan warna untuk piksel tepi dipilih dari warna piksel MURNI di sekitarnya (5x5),
 * bukan dari palet global: warna antara yang kebetulan ada di palet (mis. cokelat telinga
 * yang terletak di antara hitam dan cokelat wajah) tidak boleh mengacaukan tepi.
 */
export function softAssign(rgba: Uint8Array, channels: number, palette: number[], width: number, height: number): SoftMap {
  const n = rgba.length / channels;
  const K = palette.length;
  const pr = palette.map((c) => c >> 16);
  const pg = palette.map((c) => (c >> 8) & 255);
  const pb = palette.map((c) => c & 255);
  const a = new Int16Array(n);
  const b = new Int16Array(n);
  const w = new Uint8Array(n);
  const pure = new Uint8Array(n);
  const PURE_D2 = 196; // piksel dianggap murni bila <= ~14 level dari warna palet

  // Pass 1: warna palet terdekat (cache 7-bit per kanal)
  const SZ = 1 << 21;
  const cA = new Int16Array(SZ).fill(-1);
  const cD = new Float32Array(SZ);
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    const r = rgba[o];
    const g = rgba[o + 1];
    const bl = rgba[o + 2];
    const key = ((r >> 1) << 14) | ((g >> 1) << 7) | (bl >> 1);
    if (cA[key] < 0) {
      let best = 0;
      let bd = Infinity;
      for (let p = 0; p < K; p++) {
        const dr = r - pr[p];
        const dg = g - pg[p];
        const db = bl - pb[p];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      cA[key] = best;
      cD[key] = bd;
    }
    a[i] = cA[key];
    b[i] = cA[key];
    if (cD[key] <= PURE_D2 && !(channels === 4 && rgba[o + 3] < 128)) pure[i] = 1;
  }

  // Pass 1.5: buang "pinggiran" anti-alias. Piksel di tepi dua warna besar (mis. bingkai gelap vs
  // cokelat) kadang kebetulan dekat warna palet ketiga (hidung, telinga) lalu dianggap murni dan
  // membentuk serpihan tipis di sepanjang tepi. Bila warna piksel terletak pada garis antara dua
  // kelas murni lain di sekitarnya (5x5), perlakukan sebagai campuran, bukan warna murni.
  const fringe = new Uint8Array(n);
  {
    const base = pure.slice();
    const c2 = new Int32Array(5);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!base[i]) continue;
        const c = a[i];
        if (
          x > 0 && x < width - 1 && y > 0 && y < height - 1 &&
          a[i - 1] === c && a[i + 1] === c && a[i - width] === c && a[i + width] === c
        ) continue; // interior
        let m2 = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const j = yy * width + xx;
            if (!base[j]) continue;
            const cj = a[j];
            if (cj === c) continue;
            let seen = false;
            for (let k = 0; k < m2; k++) if (c2[k] === cj) seen = true;
            if (!seen && m2 < 5) c2[m2++] = cj;
          }
        }
        if (m2 < 2) continue;
        const o = i * channels;
        const r = rgba[o];
        const g = rgba[o + 1];
        const bl = rgba[o + 2];
        let hit = false;
        for (let u = 0; u < m2 && !hit; u++) {
          for (let v = u + 1; v < m2 && !hit; v++) {
            const A = c2[u];
            const B = c2[v];
            const vx = pr[B] - pr[A];
            const vy = pg[B] - pg[A];
            const vz = pb[B] - pb[A];
            const vv = vx * vx + vy * vy + vz * vz;
            if (vv === 0) continue;
            const t = ((r - pr[A]) * vx + (g - pg[A]) * vy + (bl - pb[A]) * vz) / vv;
            if (t < 0.08 || t > 0.92) continue;
            const ex = r - (pr[A] + t * vx);
            const ey = g - (pg[A] + t * vy);
            const ez = bl - (pb[A] + t * vz);
            if (ex * ex + ey * ey + ez * ez <= 144) hit = true;
          }
        }
        if (hit) {
          pure[i] = 0;
          fringe[i] = 1;
        }
      }
    }
  }

  // Pass 2: piksel tepi -> pasangan terbaik dari kelas piksel murni di sekitarnya
  const cls = new Int32Array(6);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (pure[i]) continue;
      const o = i * channels;
      const r = rgba[o];
      const g = rgba[o + 1];
      const bl = rgba[o + 2];
      let m = 0;
      // Cari kelas piksel murni di sekitar; perbesar jendela (2 -> 4 -> 7) sampai ada >= 2 kelas
      for (const R of [2, 4, 7]) {
        m = 0;
        for (let dy = -R; dy <= R; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -R; dx <= R; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const j = yy * width + xx;
            if (!pure[j]) continue;
            const c = a[j];
            if (fringe[i] && c === a[i]) continue; // pinggiran: jangan berpasangan dengan kelasnya sendiri
            let seen = false;
            for (let k = 0; k < m; k++) if (cls[k] === c) seen = true;
            if (!seen && m < 6) cls[m++] = c;
          }
        }
        if (m >= 2) break;
      }
      let bestA = a[i];
      let bestB = a[i];
      let bestW = 0;
      let bestPerp = Infinity;
      if (m >= 2) {
        for (let u = 0; u < m; u++) {
          for (let v = 0; v < m; v++) {
            if (u === v) continue;
            const A = cls[u];
            const B = cls[v];
            const vx = pr[B] - pr[A];
            const vy = pg[B] - pg[A];
            const vz = pb[B] - pb[A];
            const vv = vx * vx + vy * vy + vz * vz;
            if (vv === 0) continue;
            const t = ((r - pr[A]) * vx + (g - pg[A]) * vy + (bl - pb[A]) * vz) / vv;
            if (t < -0.05 || t > 1.05) continue;
            const tc = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = r - (pr[A] + tc * vx);
            const ey = g - (pg[A] + tc * vy);
            const ez = bl - (pb[A] + tc * vz);
            const perp = ex * ex + ey * ey + ez * ez;
            if (perp < bestPerp) {
              bestPerp = perp;
              bestA = A;
              bestB = B;
              bestW = Math.round(tc * 255);
            }
          }
        }
      }
      if (bestPerp === Infinity) {
        // Tidak ada pasangan lokal: pakai palet global bila cukup dekat (<= ~30 level),
        // kalau tidak, kelas murni lokal terdekat
        let bd2 = Infinity;
        bestA = a[i];
        const gd = (r - pr[a[i]]) ** 2 + (g - pg[a[i]]) ** 2 + (bl - pb[a[i]]) ** 2;
        if (gd <= 900) m = 0;
        for (let u = 0; u < m; u++) {
          const A = cls[u];
          const dr = r - pr[A];
          const dg = g - pg[A];
          const db = bl - pb[A];
          const d = dr * dr + dg * dg + db * db;
          if (d < bd2) {
            bd2 = d;
            bestA = A;
          }
        }
        bestB = bestA;
        bestW = 0;
      }
      a[i] = bestA;
      b[i] = bestB;
      w[i] = bestW;
    }
  }
  return { a, b, w };
}

/**
 * Haluskan palet ke rata-rata piksel ASLI (Lloyd/k-means 1-3 putaran).
 * Palet median-cut berasal dari bin 5-bit (galat hingga +-4 level); di sini tiap warna
 * dihitung ulang dari piksel interior (jarak <= maxD dari warnanya) sehingga tepat.
 */
export function refinePalette(rgba: Uint8Array, channels: number, palette: number[], iters = 3, maxD = 28): number[] {
  let pal = palette.slice();
  const maxD2 = maxD * maxD;
  for (let it = 0; it < iters; it++) {
    const ids = assignPalette(rgba, channels, pal);
    const sr = new Float64Array(pal.length);
    const sg = new Float64Array(pal.length);
    const sb = new Float64Array(pal.length);
    const n = new Float64Array(pal.length);
    for (let i = 0; i < ids.length; i++) {
      const k = ids[i];
      if (k < 0) continue;
      const o = i * channels;
      const dr = rgba[o] - (pal[k] >> 16);
      const dg = rgba[o + 1] - ((pal[k] >> 8) & 255);
      const db = rgba[o + 2] - (pal[k] & 255);
      if (dr * dr + dg * dg + db * db > maxD2) continue;
      sr[k] += rgba[o];
      sg[k] += rgba[o + 1];
      sb[k] += rgba[o + 2];
      n[k]++;
    }
    let moved = 0;
    pal = pal.map((c, k) => {
      if (n[k] < 20) return c;
      const r = Math.round(sr[k] / n[k]);
      const g = Math.round(sg[k] / n[k]);
      const b = Math.round(sb[k] / n[k]);
      const nc = (r << 16) | (g << 8) | b;
      if (nc !== c) moved++;
      return nc;
    });
    if (!moved) break;
  }
  return pal;
}
