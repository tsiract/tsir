/**
 * FFmpeg adapter — local video transcoding.
 *
 * Spawns the `ffmpeg` binary. Requires ffmpeg on PATH.
 *
 * `node:child_process` is imported **inside** `process()`, not at module scope. This adapter is
 * reachable from `@tsir/media`'s root entry, so a static import would put a Node builtin in the
 * module graph of every Worker bundle that imports the package at all — and Workerd has no
 * `child_process`, so `tsir deploy:build --target cloudflare` refused to bundle an app for
 * declaring a media provider it never configured. Same reasoning, same shape as the local
 * provider in `@tsir/forge`.
 */
import { ffmpegFailed } from '../errors.ts';
import type { MediaAdapter } from '../media.ts';

export interface FfmpegAdapterOptions {
  /** Path to ffmpeg binary. Default: 'ffmpeg'. */
  ffmpegPath?: string;
  /** Default CRF quality 0-51 (lower = better). */
  defaultCrf?: number;
  /** Default preset. */
  defaultPreset?: string;
}

export function ffmpegAdapter(options: FfmpegAdapterOptions = {}): MediaAdapter {
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const defaultCrf = options.defaultCrf ?? 23;
  const defaultPreset = options.defaultPreset ?? 'medium';

  return {
    name: 'ffmpeg',
    kind: 'video',
    async process(input, opts) {
      const format = opts.format ?? 'mp4';
      const crf = opts.quality ?? defaultCrf;
      const preset = defaultPreset;

      const args = [
        '-i',
        'pipe:0',
        '-c:v',
        'libx264',
        '-preset',
        preset,
        '-crf',
        String(crf),
        '-f',
        format,
        'pipe:1',
      ];

      if (opts.width !== undefined || opts.height !== undefined) {
        const scale = `scale=${opts.width ?? -2}:${opts.height ?? -2}`;
        args.splice(2, 0, '-vf', scale);
      }

      // Deferred so the builtin stays out of a Worker's module graph (see the header).
      const { spawn } = await import('node:child_process');
      const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'ignore'] });

      const chunks: Buffer[] = [];
      proc.stdout.on('data', (c: Buffer) => chunks.push(c));

      const writeDone = new Promise<void>((resolve, reject) => {
        proc.stdin.on('error', reject);
        proc.stdin.end(Buffer.from(input), () => resolve());
      });

      const exit = new Promise<number>((resolve) => {
        proc.on('close', resolve);
      });

      await writeDone;
      const code = await exit;
      if (code !== 0) throw ffmpegFailed(`ffmpeg exited with code ${code}`);

      const data = Buffer.concat(chunks);
      return {
        data: new Uint8Array(data),
        contentType: `video/${format}`,
        size: data.length,
      };
    },
  };
}
