export type Mode = "color" | "bw";

export type TraceSettings = {
  mode: Mode;
  /** Jumlah warna (mode warna) */
  colors: number;
  /** 1 (kasar) - 10 (sangat detail) */
  detail: number;
  /** 0 - 5, blur sebelum tracing untuk menghaluskan tepi */
  smooth: number;
  /** 0 - 255, batas gelap/terang (mode hitam-putih) */
  threshold: number;
  /** Buang bintik kecil, makin besar makin banyak yang dibuang */
  speckles: number;
};

export const DEFAULT_SETTINGS: TraceSettings = {
  mode: "color",
  colors: 8,
  detail: 6,
  smooth: 0,
  threshold: 128,
  speckles: 8,
};

export type TraceResult = {
  svg: string;
  bytes: number;
  paths: number;
};

/** Sisi terpanjang gambar saat tracing. Lebih besar = lebih lambat. */
export const MAX_SIDE = 1400;

export async function loadImageData(file: File): Promise<ImageData> {
  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * ratio));
  const h = Math.max(1, Math.round(bitmap.height * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas tidak tersedia di browser ini.");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return ctx.getImageData(0, 0, w, h);
}

function toBlackWhite(src: ImageData, threshold: number): ImageData {
  const out = new ImageData(src.width, src.height);
  const s = src.data;
  const d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    const alpha = s[i + 3];
    const lum = 0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2];
    const dark = alpha >= 128 && lum < threshold;
    const v = dark ? 0 : 255;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }
  return out;
}

export async function traceImageData(
  source: ImageData,
  s: TraceSettings,
): Promise<TraceResult> {
  const mod = await import("imagetracerjs");
  const ImageTracer = mod.default;

  // detail 1..10 -> toleransi kurva 3..0.57 (makin kecil makin presisi)
  const tol = 3 - (s.detail - 1) * 0.27;

  const base = {
    ltres: tol,
    qtres: tol,
    pathomit: s.speckles,
    blurradius: s.smooth,
    blurdelta: 20,
    roundcoords: 1,
    viewbox: true,
    desc: false,
    strokewidth: 1,
  };

  let svg: string;
  if (s.mode === "bw") {
    svg = ImageTracer.imagedataToSVG(toBlackWhite(source, s.threshold), {
      ...base,
      numberofcolors: 2,
      colorsampling: 0,
      pal: [
        { r: 0, g: 0, b: 0, a: 255 },
        { r: 255, g: 255, b: 255, a: 255 },
      ],
    });
    // Buang bidang putih supaya latar SVG transparan
    svg = svg.replace(/<path[^>]*fill="rgb\(255,255,255\)"[^>]*\/>/g, "");
  } else {
    svg = ImageTracer.imagedataToSVG(source, {
      ...base,
      numberofcolors: s.colors,
      colorsampling: 2,
      colorquantcycles: 3,
    });
    // Buang bidang transparan
    svg = svg.replace(/<path[^>]*opacity="0"[^>]*\/>/g, "");
  }

  const paths = (svg.match(/<path/g) ?? []).length;
  const bytes = new Blob([svg]).size;
  return { svg, bytes, paths };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
