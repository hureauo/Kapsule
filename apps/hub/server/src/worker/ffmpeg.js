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
 * Lit l'angle de rotation d'un flux vidéo, en degrés (0, 90, 180, 270).
 *
 * Une vidéo filmée en portrait sur mobile est très souvent ENCODÉE en paysage
 * (ex. 1920×1080) avec une matrice de rotation de 90° en métadonnée : le lecteur
 * la redresse à l'affichage. `coded_width`/`coded_height` décrivent le flux encodé,
 * donc AVANT rotation — s'y fier ferait passer une vidéo portrait pour du paysage.
 *
 * ffmpeg expose l'info à deux endroits selon sa version : l'ancien champ
 * `tags.rotate`, et le side_data `Display Matrix` (`rotation`, souvent négatif).
 */
function readRotation(video) {
  const fromTag = parseFloat(video.tags?.rotate ?? 'NaN');
  const fromSideData = (video.side_data_list ?? [])
    .map((sd) => parseFloat(sd.rotation))
    .find((r) => Number.isFinite(r));

  const raw = Number.isFinite(fromTag) ? fromTag : fromSideData;
  if (!Number.isFinite(raw)) return 0;

  // Normalise dans [0, 360) : la Display Matrix rend typiquement -90 pour un
  // quart de tour, et le modulo de JS garde le signe du dividende.
  return ((Math.round(raw) % 360) + 360) % 360;
}

/**
 * Sonde un fichier vidéo avec ffprobe.
 *
 * width/height sont les dimensions D'AFFICHAGE : la rotation est appliquée, donc
 * une vidéo portrait ressort bien avec height > width, quelle que soit la façon
 * dont elle a été encodée. C'est ce que la galerie et les exports doivent voir.
 *
 * @returns {{ duration_s: number, width: number, height: number, rotation: number }}
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

  const codedWidth = video.coded_width ?? video.width ?? 0;
  const codedHeight = video.coded_height ?? video.height ?? 0;

  // Un quart de tour (90° ou 270°) échange largeur et hauteur à l'affichage ;
  // 0° et 180° les conservent.
  const rotation = readRotation(video);
  const swapped = rotation === 90 || rotation === 270;

  return {
    duration_s,
    width: swapped ? codedHeight : codedWidth,
    height: swapped ? codedWidth : codedHeight,
    rotation,
  };
}

/**
 * Extrait une frame et la sauve en JPEG.
 *
 * On vise t=1s (la toute première frame est souvent noire, le temps que la caméra
 * expose). Mais un `-ss` au-delà de la durée du fichier ne produit AUCUNE frame et
 * fait échouer ffmpeg : une vidéo de moins d'une seconde — un invité qui appuie sur
 * stop trop vite — n'aurait alors pas de miniature du tout. On retombe donc sur la
 * première frame plutôt que d'échouer.
 *
 * La rotation est appliquée automatiquement par ffmpeg à la lecture (autorotate) :
 * une source portrait donne un JPEG portrait, sans traitement supplémentaire.
 *
 * @param {string} inputPath   Chemin de la vidéo source
 * @param {string} outputPath  Chemin de sortie (.jpg)
 */
export async function makeThumbnail(inputPath, outputPath) {
  const args = (seek) => [
    '-y',
    '-ss', seek,
    '-i', inputPath,
    '-frames:v', '1',
    '-q:v', '2',
    outputPath,
  ];

  try {
    await run('ffmpeg', args('1'));
  } catch {
    // Vidéo trop courte pour un seek à 1s → première frame.
    await run('ffmpeg', args('0'));
  }
}
