import sharp from "sharp";
import { Potrace } from "potrace";
import { assignPalette, buildPalette, refinePalette, softAssign } from "./quantize";
import { edgeSmooth } from "./denoise";
import { ellipseTag, snapEllipses } from "./shapes";
import { simplifyTag } from "./simplify";
import { traceField } from "./curvefit";

export type LayeredOptions = {
  /** Jumlah warna palet (mode warna) */
  colors: number;
  /** Skala upscale sebelum tracing */
  scale: number;
  /** Sigma blur medan tepi, dalam px GAMBAR ASLI: makin besar makin halus */
  blur: number;
  /** Buang bentuk kecil (luas px pada resolusi upscale) */
  turd: number;
  /** Toleransi optimasi kurva Potrace */
  opt: number;
  /** Batas sudut Potrace (makin besar makin mulus, sudut makin bulat) */
  alphaMax?: number;
  /** Ubah bentuk yang hampir bulat/lonjong jadi lingkaran/elips sempurna */
  snap?: boolean;
  /** Hapus derau JPEG/gradasi lembut dengan penghalus yang menjaga tepi (default aktif) */
  denoise?: boolean;
  /** Warna palet yang jaraknya (RGB) kurang dari ini digabung jadi satu (default 12) */
  mergeDist?: number;
  /** Lebar kerah (px gambar asli): lapisan hanya menyelip ke bawah warna atas sejauh ini, sehingga tepi tidak berpinggiran warna lapisan lain. 0 = mati */
  collar?: number;
  /** Buang pulau kelas warna lebih kecil dari ini (px gambar asli) sebelum tracing: bercak di gradasi lembut/JPEG. 0 = mati */
  cleanArea?: number;
  /** Pelacak kurva: "own" (Bezier sendiri, default) atau "potrace" */
  tracer?: "own" | "potrace";
  /** Galat kurva maksimum (px medan) untuk tracer sendiri */
  fitErr?: number;
  /** Radius opening morfologi antar warna mirip (px asli, 0 = mati); butuh closeSmooth > 0 */
  openClose?: number;
  /** Lintasan filter mayoritas antar warna mirip (0 = mati) */
  closeSmooth?: number;
  /** Lintasan penghalusan kontur pada tracer sendiri */
  curveSmooth?: number;
  /** Sudut belok minimal (derajat) untuk sudut tajam pada tracer sendiri */
  corner?: number;
  /** Toleransi warna penghalus penjaga tepi (default 28). Lebih kecil = bentuk kecil berkontras rendah (pipi, bayangan) lebih terjaga */
  denoiseTol?: number;
  /** Toleransi penyederhanaan kurva (px resolusi upscale): gabung segmen mulus, buang gelombang/simpul berlebih. 0 = mati */
  fit?: number;
};

const loadTrace = (buf: Buffer, params: Record<string, unknown>) =>
  new Promise<Potrace>((resolve, reject) => {
    const p = new Potrace(params);
    p.loadImage(buf, (e) => (e ? reject(e) : resolve(p)));
  });

/** Putih/hitam nyaris murni (sisa derau JPEG) -> #ffffff / #000000 persis */
const snapNeutral = (c: number) => {
  const r = c >> 16;
  const g = (c >> 8) & 255;
  const b = c & 255;
  if (Math.max(r, g, b) - Math.min(r, g, b) > 10) return c;
  const m = (r + g + b) / 3;
  return m >= 243 ? 0xffffff : m <= 12 ? 0x000000 : c;
};

/** Dilasi persegi radius r pada masker biner (O(N), dua lintasan dengan jumlah prefiks) */
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

/**
 * Tambahkan ke `near` semua "pulau" piksel berperingkat > r yang hampir seluruh tepinya
 * berbatasan dengan peringkat r (mis. highlight putih di dalam mata): pulau itu harus
 * ikut terisi di lapisan r supaya mata tidak berlubang.
 */
