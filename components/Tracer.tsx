"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  formatBytes,
  prepareUpload,
  traceImage,
  type Mode,
  type TraceResult,
  type TraceSettings,
} from "@/lib/trace";

type Slider = {
  key: "colors" | "smooth" | "threshold" | "speckles";
  label: string;
  hint: string;
  min: number;
  max: number;
  modes: Mode[];
};

const SLIDERS: Slider[] = [
  { key: "colors", label: "Jumlah warna", hint: "Lebih banyak = lebih mirip, file lebih berat", min: 4, max: 64, modes: ["color"] },
  { key: "threshold", label: "Batas gelap", hint: "Piksel lebih gelap dari ini jadi hitam", min: 20, max: 235, modes: ["bw"] },
  { key: "smooth", label: "Haluskan kurva", hint: "0 = persis, makin tinggi makin halus dan ringan", min: 0, max: 5, modes: ["color", "bw"] },
  { key: "speckles", label: "Buang bintik", hint: "Hapus bentuk kecil yang tidak perlu", min: 0, max: 60, modes: ["color", "bw"] },
];

export default function Tracer() {
  const [fileName, setFileName] = useState<string>("");
  const [source, setSource] = useState<Blob | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string>("");
  const [settings, setSettings] = useState<TraceSettings>(DEFAULT_SETTINGS);
  const [result, setResult] = useState<TraceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const runId = useRef(0);

  const handleFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("File harus berupa gambar (PNG disarankan).");
      return;
    }
    setError("");
    setResult(null);
    try {
      const data = await prepareUpload(file);
      setSource(data);
      setFileName(file.name);
      setOriginalUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(file);
      });
    } catch {
      setError("Gambar tidak bisa dibaca. Coba file PNG lain.");
    }
  }, []);

  // Tracing otomatis (ditunda sebentar saat slider digeser)
  useEffect(() => {
    if (!source) return;
    const id = ++runId.current;
    const ctrl = new AbortController();
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const r = await traceImage(source, settings, ctrl.signal);
        if (id === runId.current) {
          setResult(r);
          setError("");
        }
      } catch (e) {
        if (id === runId.current && !ctrl.signal.aborted)
          setError(e instanceof Error ? e.message : "Tracing gagal. Coba gambar lebih kecil.");
      } finally {
        if (id === runId.current) setBusy(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [source, settings]);

  const [svgUrl, setSvgUrl] = useState("");

  // Buat & bersihkan URL dalam satu effect (aman untuk React StrictMode)
  useEffect(() => {
    if (!result) {
      setSvgUrl("");
      return;
    }
    const url = URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml" }));
    setSvgUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [result]);

  const download = () => {
    if (!svgUrl) return;
    const a = document.createElement("a");
    a.href = svgUrl;
    a.download = (fileName.replace(/\.[^.]+$/, "") || "trace") + ".svg";
    a.click();
  };

  const copySvg = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.svg);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Gagal menyalin. Pakai tombol Unduh SVG.");
    }
  };

  const set = <K extends keyof TraceSettings>(key: K, value: TraceSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  return (
    <div className="grid flex-1 gap-6 lg:grid-cols-[320px_1fr]">
      {/* Kontrol */}
      <aside className="flex flex-col gap-5 rounded-lg border border-line bg-panel p-4">
        <div>
          <p className="mb-2 text-sm font-medium">Mode</p>
          <div className="grid grid-cols-2 gap-1 rounded-md bg-paper p-1" role="group" aria-label="Mode tracing">
            {([
              ["color", "Warna"],
              ["bw", "Hitam-putih"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={settings.mode === value}
                onClick={() => set("mode", value)}
                className={`rounded px-3 py-1.5 text-sm transition-colors ${
                  settings.mode === value ? "bg-ink text-white" : "text-mute hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {SLIDERS.filter((sl) => sl.modes.includes(settings.mode)).map((sl) => (
          <div key={sl.key}>
            <label htmlFor={sl.key} className="flex items-baseline justify-between text-sm font-medium">
              <span>{sl.label}</span>
              <span className="tabular-nums text-mute">{settings[sl.key]}</span>
            </label>
            <input
              id={sl.key}
              type="range"
              min={sl.min}
              max={sl.max}
              value={settings[sl.key]}
              disabled={!source}
              onChange={(e) => set(sl.key, Number(e.target.value))}
              className="mt-1 w-full disabled:opacity-40"
            />
            <p className="text-xs text-mute">{sl.hint}</p>
          </div>
        ))}

        <div className="mt-auto flex flex-col gap-2 border-t border-line pt-4">
          <button
            type="button"
            onClick={download}
            disabled={!result || busy}
            className="rounded-md bg-anchor px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-40"
          >
            Unduh SVG
          </button>
          <button
            type="button"
            onClick={copySvg}
            disabled={!result || busy}
            className="rounded-md border border-line px-4 py-2 text-sm transition-colors hover:border-ink disabled:opacity-40"
          >
            {copied ? "Tersalin" : "Salin kode SVG"}
          </button>
          {result && (
            <p className="text-xs text-mute">
              {formatBytes(result.bytes)}, {result.paths} path
            </p>
          )}
        </div>
      </aside>

      {/* Area kerja */}
      <section className="flex min-h-[60vh] flex-col gap-3">
        {!source ? (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              handleFile(e.dataTransfer.files[0]);
            }}
            className={`flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
              dragging ? "border-anchor bg-white" : "border-line bg-panel"
            }`}
          >
            <p className="text-lg font-medium">Seret PNG ke sini</p>
            <p className="text-sm text-mute">Logo, ikon, dan ilustrasi flat memberi hasil terbaik.</p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-white"
            >
              Pilih file
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 text-sm">
              <p className="truncate text-mute">{fileName}</p>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="shrink-0 rounded-md border border-line px-3 py-1.5 transition-colors hover:border-ink"
              >
                Ganti gambar
              </button>
            </div>
            <div className="grid flex-1 gap-3 md:grid-cols-2">
              <figure className="flex flex-col gap-2">
                <figcaption className="text-sm font-medium">PNG asli</figcaption>
                <div className="checker flex flex-1 items-center justify-center overflow-hidden rounded-lg border border-line p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={originalUrl} alt="PNG asli" className="max-h-[65vh] max-w-full object-contain" />
                </div>
              </figure>
              <figure className="flex flex-col gap-2">
                <figcaption className="flex items-center justify-between text-sm font-medium">
                  <span>Hasil SVG</span>
                  {busy && <span className="text-xs font-normal text-mute" role="status">Memproses…</span>}
                </figcaption>
                <div className="checker flex flex-1 items-center justify-center overflow-hidden rounded-lg border border-line p-3">
                  {svgUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={svgUrl} alt="Hasil SVG" className="max-h-[65vh] max-w-full object-contain" />
                  ) : (
                    <p className="text-sm text-mute">Menunggu hasil…</p>
                  )}
                </div>
              </figure>
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/*"
          className="sr-only"
          onChange={(e) => {
            handleFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </section>
    </div>
  );
}
