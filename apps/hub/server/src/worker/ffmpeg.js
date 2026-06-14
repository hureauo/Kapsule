import { spawn } from 'node:child_process';

/**
 * Exécute une commande et collecte stdout/stderr.
 * Résout avec stdout (string) si code 0, rejette sinon.
 */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    const out = [];
    const err = [];
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => err.push(d));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString());
      } else {
        reject(new Error(`${cmd} exit ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`));
      }
    });
    proc.on('error', reject);
  });
}

/**
 * Sonde un fichier vidéo avec ffprobe.
 * @returns {{ duration_s: number, width: number, height: number }}
 */
export async function runFfprobe(filePath) {
  const json = await run('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    filePath,
  ]);
  const data = JSON.parse(json);
  const video = (data.streams ?? []).find((s) => s.codec_type === 'video') ?? {};
  const duration_s = parseFloat(video.duration ?? data.format?.duration ?? '0');
  return {
    duration_s,
    width: video.coded_width ?? video.width ?? 0,
    height: video.coded_height ?? video.height ?? 0,
  };
}

/**
 * Extrait une frame à t=1s et la sauve en JPEG.
 * @param {string} inputPath   Chemin de la vidéo source
 * @param {string} outputPath  Chemin de sortie (.jpg)
 */
export async function makeThumbnail(inputPath, outputPath) {
  await run('ffmpeg', [
    '-y',
    '-ss', '1',
    '-i', inputPath,
    '-frames:v', '1',
    '-q:v', '2',
    outputPath,
  ]);
}
