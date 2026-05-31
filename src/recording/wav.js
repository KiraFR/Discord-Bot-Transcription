/**
 * Construit un fichier WAV (PCM) à partir de données PCM brutes en préfixant
 * l'en-tête RIFF de 44 octets. Fonction pure, sans dépendance.
 *
 * @param {Buffer} pcm  données PCM entrelacées (s16le par défaut)
 * @returns {Buffer} contenu WAV complet
 */
export function pcmToWav(pcm, { sampleRate = 48000, channels = 2, bitDepth = 16 } = {}) {
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4); // taille du fichier - 8
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // taille du sous-chunk fmt (PCM)
  header.writeUInt16LE(1, 20); // format audio = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}
