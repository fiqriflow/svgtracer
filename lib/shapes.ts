/**
 * Deteksi bentuk bulat/lonjong pada masker hasil blur (1 kanal, gelap < 128 = isi).
 * Komponen yang cocok dengan elips dibuang dari buffer dan dikembalikan sebagai
 * parameter elips sempurna (lingkaran bila hampir bulat).
 */
export type Ellipse = { cx: number; cy: number; rx: number; ry: number; rot: number };

type Opts = {
  /** Luas minimum komponen (px resolusi upscale) */
  minArea: number;
  /** Rata-rata simpangan relatif tepi terhadap elips yang diizinkan */
  meanTol?: number;
  /** Simpangan relatif maksimum yang diizinkan */
  maxTol?: number;
};

export function snapEllipses(buf: Uint8Array, w: number, h: number, o: Opts): Ellipse[] {
  const meanTol = o.meanTol ?? 0.015;
  const maxTol = o.maxTol ?? 0.05;
  const N = w * h;
  const seen = new Uint8Array(N);
  const queue = new Int32Array(N);
  const found: Ellipse[] = [];

  for (let s = 0; s < N; s++) {
    if (seen[s] || buf[s] >= 128) continue;
    // flood fill 4-arah; queue[0..n) = piksel komponen
    let n = 0;
    queue[n++] = s;
    seen[s] = 1;
    let head = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    while (head < n) {
      const i = queue[head++];
      const x = i % w;
      const y = (i - x) / w;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && !seen[i - 1] && buf[i - 1] < 128) (seen[i - 1] = 1), (queue[n++] = i - 1);
      if (x < w - 1 && !seen[i + 1] && buf[i + 1] < 128) (seen[i + 1] = 1), (queue[n++] = i + 1);
      if (y > 0 && !seen[i - w] && buf[i - w] < 128) (seen[i - w] = 1), (queue[n++] = i - w);
      if (y < h - 1 && !seen[i + w] && buf[i + w] < 128) (seen[i + w] = 1), (queue[n++] = i + w);
    }
    if (n < o.minArea) continue;
    if (minX === 0 || minY === 0 || maxX === w - 1 || maxY === h - 1) continue; // terpotong tepi gambar

    const mx = sx / n;
    const my = sy / n;
    const ixx = sxx / n - mx * mx + 1 / 12;
    const iyy = syy / n - my * my + 1 / 12;
    const ixy = sxy / n - mx * my;
    const half = (ixx + iyy) / 2;
    const diff = Math.sqrt(((ixx - iyy) / 2) ** 2 + ixy * ixy);
    const l1 = half + diff;
    const l2 = half - diff;
    if (l2 <= 0) continue;
    let rx = 2 * Math.sqrt(l1);
    let ry = 2 * Math.sqrt(l2);
    if (ry < 3 || rx / ry > 8) continue;
    const th = 0.5 * Math.atan2(2 * ixy, ixx - iyy);
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    const cx = mx + 0.5;
    const cy = my + 0.5;

    // Seberapa dekat tepi komponen ke elips (pusat piksel tepi ~0,5 px di dalam tepi sebenarnya)
    const inner = 1 - 0.5 / Math.sqrt(rx * ry);
    let sum = 0;
    let max = 0;
    let nb = 0;
    for (let k = 0; k < n; k++) {
      const i = queue[k];
      const x = i % w;
      const y = (i - x) / w;
      if (buf[i - 1] < 128 && buf[i + 1] < 128 && buf[i - w] < 128 && buf[i + w] < 128) continue;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      const q = Math.sqrt((u / rx) ** 2 + (v / ry) ** 2);
      const d = Math.abs(q - inner);
      sum += d;
      if (d > max) max = d;
      nb++;
    }
    // Bentuk kecil: beri toleransi minimum dalam px (noise rasterisasi ~ +-1 px)
    const rr = Math.sqrt(rx * ry);
    if (!nb || sum / nb > Math.max(meanTol, 0.7 / rr) || max > Math.max(maxTol, 1.6 / rr)) continue;

    let rot = (th * 180) / Math.PI;
    if (rx / ry < 1 + Math.max(0.03, 1.2 / rr)) {
      // hampir bulat -> lingkaran sempurna
      rx = ry = Math.sqrt(rx * ry);
      rot = 0;
    }
    found.push({ cx, cy, rx, ry, rot });
    for (let k = 0; k < n; k++) buf[queue[k]] = 255;
  }
  return found;
}

const f = (v: number) => (Math.round(v * 100) / 100).toString();

export function ellipseTag(e: Ellipse, fill: string): string {
  if (e.rx === e.ry) return `<circle cx="${f(e.cx)}" cy="${f(e.cy)}" r="${f(e.rx)}" fill="${fill}"/>`;
  const t = Math.abs(e.rot) > 0.05 ? ` transform="rotate(${f(e.rot)} ${f(e.cx)} ${f(e.cy)})"` : "";
  return `<ellipse cx="${f(e.cx)}" cy="${f(e.cy)}" rx="${f(e.rx)}" ry="${f(e.ry)}" fill="${fill}"${t}/>`;
}
