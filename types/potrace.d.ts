declare module "potrace" {
  export class Potrace {
    constructor(params?: Record<string, unknown>);
    loadImage(target: Buffer | string, cb: (err: Error | null) => void): void;
    getPathTag(fill?: string, stroke?: string): string;
  }
}
