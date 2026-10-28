declare module "imagetracerjs" {
  const ImageTracer: {
    imagedataToSVG(imageData: ImageData, options?: Record<string, unknown>): string;
  };
  export default ImageTracer;
}
