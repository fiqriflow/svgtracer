import sharp from "sharp";
import { Potrace } from "potrace";
import { assignPalette, buildPalette, refinePalette, softAssign } from "./quantize";
import { edgeSmooth } from "./denoise";
import { ellipseTag, snapEllipses } from "./shapes";
import { simplifyTag } from "./simplify";

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
