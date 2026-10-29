/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // vtracer memuat file .wasm dari node_modules, jangan di-bundle
  serverExternalPackages: ["sharp", "potrace", "jimp", "@visioncortex/vtracer"],
};

export default nextConfig;
