import sharp from "sharp";
import { Potrace } from "potrace";
import { assignPalette, buildPalette } from "./quantize";

export type LayeredOptions = {
  /** Jumlah warna palet (mode warna) */
  colors: number;
  /** Skala upscale sebelum tracing */
  scale: number;
  /** Sigma blur masker (px pada resolusi upscale): makin besar makin halus */
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
 * Trace berlapis: kuantisasi warna -> satu masker per warna (ditumpuk dari
 * area terbesar) -> blur -> Potrace. Hasil kontur jauh lebih mulus daripada
 * clustering piksel langsung, terutama pada tepi luar.
 */
export async function traceLayered(input: Buffer, o: LayeredOptions): Promise<string> {
  const meta = await sharp(input).metadata();
  const W0 = meta.width ?? 0;
  const H0 = meta.height ?? 0;
  if (!W0 || !H0) throw new Error("Gambar tidak valid.");
  const w = Math.round(W0 * o.scale);
  const h = Math.round(H0 * o.scale);
  const N = w * h;

  // Palet dihitung dari gambar asli, lalu tiap piksel hasil upscale dipetakan ke palet
  // Denoise ringan: menghilangkan derau halus yang memecah area datar jadi bintik
  const clean = await sharp(input).ensureAlpha().median(3).png().toBuffer();
  const orig = await sharp(clean).raw().toBuffer({ resolveWithObject: true });
  const palette = buildPalette(orig.data, orig.info.channels, o.colors);
  if (!palette.length) throw new Error("Gambar kosong.");
  const up = await sharp(clean)
    .resize(w, h, { kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ids = assignPalette(up.data, up.info.channels, palette);

  // Urutkan dari area terbesar (lapisan paling bawah)
  const counts = new Array<number>(palette.length).fill(0);
  for (let i = 0; i < N; i++) if (ids[i] >= 0) counts[ids[i]]++;
  const order = palette.map((_, i) => i).sort((a, b) => counts[b] - counts[a]);
  const rankOf = new Int16Array(palette.length);
  order.forEach((id, r) => (rankOf[id] = r));
  const rank = new Int16Array(N);
  for (let i = 0; i < N; i++) rank[i] = ids[i] < 0 ? -1 : rankOf[ids[i]];

  let paths = "";
  for (let r = 0; r < order.length; r++) {
    // Lapisan r = semua piksel dengan peringkat >= r (tanpa celah antar warna)
    const mask = Buffer.alloc(N, 255);
    let count = 0;
    for (let i = 0; i < N; i++) {
      if (rank[i] >= r) {
        mask[i] = 0;
        count++;
      }
    }
    if (count <= o.turd) continue;
    const png = await sharp(mask, { raw: { width: w, height: h, channels: 1 } })
      .blur(Math.max(0.3, o.blur))
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
    paths += p.getPathTag(hex(palette[order[r]]));
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
