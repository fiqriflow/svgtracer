import { NextResponse } from "next/server";
import sharp from "sharp";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vtracer = require("@visioncortex/vtracer") as typeof import("@visioncortex/vtracer");

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 4 * 1024 * 1024;
/** Sisi terpanjang target untuk tracing; gambar kecil di-upscale sampai sini (maks 2x) */
const TARGET_SIDE = 1700;
const clamp = (v: unknown, min: number, max: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) return new NextResponse("File tidak ada.", { status: 400 });
    if (file.size > MAX_BYTES) return new NextResponse("File terlalu besar (maks 4 MB).", { status: 413 });

    let s: Record<string, unknown> = {};
    try {
      s = JSON.parse(String(form.get("settings") ?? "{}"));
    } catch {}

    // Pra-proses: upscale (tepi lebih mulus) + median (buang noise/halo)
    const input = Buffer.from(await file.arrayBuffer());
    const meta = await sharp(input).metadata();
    const w0 = meta.width ?? 0;
    const h0 = meta.height ?? 0;
    if (!w0 || !h0) return new NextResponse("Gambar tidak valid.", { status: 422 });
    const scale = Math.min(2, Math.max(1, TARGET_SIDE / Math.max(w0, h0)));
    const w = Math.round(w0 * scale);
    const h = Math.round(h0 * scale);
    const prepped = await sharp(input)
      .resize(w, h, { kernel: "lanczos3" })
      .median(3)
      .png()
      .toBuffer();
    const buf = new Uint8Array(prepped);

    const speckles = Math.round(clamp(s.speckles, 0, 60, 8) * scale);
    const smooth = clamp(s.smooth, 0, 5, 1.5);

    let svg =
      s.mode === "bw"
        ? vtracer.convertBuffer(buf, {
            preset: "bw",
            binaryThreshold: Math.round(clamp(s.threshold, 20, 235, 128)),
            mode: "spline",
            filterSpeckle: speckles,
            ...(smooth > 0 ? { simplify: smooth } : {}),
            optimize: 2,
          })
        : vtracer.convertBuffer(buf, {
            hierarchical: "stacked",
            mode: "spline",
            filterSpeckle: speckles,
            colorPrecision: 8,
            layerDifference: 8,
            cornerThreshold: 60,
            spliceThreshold: 45,
            pathPrecision: 1,
            maxColors: Math.round(clamp(s.colors, 4, 64, 64)),
            ...(smooth > 0 ? { simplify: smooth } : {}),
            optimize: 2,
          });

    // Kembalikan ukuran SVG ke ukuran gambar asli (koordinat tetap resolusi tinggi)
    svg = svg.replace(
      /width="[\d.]+" height="[\d.]+"/,
      `width="${w0}" height="${h0}" viewBox="0 0 ${w} ${h}"`,
    );

    return new NextResponse(svg, {
      headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error(e);
    return new NextResponse("Gambar tidak bisa diproses. Coba file PNG lain.", { status: 422 });
  }
}