function addEnclosedIslands(rk: Int16Array, W: number, H: number, r: number, near: Uint8Array): void {
  const N = W * H;
  const seen = new Uint8Array(N);
  const queue = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (seen[s] || rk[s] <= r) continue;
    let n = 0;
    let head = 0;
    let border = 0;
    let same = 0;
    queue[n++] = s;
    seen[s] = 1;
    while (head < n) {
      const i = queue[head++];
      const x = i % W;
      const y = (i - x) / W;
      for (let d = 0; d < 4; d++) {
        const nx = d === 0 ? x - 1 : d === 1 ? x + 1 : x;
        const ny = d === 2 ? y - 1 : d === 3 ? y + 1 : y;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) {
          border++;
          continue;
        }
        const j = ny * W + nx;
        if (rk[j] > r) {
          if (!seen[j]) {
            seen[j] = 1;
            queue[n++] = j;
          }
        } else {
          border++;
          if (rk[j] === r) same++;
        }
      }
    }
    if (border > 0 && same / border >= 0.9) for (let k = 0; k < n; k++) near[queue[k]] = 1;
  }
}

/**
 * Buang pulau kecil pada peta kelas warna: tiap komponen (4-tetangga) berluas < minArea diberi
 * kelas tetangga terdekat dalam warna, dan pikselnya diganti warna palet kelas itu.
 * Ini menghilangkan bercak yang timbul saat nilai piksel gradasi lembut/JPEG berayun di
 * sekitar batas dua warna palet yang mirip.
 */
function cleanSpeckles(px: Uint8Array, ch: number, ids: Int16Array, palette: number[], W: number, H: number, minArea: number, minAreaClose = 0): void {
  if (minArea <= 1) return;
  const closeTo = (a: number, b: number) => {
    const c = palette[a];
    const d = palette[b];
    return Math.hypot((c >> 16) - (d >> 16), ((c >> 8) & 255) - ((d >> 8) & 255), (c & 255) - (d & 255)) < 24;
  };
  const N = W * H;
  const lab = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  const small: number[] = [];
  let nComp = 0;
  const isSmall: boolean[] = [];
  for (let s = 0; s < N; s++) {
    if (lab[s] >= 0 || ids[s] < 0) continue;
    const id = ids[s];
    let n = 0;
    let head = 0;
    queue[n++] = s;
    lab[s] = nComp;
    while (head < n) {
      const i = queue[head++];
      const x = i % W;
      if (x > 0 && lab[i - 1] < 0 && ids[i - 1] === id) ((lab[i - 1] = nComp), (queue[n++] = i - 1));
      if (x < W - 1 && lab[i + 1] < 0 && ids[i + 1] === id) ((lab[i + 1] = nComp), (queue[n++] = i + 1));
      if (i >= W && lab[i - W] < 0 && ids[i - W] === id) ((lab[i - W] = nComp), (queue[n++] = i - W));
      if (i + W < N && lab[i + W] < 0 && ids[i + W] === id) ((lab[i + W] = nComp), (queue[n++] = i + W));
    }
    let sm = n < minArea;
    if (!sm && n < minAreaClose) {
      // Pulau lebih besar tetap dibuang bila hampir seluruh tepinya berbatasan dengan warna yang mirip
      let tot = 0;
      let cl = 0;
      for (let k = 0; k < n; k++) {
        const i = queue[k];
        const x = i % W;
        const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i + W < N ? i + W : -1];
        for (const j of nb) {
          if (j < 0 || ids[j] < 0 || ids[j] === id) continue;
          tot++;
          if (closeTo(id, ids[j])) cl++;
        }
      }
      sm = tot > 0 && cl / tot >= 0.6;
    }
    isSmall.push(sm);
    if (sm) for (let k = 0; k < n; k++) small.push(queue[k]);
    nComp++;
  }
  if (!small.length) return;
  const newId = new Int16Array(small.length);
  for (let k = 0; k < small.length; k++) {
    const i = small[k];
    const x = i % W;
    const y = (i - x) / W;
    const o = i * ch;
    let best = -1;
    let bd = Infinity;
    for (let R = 2; R <= 8 && best < 0; R += 3) {
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if (ids[j] < 0 || isSmall[lab[j]]) continue;
          const c = palette[ids[j]];
          const dr = px[o] - (c >> 16);
          const dg = px[o + 1] - ((c >> 8) & 255);
          const db = px[o + 2] - (c & 255);
          const d = dr * dr + dg * dg + db * db;
          if (d < bd) {
            bd = d;
            best = ids[j];
          }
        }
      }
    }
    newId[k] = best;
  }
  for (let k = 0; k < small.length; k++) {
    if (newId[k] < 0) continue;
    const i = small[k];
    ids[i] = newId[k];
    const c = palette[newId[k]];
    px[i * ch] = c >> 16;
    px[i * ch + 1] = (c >> 8) & 255;
    px[i * ch + 2] = c & 255;
  }
}

