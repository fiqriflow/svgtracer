# SVG Tracer

Upload PNG/JPG -> SVG otomatis siap diunduh. Pemrosesan di API route `/api/trace` (Node).

Mode Warna punya 2 metode (otomatis memilih):
- Halus: tracing berlapis per warna + Potrace. Kontur sangat mulus, untuk logo/ikon/maskot flat bersih.
- Detail: VTracer. Untuk gambar berderau atau bergradasi halus.

Mode Hitam-putih: Potrace satu lapis (ikon satu warna).

Batas upload 4 MB (gambar besar otomatis dikecilkan di browser).

## Jalankan
npm install
npm run dev

Deploy: Vercel (Node runtime). `sharp`, `potrace`, `@visioncortex/vtracer` dimuat sebagai external package.
