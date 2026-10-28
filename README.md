# SVG Tracer

Web app untuk mengubah PNG menjadi SVG vektor (tracing). Semua proses jalan di browser, file tidak diunggah ke server.

## Stack

- Next.js (App Router) + TypeScript
- Tailwind CSS
- [imagetracerjs](https://github.com/jankovicsandras/imagetracerjs) untuk tracing
- Deploy: Vercel
- Supabase: belum dipakai (opsional, lihat `.env.example`)

## Jalankan lokal

```bash
npm install
npm run dev
```

Buka http://localhost:3000

## Deploy ke Vercel

1. Push repo ke GitHub.
2. Di Vercel: Add New > Project > pilih repo.
3. Framework terdeteksi otomatis (Next.js). Klik Deploy.

## Struktur

```
app/            layout, halaman, CSS global
components/     Tracer.tsx (UI: upload, slider, preview, unduh)
lib/trace.ts    logika tracing + pengaturan
types/          deklarasi tipe imagetracerjs
```

## Ide lanjutan

- Riwayat file / akun lewat Supabase
- Pilihan ukuran maksimum gambar (`MAX_SIDE` di `lib/trace.ts`)
- Preset (logo, ikon, sketsa)
- Optimasi SVG (SVGO)