/**
 * Filter mayoritas untuk kelas warna yang MIRIP (jarak < closeDist): batas antar dua warna
 * yang nyaris sama (gradasi lembut/JPEG) ditentukan oleh suara tetangga sehingga menjadi satu
 * tepi bersih, bukan bercak. Batas warna yang kontras tidak disentuh.
 */
function smoothCloseClasses(px: Uint8Array, ch: number, ids: Int16Array, palette: number[], W: number, H: number, radius: number, closeDist: number, passes: number): void {
  const K = palette.length;
  const close: boolean[][] = palette.map((c, i) =>
    palette.map((d, j) => i === j || Math.hypot((c >> 16) - (d >> 16), ((c >> 8) & 255) - ((d >> 8) & 255), (c & 255) - (d & 255)) < closeDist),
  );
  for (let pass = 0; pass < passes; pass++) {
    const next = ids.slice();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const c = ids[i];
        if (c < 0) continue;
        // hanya di dekat batas: salah satu tetangga 4-arah berbeda kelas tetapi masih "mirip"
        const l = x > 0 ? ids[i - 1] : c;
        const r = x < W - 1 ? ids[i + 1] : c;
        const u = y > 0 ? ids[i - W] : c;
        const d = y < H - 1 ? ids[i + W] : c;
        const diff = (l !== c && l >= 0 && close[c][l]) || (r !== c && r >= 0 && close[c][r]) || (u !== c && u >= 0 && close[c][u]) || (d !== c && d >= 0 && close[c][d]);
        if (!diff) continue;
        // Rata-rata warna piksel berkelas mirip di sekitar -> kelas mirip terdekat dengan rata-rata itu.
        // Zona gradasi yang jatuh di antara dua warna palet jadi satu keputusan yang stabil.
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let cnt = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            const j = yy * W + xx;
            const k = ids[j];
            if (k >= 0 && close[c][k]) {
              sr += px[j * ch];
              sg += px[j * ch + 1];
              sb += px[j * ch + 2];
              cnt++;
            }
          }
        }
        let best = c;
        if (cnt > 0) {
          sr /= cnt;
          sg /= cnt;
          sb /= cnt;
          let bd = Infinity;
          for (let k = 0; k < K; k++) {
            if (!close[c][k]) continue;
            const col = palette[k];
            const er = sr - (col >> 16);
            const eg = sg - ((col >> 8) & 255);
            const eb = sb - (col & 255);
            const e = er * er + eg * eg + eb * eb;
            if (e < bd) {
              bd = e;
              best = k;
            }
          }
        }
        if (best !== c) next[i] = best;
      }
    }
    for (let i = 0; i < ids.length; i++) {
      if (next[i] !== ids[i]) {
        ids[i] = next[i];
        const c = palette[next[i]];
        px[i * ch] = c >> 16;
        px[i * ch + 1] = (c >> 8) & 255;
        px[i * ch + 2] = c & 255;
      }
    }
  }
}

/**
 * Opening morfologi (kikis lalu kembangkan, radius r) pada tiap kelas yang punya kelas MIRIP:
 * benjolan/leher sempit/tonjolan tipis yang menempel ke area lain terpotong dan diberikan ke
 * kelas mirip terdekat. Fitur tipis berkontras tinggi (garis, kacamata) tidak tersentuh
 * karena hanya dipindah bila pengganti terdekat berwarna mirip.
 */
