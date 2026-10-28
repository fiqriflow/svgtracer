import { NextResponse } from "next/server";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vtracer = require("@visioncortex/vtracer") as typeof import("@visioncortex/vtracer");

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BYTES = 4 * 1024 * 1024;
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

    const buf = new Uint8Array(await file.arrayBuffer());
    const speckles = Math.round(clamp(s.speckles, 0, 60, 8));
    const smooth = clamp(s.smooth, 0, 5, 1.5);

    const svg =
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
            colorPrecision: 7,
            layerDifference: 12,
            cornerThreshold: 60,
            spliceThreshold: 45,
            pathPrecision: 1,
            maxColors: Math.round(clamp(s.colors, 4, 64, 64)),
            ...(smooth > 0 ? { simplify: smooth } : {}),
            optimize: 2,
          });

    return new NextResponse(svg, {
      headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error(e);
    return new NextResponse("Gambar tidak bisa diproses. Coba file PNG lain.", { status: 422 });
  }
}
