import { Injectable } from '@angular/core';

/**
 * Global, reusable CLIENT-SIDE image optimization (compression + thumbnails).
 *
 * Pure transformation only -- returns blobs + metadata, NEVER uploads
 * (storage-agnostic, reusable by any component: RAG media, Avatar Manager
 * thumbnails, future uploads). Uses the Canvas API only (no external deps).
 *
 * Quality-preserving defaults: full = longest side <= 2048px, WebP q~0.8;
 * thumbnail = longest side ~360px, WebP q~0.7. Aspect ratio + transparency are
 * preserved (PNG/transparent -> WebP keeps alpha), EXIF/metadata is stripped by
 * the canvas re-encode, images are never upscaled, and if the re-encode is not
 * smaller the original is returned (keepOriginalIfSmaller).
 */
export interface OptimizeResult {
  blob: Blob;
  width: number;
  height: number;
  bytes: number;
}

export interface OptimizeOptions {
  /** longest-side cap (never upscale). Default 2048. */
  maxDimension?: number;
  /** encoder quality 0..1. Default 0.8. */
  quality?: number;
  /** output format. Default 'webp'. */
  format?: 'webp' | 'jpeg' | 'png';
  /** return the original when the re-encode isn't smaller. Default true. */
  keepOriginalIfSmaller?: boolean;
}

export interface ThumbnailOptions {
  /** longest-side cap. Default 360. */
  maxDimension?: number;
  /** encoder quality 0..1. Default 0.7. */
  quality?: number;
  /** output format. Default 'webp'. */
  format?: 'webp' | 'jpeg' | 'png';
}

@Injectable({ providedIn: 'root' })
export class ImageOptimizationService {
  /** True when this looks like a raster image we can re-encode. */
  isOptimizableImage(file: File | Blob): boolean {
    const t = (file as File).type || '';
    return /^image\/(jpe?g|png|webp|bmp)$/i.test(t);
  }

  /**
   * Optimize a full-size image: cap the longest side, re-encode (WebP by
   * default), preserve aspect/transparency, never upscale, and keep the original
   * if the result isn't smaller.
   */
  async optimizeImage(file: File, opts: OptimizeOptions = {}): Promise<OptimizeResult> {
    const maxDimension = opts.maxDimension ?? 2048;
    const quality = opts.quality ?? 0.8;
    const format = opts.format ?? 'webp';
    const keepOriginalIfSmaller = opts.keepOriginalIfSmaller ?? true;

    // Non-raster (svg/gif/unknown) -> return as-is (no safe canvas re-encode).
    if (!this.isOptimizableImage(file)) {
      const dims = await this.tryDims(file);
      return { blob: file, width: dims.width, height: dims.height, bytes: file.size };
    }

    const { canvas, width, height } = await this.drawScaled(file, maxDimension);
    const reencoded = await this.toBlob(canvas, format, quality);

    if (keepOriginalIfSmaller && reencoded.size >= file.size) {
      return { blob: file, width, height, bytes: file.size };
    }
    return { blob: reencoded, width, height, bytes: reencoded.size };
  }

  /** Generate a small thumbnail (WebP by default). */
  async generateThumbnail(file: File | Blob, opts: ThumbnailOptions = {}): Promise<OptimizeResult> {
    const maxDimension = opts.maxDimension ?? 360;
    const quality = opts.quality ?? 0.7;
    const format = opts.format ?? 'webp';
    const { canvas, width, height } = await this.drawScaled(file, maxDimension);
    const blob = await this.toBlob(canvas, format, quality);
    return { blob, width, height, bytes: blob.size };
  }

  /** Convenience: full optimization + thumbnail in one call. */
  async optimizeWithThumbnail(
    file: File,
    opts: { full?: OptimizeOptions; thumb?: ThumbnailOptions } = {},
  ): Promise<{ full: OptimizeResult; thumb: OptimizeResult; originalBytes: number }> {
    const full = await this.optimizeImage(file, opts.full);
    // Thumbnail from the original (best quality source), independent of full.
    const thumb = await this.generateThumbnail(file, opts.thumb);
    return { full, thumb, originalBytes: file.size };
  }

  // ----------------------------------------------------------------- internals

  /** Decode + draw scaled (no upscale) onto a canvas. Preserves aspect + alpha. */
  private async drawScaled(
    file: File | Blob,
    maxDimension: number,
  ): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
    const { source, naturalW, naturalH, cleanup } = await this.decode(file);
    try {
      const longest = Math.max(naturalW, naturalH) || 1;
      const scale = longest > maxDimension ? maxDimension / longest : 1; // never upscale
      const width = Math.max(1, Math.round(naturalW * scale));
      const height = Math.max(1, Math.round(naturalH * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable.');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
      return { canvas, width, height };
    } finally {
      cleanup();
    }
  }

  /** Decode via createImageBitmap, falling back to HTMLImageElement. */
  private async decode(file: File | Blob): Promise<{
    source: ImageBitmap | HTMLImageElement;
    naturalW: number;
    naturalH: number;
    cleanup: () => void;
  }> {
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(file);
        return { source: bmp, naturalW: bmp.width, naturalH: bmp.height, cleanup: () => bmp.close() };
      } catch { /* fall back */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Could not decode image.'));
        el.src = url;
      });
      return {
        source: img,
        naturalW: img.naturalWidth,
        naturalH: img.naturalHeight,
        cleanup: () => URL.revokeObjectURL(url),
      };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }

  /** canvas.toBlob with a graceful format fallback (WebP -> JPEG/PNG). */
  private toBlob(canvas: HTMLCanvasElement, format: 'webp' | 'jpeg' | 'png', quality: number): Promise<Blob> {
    const mime = format === 'jpeg' ? 'image/jpeg' : format === 'png' ? 'image/png' : 'image/webp';
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) { resolve(blob); return; }
          // Some browsers return null for webp -> retry as JPEG, then PNG.
          canvas.toBlob(
            (b2) => (b2 ? resolve(b2) : canvas.toBlob((b3) => (b3 ? resolve(b3) : reject(new Error('toBlob failed.'))), 'image/png')),
            'image/jpeg',
            quality,
          );
        },
        mime,
        quality,
      );
    });
  }

  /** Best-effort natural dimensions for non-re-encoded files. */
  private async tryDims(file: File | Blob): Promise<{ width: number; height: number }> {
    try {
      const d = await this.decode(file);
      const out = { width: d.naturalW, height: d.naturalH };
      d.cleanup();
      return out;
    } catch {
      return { width: 0, height: 0 };
    }
  }
}
