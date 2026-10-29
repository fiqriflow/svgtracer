/**
 * Penghalus yang menjaga tepi (sigma filter): tiap piksel dirata-ratakan dengan tetangga
 * (radius `r`) yang warnanya dekat (<= `tol`). Tetangga di seberang tepi diabaikan, jadi
 * tepi tetap tajam, sedangkan derau JPEG dan gradasi lembut di dalam area rata terhapus.
 * Piksel transparan (alpha < 128) tidak ikut dirata-ratakan.
 */
export function edgeSmooth(
  rgba: Uint8Array,
  channels: number,
  width: number,
  height: number,
  opts: { radius?: number; tol?: number; passes?: number } = {},
): Uint8Array {
  const r = opts.radius ?? 2;
  const tol2 = (opts.tol ?? 28) ** 2;
  const passes = opts.passes ?? 2;
  let src = rgba;
  for (let pass = 0; pass < passes; pass++) {
    const dst = new Uint8Array(src);
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(height - 1, y + r);
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * channels;
        if (channels === 4 && src[o + 3] < 128) continue;
        const cr = src[o];
        const cg = src[o + 1];
        const cb = src[o + 2];
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(width - 1, x + r);
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let n = 0;
        for (let yy = y0; yy <= y1; yy++) {
          let p = (yy * width + x0) * channels;
          for (let xx = x0; xx <= x1; xx++, p += channels) {
            if (channels === 4 && src[p + 3] < 128) continue;
            const dr = src[p] - cr;
            const dg = src[p + 1] - cg;
            const db = src[p + 2] - cb;
            if (dr * dr + dg * dg + db * db <= tol2) {
              sr += src[p];
              sg += src[p + 1];
              sb += src[p + 2];
              n++;
            }
          }
        }
        dst[o] = Math.round(sr / n);
        dst[o + 1] = Math.round(sg / n);
        dst[o + 2] = Math.round(sb / n);
      }
    }
    src = dst;
  }
  return src;
}
