import sharp from "sharp";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vtracer = require("@visioncortex/vtracer") as typeof import("@visioncortex/vtracer");

type DetailOptions = { scale: number; speckles: number; smooth: number; colors: number };

/** Detail: VTracer (clustering warna) untuk gambar berderau/bergradasi halus */
export async function traceDetail(input: Buffer, o: DetailOptions): Promise<string> {
  const meta = await sharp(input).metadata();
  const W0 = meta.width ?? 0;
  const H0 = meta.height ?? 0;
  const w = Math.round(W0 * o.scale);
  const h = Math.round(H0 * o.scale);
  const prepped = await sharp(input)
    .resize(w, h, { kernel: "lanczos3" })
    .median(3)
    .png()
    .toBuffer();
  const svg = vtracer.convertBuffer(new Uint8Array(prepped), {
    hierarchical: "stacked",
    mode: "spline",
    filterSpeckle: Math.round(o.speckles * o.scale),
    colorPrecision: 8,
    layerDifference: 8,
    cornerThreshold: 60,
    spliceThreshold: 45,
    pathPrecision: 1,
    maxColors: o.colors,
    ...(o.smooth > 0 ? { simplify: o.smooth } : {}),
    optimize: 2,
  });
  return svg.replace(/width="[\d.]+" height="[\d.]+"/, `width="${W0}" height="${H0}" viewBox="0 0 ${w} ${h}"`);
}
