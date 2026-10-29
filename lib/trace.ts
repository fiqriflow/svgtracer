export type Mode = "color" | "bw";
export type Engine = "auto" | "smooth" | "detail";

export type TraceSettings = {
  mode: Mode;
  /** Metode tracing mode warna: otomatis memilih berdasarkan gambar */
  engine: Engine;
  /** Jumlah warna maksimum (mode warna) */
  colors: number;
  /** Buang bintik kecil (px) */
  speckles: number;
  /** Haluskan kurva, 0 = mati */
  smooth: number;
  /** Batas gelap 0-255 (mode hitam-putih) */
  threshold: number;
};

/** Preset awal: cocok untuk ilustrasi/maskot flat, minim gradasi */
export const DEFAULT_SETTINGS: TraceSettings = {
  mode: "color",
  engine: "auto",
  colors: 24,
  speckles: 8,
  smooth: 1.5,
  threshold: 128,
};

export type TraceResult = { svg: string; bytes: number; paths: number; engine: string };

/** Sisi terpanjang gambar yang dikirim; server hanya memakai sekitar 1400 px, jadi lebih besar tidak berguna */
export const MAX_SIDE = 1600;
/** Batas ukuran upload; body fungsi Vercel maksimal sekitar 4,5 MB (termasuk overhead form) */
const MAX_UPLOAD = 3.5 * 1024 * 1024;

const toBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));

/** Kirim file apa adanya bila kecil; kalau terlalu besar, kecilkan bertahap sampai muat. */
export async function prepareUpload(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const long = Math.max(bitmap.width, bitmap.height);
    if (file.size <= MAX_UPLOAD && long <= MAX_SIDE) return file;

    let ratio = Math.min(1, MAX_SIDE / long);
    for (let i = 0; i < 8; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
      canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas tidak tersedia di browser ini.");
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await toBlob(canvas);
      if (!blob) throw new Error("Gagal memproses gambar.");
      if (blob.size <= MAX_UPLOAD) return blob;
      ratio *= 0.8; // masih terlalu besar: kecilkan lagi
    }
    throw new Error("Gambar terlalu besar. Coba gambar yang lebih kecil.");
  } finally {
    bitmap.close();
  }
}

export async function traceImage(
  image: Blob,
  s: TraceSettings,
  signal?: AbortSignal,
): Promise<TraceResult> {
  const form = new FormData();
  form.append("file", image, "image.png");
  form.append("settings", JSON.stringify(s));
  const res = await fetch("/api/trace", { method: "POST", body: form, signal });
  if (res.status === 413) throw new Error("Gambar terlalu besar. Coba gambar yang lebih kecil.");
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(msg || `Tracing gagal (${res.status})`);
  }
  const svg = await res.text();
  return {
    svg,
    bytes: new Blob([svg]).size,
    paths: (svg.match(/<path/g) ?? []).length,
    engine: res.headers.get("X-Engine") ?? "",
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
