import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function ffmpeg(args: string[]): Promise<void> {
  await exec('ffmpeg', ['-y', '-v', 'error', ...args], { maxBuffer: 16 * 1024 * 1024 });
}

export interface ProbeInfo {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
}

export async function probe(path: string): Promise<ProbeInfo> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]);
  const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string; width?: number; height?: number }[] };
  const v = j.streams?.find((s) => s.codec_type === 'video');
  return {
    durationSec: Number(j.format?.duration ?? 0),
    hasVideo: !!v,
    hasAudio: !!j.streams?.some((s) => s.codec_type === 'audio'),
    width: v?.width,
    height: v?.height,
  };
}

/** Materialize http(s)://, data: or file:// / plain-path URIs as a local file. */
export async function toLocalFile(uri: string, dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  if (/^https?:\/\//.test(uri)) {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`download failed ${res.status}: ${uri}`);
    const out = join(dir, name);
    await writeFile(out, Buffer.from(await res.arrayBuffer()));
    return out;
  }
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
  if (m) {
    const out = join(dir, name);
    await writeFile(out, m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!)));
    return out;
  }
  return uri.startsWith('file://') ? new URL(uri).pathname : uri;
}

/** Sample `n` evenly spaced JPEG frames as data URIs (for VLM judging). Images are passed through as one frame. */
export async function extractFrames(uri: string, n: number, dir: string): Promise<string[]> {
  const file = await toLocalFile(uri, dir, `src-${Math.abs(hash(uri))}`);
  const info = await probe(file);
  if (info.durationSec < 0.1) {
    const out = join(dir, `${Math.abs(hash(uri))}-img.jpg`);
    await ffmpeg(['-i', file, '-frames:v', '1', '-vf', 'scale=512:-2', out]);
    return [`data:image/jpeg;base64,${(await readFile(out)).toString('base64')}`];
  }
  const frames: string[] = [];
  for (let i = 0; i < n; i++) {
    const out = join(dir, `${Math.abs(hash(uri))}-f${i}.jpg`);
    await ffmpeg(['-ss', String((info.durationSec * (i + 0.5)) / n), '-i', file, '-frames:v', '1', '-vf', 'scale=512:-2', out]);
    frames.push(`data:image/jpeg;base64,${(await readFile(out)).toString('base64')}`);
  }
  return frames;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

export interface AudioTrack {
  uri: string;
  volume?: number;
  startSec?: number;
}

export interface RenderOptions {
  clips: string[];
  tracks?: AudioTrack[];
  out: string;
  workDir: string;
  width?: number;
  height?: number;
  fps?: number;
}

/** Normalizes clips to one format, concatenates, mixes audio tracks. */
export async function renderFilm(o: RenderOptions): Promise<ProbeInfo> {
  const W = o.width ?? 1280, H = o.height ?? 720, FPS = o.fps ?? 24;
  if (o.clips.length === 0) throw new Error('no clips to render');
  await mkdir(o.workDir, { recursive: true });
  const norm: string[] = [];
  for (const [i, c] of o.clips.entries()) {
    const src = await toLocalFile(c, o.workDir, `clip-${i}.src`);
    const out = join(o.workDir, `norm-${i}.mp4`);
    await ffmpeg([
      '-i', src, '-an',
      '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${FPS},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out,
    ]);
    norm.push(out);
  }
  const list = join(o.workDir, 'list.txt');
  await writeFile(list, norm.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  const silent = join(o.workDir, 'video.mp4');
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent]);
  const dur = (await probe(silent)).durationSec;

  if (!o.tracks?.length) {
    await ffmpeg(['-i', silent, '-c', 'copy', o.out]);
    return probe(o.out);
  }
  const inputs: string[] = ['-i', silent];
  const filters: string[] = [];
  for (const [k, t] of o.tracks.entries()) {
    inputs.push('-i', await toLocalFile(t.uri, o.workDir, `track-${k}.src`));
    const ms = Math.round((t.startSec ?? 0) * 1000);
    filters.push(`[${k + 1}:a]volume=${t.volume ?? 1},adelay=${ms}|${ms}[a${k}]`);
  }
  const labels = o.tracks.map((_, k) => `[a${k}]`).join('');
  filters.push(`${labels}amix=inputs=${o.tracks.length}:duration=longest:normalize=0[a]`);
  await ffmpeg([...inputs, '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-t', String(dur), o.out]);
  return probe(o.out);
}

/** Plain Lanczos upscale (not an AI upscaler; swap in a provider-based one behind the same signature). */
export async function upscale(inp: string, out: string, height: number): Promise<ProbeInfo> {
  await ffmpeg(['-i', inp, '-vf', `scale=-2:${height}:flags=lanczos`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'copy', out]);
  return probe(out);
}
