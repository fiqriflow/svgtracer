# SVG Tracer

Upload PNG/JPG -> SVG otomatis siap diunduh. Pemrosesan di API route `/api/trace` (Node).

Mode Warna punya 2 metode (otomatis memilih):
- Halus: tracing berlapis per warna + Potrace. Kontur sangat mulus, untuk logo/ikon/maskot flat bersih.
- Detail: VTracer. Untuk gambar berderau atau bergradasi halus.

Mode Hitam-putih: Potrace satu lapis (ikon satu warna).

Gambar besar otomatis dikecilkan di browser (batas body Vercel ~4,5 MB).

## Jalankan
npm install
npm run dev

Deploy: Vercel (Node runtime). `sharp`, `potrace`, `@visioncortex/vtracer` dimuat sebagai external package.
