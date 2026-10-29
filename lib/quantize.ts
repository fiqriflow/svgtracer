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
      // jangan pecah kotak yang warnanya sudah rapat (>= 3 satuan 5-bit ~ 24 level)
      if (b.bins.length < 2 || b.range < 3) return;
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
