/**
 * Deteksi bentuk bulat/lonjong pada masker hasil blur (1 kanal, gelap < 128 = isi).
 * Komponen yang cocok dengan elips dibuang dari buffer dan dikembalikan sebagai
 * parameter elips sempurna (lingkaran bila hampir bulat).
 */
export type Ellipse = { cx: number; cy: number; rx: number; ry: number; rot: number; /** true = kapsul (persegi panjang ujung bulat): rx = setengah panjang, ry = setengah lebar */ cap?: boolean };

type Opts = {
  /** Luas minimum komponen (px resolusi upscale) */
  minArea: number;
  /** Rata-rata simpangan relatif tepi terhadap elips yang diizinkan */
  meanTol?: number;
  /** Simpangan relatif maksimum yang diizinkan */
  maxTol?: number;
};

export function snapEllipses(buf: Uint8Array, w: number, h: number, o: Opts): Ellipse[] {
  const meanTol = o.meanTol ?? 0.012;
  const maxTol = o.maxTol ?? 0.04;
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
    if (ry < 8 || rx / ry > 4) continue; // jangan ubah serpihan tipis/kecil jadi elips
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
    if (!nb || sum / nb > Math.max(meanTol, 0.6 / rr) || max > Math.max(maxTol, 1.6 / rr)) {
      // Bukan elips: coba kapsul (mata pil, tombol, garis tebal ujung bulat)
      const cap = fitCapsule(queue, n, buf, w, cx, cy, cos, sin);
      if (cap) {
        found.push(cap);
        for (let k = 0; k < n; k++) buf[queue[k]] = 255;
      }
      continue;
    }

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


/** Cocokkan komponen dengan kapsul pada sumbu utama (cos, sin); null bila simpangan tepi terlalu besar */
function fitCapsule(q: Int32Array, n: number, buf: Uint8Array, w: number, cx: number, cy: number, cos: number, sin: number): Ellipse | null {
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (let k = 0; k < n; k++) {
    const x = q[k] % w;
    const y = (q[k] - x) / w;
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    const u = dx * cos + dy * sin;
    const v = -dx * sin + dy * cos;
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  const a = (uMax - uMin) / 2 + 0.5;
  const b = (vMax - vMin) / 2 + 0.5;
  if (b < 18 || a / b < 1.25) return null; // bentuk tipis: sudut tajam ikut membulat oleh blur, jangan dijadikan kapsul
  const ou = (uMax + uMin) / 2;
  const ov = (vMax + vMin) / 2;
  const seg = a - b;
  let sum = 0;
  let max = 0;
  let nb = 0;
  for (let k = 0; k < n; k++) {
    const i = q[k];
    if (buf[i - 1] < 128 && buf[i + 1] < 128 && buf[i - w] < 128 && buf[i + w] < 128) continue;
    const x = i % w;
    const y = (i - x) / w;
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    const u = dx * cos + dy * sin - ou;
    const v = -dx * sin + dy * cos - ov;
    const du = Math.max(0, Math.abs(u) - seg);
    const d = Math.abs(Math.hypot(du, v) - (b - 0.5));
    sum += d;
    if (d > max) max = d;
    nb++;
  }
  if (!nb || sum / nb > 1.2 + 0.02 * b || max > 3.5 + 0.06 * b) return null;
  // luas harus cocok dengan kapsul: persegi panjang ujung tajam (garis, logo) selisihnya > 2,5%
  const capArea = 4 * a * b - (4 - Math.PI) * b * b;
  if (Math.abs(n - capArea) / capArea > 0.025) return null;
  // pusat kapsul dalam koordinat gambar
  const px = cx + ou * cos - ov * sin;
  const py = cy + ou * sin + ov * cos;
  return { cx: px, cy: py, rx: a, ry: b, rot: (Math.atan2(sin, cos) * 180) / Math.PI, cap: true };
}

const f = (v: number) => (Math.round(v * 100) / 100).toString();

export function ellipseTag(e: Ellipse, fill: string): string {
  if (e.cap) {
    // sumbu utama hampir tegak/mendatar -> persegi panjang tanpa rotasi
    let rot = ((e.rot % 180) + 180) % 180;
    let hw = e.rx;
    let hh = e.ry;
    if (Math.abs(rot - 90) < 0.6) [hw, hh, rot] = [e.ry, e.rx, 0];
    else if (rot < 0.6 || rot > 179.4) rot = 0;
    else if (rot > 90) rot -= 180;
    const t = rot !== 0 ? ` transform="rotate(${f(rot)} ${f(e.cx)} ${f(e.cy)})"` : "";
    return `<rect x="${f(e.cx - hw)}" y="${f(e.cy - hh)}" width="${f(2 * hw)}" height="${f(2 * hh)}" rx="${f(Math.min(hw, hh))}" fill="${fill}"${t}/>`;
  }
  if (e.rx === e.ry) return `<circle cx="${f(e.cx)}" cy="${f(e.cy)}" r="${f(e.rx)}" fill="${fill}"/>`;
  const t = Math.abs(e.rot) > 0.05 ? ` transform="rotate(${f(e.rot)} ${f(e.cx)} ${f(e.cy)})"` : "";
  return `<ellipse cx="${f(e.cx)}" cy="${f(e.cy)}" rx="${f(e.rx)}" ry="${f(e.ry)}" fill="${fill}"${t}/>`;
}