function openCloseClasses(px: Uint8Array, ch: number, ids: Int16Array, palette: number[], W: number, H: number, r: number): void {
  if (r <= 0) return;
  const N = W * H;
  const K = palette.length;
  const dist = (a: number, b: number) => {
    const c = palette[a];
    const d = palette[b];
    return Math.hypot((c >> 16) - (d >> 16), ((c >> 8) & 255) - ((d >> 8) & 255), (c & 255) - (d & 255));
  };
  const removed: number[] = [];
  for (let c = 0; c < K; c++) {
    let hasClose = false;
    for (let k = 0; k < K; k++) if (k !== c && dist(c, k) < 32) hasClose = true;
    if (!hasClose) continue;
    const m = new Uint8Array(N);
    const inv = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (ids[i] === c) m[i] = 1;
      else inv[i] = 1;
    }
    const grown = dilate(inv, W, H, r); // piksel dalam jarak r dari bukan-c
    const eroded = new Uint8Array(N);
    for (let i = 0; i < N; i++) eroded[i] = m[i] && !grown[i] ? 1 : 0;
    const opened = dilate(eroded, W, H, r);
    for (let i = 0; i < N; i++) if (m[i] && !opened[i]) removed.push(i * K + c);
  }
  const newId = new Int16Array(removed.length).fill(-1);
  for (let q = 0; q < removed.length; q++) {
    const c = removed[q] % K;
    const i = (removed[q] - c) / K;
    const x = i % W;
    const y = (i - x) / W;
    const o = i * ch;
    let best = -1;
    let bd = Infinity;
    for (let dy = -(r + 2); dy <= r + 2; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -(r + 2); dx <= r + 2; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        const k = ids[yy * W + xx];
        if (k < 0 || k === c || dist(c, k) >= 32) continue;
        const col = palette[k];
        const er = px[o] - (col >> 16);
        const eg = px[o + 1] - ((col >> 8) & 255);
        const eb = px[o + 2] - (col & 255);
        const e = er * er + eg * eg + eb * eb;
        if (e < bd) {
          bd = e;
          best = k;
        }
      }
    }
    newId[q] = best;
  }
  for (let q = 0; q < removed.length; q++) {
    if (newId[q] < 0) continue;
    const c = removed[q] % K;
    const i = (removed[q] - c) / K;
    ids[i] = newId[q];
    const col = palette[newId[q]];
    px[i * ch] = col >> 16;
    px[i * ch + 1] = (col >> 8) & 255;
    px[i * ch + 2] = col & 255;
  }
}

const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");

/**
 * Trace berlapis dengan tepi sub-piksel:
 * 1. palet + peringkat warna dihitung di resolusi ASLI
 * 2. tiap piksel = campuran 2 warna palet (softAssign), sehingga anti-alias
 *    di tepi tetap membawa posisi tepi yang akurat
 * 3. tiap lapisan = medan cakupan 0-255 -> upscale kubik -> blur halus -> Potrace
 * Hasilnya: tepi mulus tanpa gerigi / goyang, sudut dan detail kecil tetap tajam.
 */
