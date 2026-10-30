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
  const [split, setSplit] = useState(50);
  const [ratio, setRatio] = useState(1);
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

  // Tempel gambar dengan Ctrl+V
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = Array.from(e.clipboardData?.files ?? []).find((x) => x.type.startsWith("image/"));
      if (f) handleFile(f);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleFile]);

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

  const pickFile = () => inputRef.current?.click();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4">
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
          onClick={pickFile}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && pickFile()}
          className={`flex min-h-[55vh] cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-8 text-center transition-colors ${
            dragging ? "border-anchor bg-white" : "border-line bg-panel hover:border-ink"
          }`}
        >
          <p className="text-xl font-semibold">Seret PNG ke sini</p>
          <p className="text-sm text-mute">atau klik untuk memilih file, atau tempel dengan Ctrl+V</p>
          <p className="text-xs text-mute">Logo, ikon, dan ilustrasi flat memberi hasil terbaik. Gambar besar otomatis dikecilkan.</p>
        </div>
      ) : (
        <>
          {/* Perbandingan sebelum/sesudah */}
          <div className="rounded-2xl border border-line bg-panel p-3">
            <div
              className="checker relative mx-auto w-full select-none overflow-hidden rounded-xl"
              style={{ aspectRatio: String(ratio), maxWidth: `min(100%, calc(70vh * ${ratio}))` }}
            >
              {svgUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={svgUrl} alt="Hasil SVG" className="absolute inset-0 h-full w-full object-contain" />
              )}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={originalUrl}
                alt="PNG asli"
                onLoad={(e) => setRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight || 1)}
                className="absolute inset-0 h-full w-full object-contain"
                style={{ clipPath: svgUrl ? `inset(0 ${100 - split}% 0 0)` : undefined }}
              />
              {svgUrl && (
                <>
                  <div
                    className="pointer-events-none absolute inset-y-0 w-0.5 bg-anchor"
                    style={{ left: `${split}%` }}
                  />
                  <span className="pointer-events-none absolute left-2 top-2 rounded bg-ink/70 px-2 py-0.5 text-xs text-white">
                    PNG
                  </span>
                  <span className="pointer-events-none absolute right-2 top-2 rounded bg-ink/70 px-2 py-0.5 text-xs text-white">
                    SVG
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={split}
                    onChange={(e) => setSplit(Number(e.target.value))}
                    aria-label="Geser untuk membandingkan PNG dan SVG"
                    className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
                  />
                </>
              )}
              {busy && (
                <div
                  role="status"
                  className="absolute inset-0 flex items-center justify-center bg-white/60 text-sm font-medium"
                >
                  Memproses…
                </div>
              )}
            </div>
          </div>

          {/* Aksi utama */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={download}
              disabled={!result || busy}
              className="rounded-xl bg-anchor px-8 py-3 text-base font-semibold text-white transition-opacity disabled:opacity-40"
            >
              Unduh SVG
            </button>
            <button
              type="button"
              onClick={copySvg}
              disabled={!result || busy}
              className="rounded-xl border border-line px-4 py-3 text-sm transition-colors hover:border-ink disabled:opacity-40"
            >
              {copied ? "Tersalin" : "Salin kode"}
            </button>
            <button
              type="button"
              onClick={pickFile}
              className="rounded-xl border border-line px-4 py-3 text-sm transition-colors hover:border-ink"
            >
              Ganti gambar
            </button>
            <p className="ml-auto truncate text-xs text-mute">
              {fileName}
              {result && ` · ${formatBytes(result.bytes)} · ${result.paths} path`}
            </p>
          </div>

          {/* Pengaturan lanjutan */}
          <details className="rounded-xl border border-line bg-panel p-4">
            <summary className="cursor-pointer text-sm font-medium">Pengaturan lanjutan</summary>
            <div className="mt-4 grid gap-5 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <div className="grid max-w-xs grid-cols-2 gap-1 rounded-md bg-paper p-1" role="group" aria-label="Mode tracing">
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
              {settings.mode === "color" && (
                <div className="sm:col-span-2">
                  <p className="mb-1 text-sm font-medium">Metode</p>
                  <div className="grid max-w-md grid-cols-3 gap-1 rounded-md bg-paper p-1" role="group" aria-label="Metode tracing">
                    {([
                      ["auto", "Otomatis"],
                      ["smooth", "Halus"],
                      ["detail", "Detail"],
                    ] as const).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={settings.engine === value}
                        onClick={() => set("engine", value)}
                        className={`rounded px-3 py-1.5 text-sm transition-colors ${
                          settings.engine === value ? "bg-ink text-white" : "text-mute hover:text-ink"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-mute">
                    Halus: kontur bersih untuk logo/ikon/maskot flat. Detail: untuk gambar berderau atau bergradasi.
                    {result?.engine && settings.engine === "auto" && ` Terpilih: ${result.engine === "smooth" ? "Halus" : "Detail"}.`}
                  </p>
                </div>
              )}
              {settings.mode === "color" && (
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={settings.snap}
                    onChange={(e) => set("snap", e.target.checked)}
                  />
                  <span>
                    <span className="font-medium">Sempurnakan bentuk</span>
                    <span className="text-mute"> — bulat/lonjong jadi lingkaran/elips sempurna</span>
                  </span>
                </label>
              )}
              {settings.mode === "color" && (
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={settings.layers}
                    onChange={(e) => set("layers", e.target.checked)}
                  />
                  <span>
                    <span className="font-medium">Layer per objek</span>
                    <span className="text-mute"> — badan di belakang, lalu baju, rambut, mata, kacamata (grup berurutan z-index)</span>
                  </span>
                </label>
              )}
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
                    step={sl.key === "smooth" ? 0.5 : 1}
                    value={settings[sl.key]}
                    onChange={(e) => set(sl.key, Number(e.target.value))}
                    className="mt-1 w-full"
                  />
                  <p className="text-xs text-mute">{sl.hint}</p>
                </div>
              ))}
            </div>
          </details>
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
    </div>
  );
}
