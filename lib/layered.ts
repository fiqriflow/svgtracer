import sharp from "sharp";
import { Potrace } from "potrace";
import { assignPalette, buildPalette, softAssign } from "./quantize";

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
};

const loadTrace = (buf: Buffer, params: Record<string, unknown>) =>
  new Promise<Potrace>((resolve, reject) => {
    const p = new Potrace(params);
    p.loadImage(buf, (e) => (e ? reject(e) : resolve(p)));
  });

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
  const palette = buildPalette(orig.data, ch, o.colors);
  if (!palette.length) throw new Error("Gambar kosong.");
  let ids = assignPalette(orig.data, ch, palette);

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
    ids = assignPalette(orig.data, ch, palette);
  }

  // Urutkan dari area terbesar (lapisan paling bawah); indeks palet = peringkat
  const counts = new Array<number>(palette.length).fill(0);
  for (let i = 0; i < N0; i++) if (ids[i] >= 0) counts[ids[i]]++;
  const order = palette.map((_, i) => i).sort((a, b) => counts[b] - counts[a]);
  const ranked = order.map((i) => palette[i]);
  const soft = softAssign(orig.data, ch, ranked);
  const cover = new Uint8Array(N0); // alpha asli 0-255
  for (let i = 0; i < N0; i++) cover[i] = ch === 4 ? orig.data[i * ch + 3] : 255;

  const sigma = Math.max(0.3, o.blur * o.scale);
  const field = Buffer.allocUnsafe(N0);
  let paths = "";
  for (let r = 0; r < ranked.length; r++) {
    // Lapisan r = cakupan semua warna dengan peringkat >= r (tanpa celah antar warna)
    // Potrace: gelap (0) = isi, jadi medan dibalik
    let count = 0;
    for (let i = 0; i < N0; i++) {
      const wb = soft.w[i];
      const f = (((soft.a[i] >= r ? 255 - wb : 0) + (soft.b[i] >= r ? wb : 0)) * cover[i]) / 255;
      if (f >= 128) count++;
      field[i] = 255 - Math.round(f);
    }
    if (count * o.scale * o.scale <= o.turd) continue;
    const big = await sharp(field, { raw: { width: W0, height: H0, channels: 1 } })
      .resize(w, h, { kernel: "cubic" })
      .raw()
      .toBuffer();
    const png = await sharp(big, { raw: { width: w, height: h, channels: 1 } })
      .blur(sigma)
      .png()
      .toBuffer();
    const p = await loadTrace(png, {
      threshold: 128,
      blackOnWhite: true,
      turdSize: o.turd,
      optTolerance: o.opt,
      alphaMax: 1,
      optCurve: true,
    });
    paths += p.getPathTag(hex(ranked[r]));
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W0}" height="${H0}" viewBox="0 0 ${w} ${h}">${paths}</svg>`;
}

/** Hitam-putih: satu lapisan Potrace dari gambar grayscale yang dihaluskan */
export async function traceBlackWhite(
  input: Buffer,
  o: { scale: number; blur: number; turd: number; opt: number; threshold: number },
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W0}" height="${H0}" viewBox="0 0 ${w} ${h}">${p.getPathTag("#000000")}</svg>`;
}
