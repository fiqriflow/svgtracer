import { NextResponse } from "next/server";
import sharp from "sharp";
import { traceDetail } from "@/lib/detail";
import { traceBlackWhite, traceLayered } from "@/lib/layered";
import { flatness } from "@/lib/quantize";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 4.2 * 1024 * 1024;
/** Sisi terpanjang target untuk tracing; gambar kecil di-upscale sampai sini (maks 2x) */
const TARGET_SIDE = 1400;
/** Gambar dianggap "flat bersih" bila 16 warna dominan mencakup porsi ini */
const FLAT_THRESHOLD = 0.96;

const clamp = (v: unknown, min: number, max: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) return new NextResponse("File tidak ada.", { status: 400 });
    if (file.size > MAX_BYTES) return new NextResponse("File terlalu besar (maks sekitar 4 MB).", { status: 413 });

    let s: Record<string, unknown> = {};
    try {
      s = JSON.parse(String(form.get("settings") ?? "{}"));
    } catch {}

    const input = Buffer.from(await file.arrayBuffer());
    const meta = await sharp(input).metadata();
    const long = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (!long) return new NextResponse("Gambar tidak valid.", { status: 422 });

    const scale = Math.min(2, Math.max(1, TARGET_SIDE / long));
    const smooth = clamp(s.smooth, 0, 5, 1.5);
    const speckles = Math.round(clamp(s.speckles, 0, 60, 8));
    const colors = Math.round(clamp(s.colors, 2, 64, 24));

    let svg: string;
    let engine: "smooth" | "detail" | "bw";
    if (s.mode === "bw") {
      engine = "bw";
      svg = await traceBlackWhite(input, {
        scale,
        blur: scale * (0.4 + 0.4 * smooth),
        turd: speckles * Math.round(scale * 2),
        opt: 0.4,
        threshold: Math.round(clamp(s.threshold, 20, 235, 128)),
      });
    } else {
      let useSmooth = s.engine === "smooth";
      if (s.engine !== "smooth" && s.engine !== "detail") {
        const px = await sharp(input).ensureAlpha().median(3).raw().toBuffer({ resolveWithObject: true });
        useSmooth = flatness(px.data, px.info.channels) >= FLAT_THRESHOLD;
      }
      if (useSmooth) {
        engine = "smooth";
        svg = await traceLayered(input, {
          scale,
          colors,
          // sigma blur dalam px gambar asli: slider "haluskan" 0-5 -> 0,3-1,4 px
          blur: 0.3 + 0.22 * smooth,
          turd: speckles * Math.round(scale * 2),
          // kurva Potrace: makin tinggi "haluskan" makin sedikit simpul & sudut makin lembut
          opt: 0.5 + 0.1 * smooth,
          alphaMax: 1 + 0.04 * smooth,
          // bentuk bulat/lonjong dijadikan lingkaran/elips sempurna (default aktif)
          snap: s.snap !== false,
          denoise: true,
          mergeDist: 12,
        });
      } else {
        engine = "detail";
        svg = await traceDetail(input, { scale, speckles, smooth, colors: Math.max(colors, 32) });
      }
    }

    return new NextResponse(svg, {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Engine": engine,
      },
    });
  } catch (e) {
    console.error(e);
    return new NextResponse("Gambar tidak bisa diproses. Coba file PNG lain.", { status: 422 });
  }
}