export async function traceLayered(input: Buffer, o: LayeredOptions): Promise<string> {
  const meta = await sharp(input).metadata();
  const W0 = meta.width ?? 0;
  const H0 = meta.height ?? 0;
  if (!W0 || !H0) throw new Error("Gambar tidak valid.");
  const w = Math.round(W0 * o.scale);
  const h = Math.round(H0 * o.scale);
  const N0 = W0 * H0;

  // Denoise ringan: menghilangkan derau halus yang memecah area datar jadi bintik
  const clean = await sharp(input).ensureAlpha().median(3).png().toBuffer();
  const orig = await sharp(clean).raw().toBuffer({ resolveWithObject: true });
  const ch = orig.info.channels;
  // Penghalus penjaga tepi: derau JPEG & gradasi lembut hilang, tepi tetap tajam
  const px = o.denoise === false ? orig.data : edgeSmooth(orig.data, ch, W0, H0, { radius: 2, tol: o.denoiseTol ?? 28, passes: 2 });
  const palette = refinePalette(px, ch, buildPalette(px, ch, o.colors));
  if (!palette.length) throw new Error("Gambar kosong.");
  let ids = assignPalette(px, ch, palette);

  // Buang warna transisi anti-alias: hampir semua pikselnya berada di batas dua area
  for (let pass = 0; pass < 2 && palette.length > 2; pass++) {
    const total = new Array<number>(palette.length).fill(0);
    const edge = new Array<number>(palette.length).fill(0);
    for (let y = 1; y < H0 - 1; y++) {
      for (let x = 1; x < W0 - 1; x++) {
        const i = y * W0 + x;
        const id = ids[i];
        if (id < 0) continue;
        total[id]++;
        if (ids[i - 1] !== id || ids[i + 1] !== id || ids[i - W0] !== id || ids[i + W0] !== id) edge[id]++;
      }
    }
    const keep = palette.filter((_, k) => total[k] === 0 || edge[k] / total[k] < 0.5);
    if (keep.length === palette.length || keep.length < 2) break;
    palette.length = 0;
    palette.push(...keep);
    ids = assignPalette(px, ch, palette);
  }

  // Gabungkan warna yang nyaris sama (nuansa kulit/langit): mencegah tepi bercak di gradasi lembut
  const md2 = (o.mergeDist ?? 12) ** 2;
  if (md2 > 0 && palette.length > 2) {
    const cnt = new Array<number>(palette.length).fill(0);
    for (let i = 0; i < N0; i++) if (ids[i] >= 0) cnt[ids[i]]++;
    const bySize = palette.map((_, i) => i).sort((a, b) => cnt[b] - cnt[a]);
    const keep: number[] = [];
    for (const i of bySize) {
      const c = palette[i];
      const near = keep.some((k) => {
        const dr = (c >> 16) - (k >> 16);
        const dg = ((c >> 8) & 255) - ((k >> 8) & 255);
        const db = (c & 255) - (k & 255);
        return dr * dr + dg * dg + db * db < md2;
      });
      if (!near) keep.push(c);
    }
    if (keep.length < palette.length) {
      palette.length = 0;
      palette.push(...keep);
      ids = assignPalette(px, ch, palette);
    }
  }

  // Setelah penggabungan: hitung ulang warna ke rata-rata piksel sebenarnya
  const refined = refinePalette(px, ch, palette);
  palette.length = 0;
  palette.push(...refined.map(snapNeutral));
  ids = assignPalette(px, ch, palette);

  // Luas pembersihan diskalakan dengan ukuran gambar (dasar = 250 ribu piksel)
  const cleanArea = Math.round((o.cleanArea ?? 0) * Math.max(1, Math.sqrt(N0 / 250000)));
  cleanSpeckles(px, ch, ids, palette, W0, H0, cleanArea);
  if ((o.closeSmooth ?? 0) > 0) {
    smoothCloseClasses(px, ch, ids, palette, W0, H0, Math.max(3, Math.round(Math.max(W0, H0) / 300)), 24, o.closeSmooth ?? 0);
    cleanSpeckles(px, ch, ids, palette, W0, H0, cleanArea, cleanArea * 12);
    openCloseClasses(px, ch, ids, palette, W0, H0, Math.round(o.openClose ?? 0));
  }

  // Urutkan dari area terbesar (lapisan paling bawah); indeks palet = peringkat
  const counts = new Array<number>(palette.length).fill(0);
  for (let i = 0; i < N0; i++) if (ids[i] >= 0) counts[ids[i]]++;
  const edgeF = new Array<number>(palette.length).fill(0);
  for (let y = 1; y < H0 - 1; y++) {
    for (let x = 1; x < W0 - 1; x++) {
      const i = y * W0 + x;
      const id = ids[i];
      if (id >= 0 && (ids[i - 1] !== id || ids[i + 1] !== id || ids[i - W0] !== id || ids[i + W0] !== id)) edgeF[id]++;
    }
  }
  for (let k = 0; k < palette.length; k++) edgeF[k] = counts[k] ? edgeF[k] / counts[k] : 0;
  // Urutan tumpukan (bawah -> atas): 1) warna besar (latar, kulit, baju) urut area; 2) warna kecil
  // berkontras rendah (blush/bayangan lembut); 3) detail kecil yang tegas (mata, kacamata, logo).
  // Warna besar WAJIB di dasar: kalau tidak, layer di atasnya berlubang di batas dan latar mengintip
  // sebagai garis tipis. Blush tetap di bawah mata/kacamata sehingga tidak menimpanya.
  const minDist = palette.map((c, i) => {
    let m = Infinity;
    palette.forEach((d, j) => {
      if (i === j) return;
      m = Math.min(m, Math.hypot((c >> 16) - (d >> 16), ((c >> 8) & 255) - ((d >> 8) & 255), (c & 255) - (d & 255)));
    });
    return m;
  });
  const group = (i: number) => (counts[i] >= N0 * 0.02 ? 0 : minDist[i] < 45 ? 1 : 2);
  const order = palette
    .map((_, i) => i)
    .sort((a, b) => group(a) - group(b) || counts[b] - counts[a]);
  const ranked = order.map((i) => palette[i]);
  const soft = softAssign(px, ch, ranked, W0, H0);
  const cover = new Uint8Array(N0); // alpha asli 0-255
  for (let i = 0; i < N0; i++) cover[i] = ch === 4 ? orig.data[i * ch + 3] : 255;

  // Peringkat murni tiap piksel (untuk kerah lapisan)
  const collar = Math.round(o.collar ?? 0);
  const rk = new Int16Array(N0);
  for (let i = 0; i < N0; i++) rk[i] = cover[i] < 128 ? -1 : soft.w[i] < 128 ? soft.a[i] : soft.b[i];

  const sigma = Math.max(0.3, o.blur * o.scale);
  const field = Buffer.allocUnsafe(N0);
  let paths = "";
  for (let r = 0; r < ranked.length; r++) {
    // Lapisan r = cakupan semua warna dengan peringkat >= r (tanpa celah antar warna)
    // Potrace: gelap (0) = isi, jadi medan dibalik
    // Lapisan r (kecuali dasar) hanya mencakup piksel peringkat lebih tinggi yang berada dalam
    // kerah di sekitar warna r sendiri; di tempat lain lapisan bawah yang tampak adalah tetangga asli
    let near: Uint8Array | null = null;
    if (collar > 0 && r > 0) {
      const own = new Uint8Array(N0);
      for (let i = 0; i < N0; i++) if (rk[i] === r) own[i] = 1;
      near = dilate(own, W0, H0, collar);
      addEnclosedIslands(rk, W0, H0, r, near);
    }
    let count = 0;
    for (let i = 0; i < N0; i++) {
      const wb = soft.w[i];
      let f = (((soft.a[i] >= r ? 255 - wb : 0) + (soft.b[i] >= r ? wb : 0)) * cover[i]) / 255;
      if (near && !near[i]) f = 0;
      if (f >= 128) count++;
      field[i] = 255 - Math.round(f);
    }
    if (count * o.scale * o.scale <= o.turd) continue;
    const big = await sharp(field, { raw: { width: W0, height: H0, channels: 1 } })
      .resize(w, h, { kernel: "cubic" })
      .toColourspace("b-w") // paksa 1 kanal (default sharp: 3 kanal)
      .raw()
      .toBuffer();
    const blurred = await sharp(big, { raw: { width: w, height: h, channels: 1 } })
      .blur(sigma)
      .toColourspace("b-w")
      .raw()
      .toBuffer();
    const color = hex(ranked[r]);
    // Bentuk bulat/lonjong -> elips sempurna; sisanya lewat Potrace
    const shapes = o.snap ? snapEllipses(blurred, w, h, { minArea: 20 * o.scale * o.scale }) : [];
    if ((o.tracer ?? "own") === "own") {
      const d = traceField(blurred, w, h, {
        turd: o.turd * 10, // bentuk/lubang mungil (titik sisa) dibuang
        err: o.fitErr ?? 0.8,
        corner: o.corner ?? 50,
        win: 3 + 1.2 * o.scale,
        smooth: o.curveSmooth ?? 6,
      });
      if (d) paths += `<path d="${d}" fill="${color}" fill-rule="evenodd" stroke="none"/>`;
    } else {
      const png = await sharp(blurred, { raw: { width: w, height: h, channels: 1 } })
        .toColourspace("b-w")
        .png()
        .toBuffer();
      const p = await loadTrace(png, {
        threshold: 128,
        blackOnWhite: true,
        turdSize: o.turd,
        optTolerance: o.opt,
        alphaMax: o.alphaMax ?? 1,
        optCurve: true,
      });
      const tag = simplifyTag(p.getPathTag(color), o.fit ?? 0, false);
      if (!tag.includes(' d=""')) paths += tag;
    }
    for (const e of shapes) paths += ellipseTag(e, color);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W0}" height="${H0}" viewBox="0 0 ${w} ${h}">${paths}</svg>`;
}

/** Hitam-putih: satu lapisan Potrace dari gambar grayscale yang dihaluskan */
export async function traceBlackWhite(
  input: Buffer,
  o: { scale: number; blur: number; turd: number; opt: number; threshold: number; fit?: number },
): Promise<string> {
  const meta = await sharp(input).metadata();
  const W0 = meta.width ?? 0;
  const H0 = meta.height ?? 0;
  if (!W0 || !H0) throw new Error("Gambar tidak valid.");
  const w = Math.round(W0 * o.scale);
  const h = Math.round(H0 * o.scale);
  const png = await sharp(input)
    .flatten({ background: "#ffffff" })
    .resize(w, h, { kernel: "lanczos3" })
    .greyscale()
    .blur(Math.max(0.3, o.blur))
    .png()
    .toBuffer();
  const p = await loadTrace(png, {
    threshold: o.threshold,
    blackOnWhite: true,
    turdSize: o.turd,
    optTolerance: o.opt,
    alphaMax: 1,
    optCurve: true,
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W0}" height="${H0}" viewBox="0 0 ${w} ${h}">${simplifyTag(p.getPathTag("#000000"), o.fit ?? 0, true)}</svg>`;
}
