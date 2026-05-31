import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * État d'une session d'enregistrement : chemins de stockage, timeline des
 * prises de parole, résolution des noms. Une instance par serveur actif.
 */
export class Session {
  constructor({ guildId, voiceChannelId, textChannel, storageDir, names = new Map() }) {
    this.guildId = guildId;
    this.voiceChannelId = voiceChannelId;
    this.textChannel = textChannel;
    this.names = names;

    this.startTime = Date.now();
    this.sessionId = new Date(this.startTime).toISOString().replace(/[:.]/g, '-');
    this.dir = path.join(storageDir, guildId, this.sessionId);
    this.timelinePath = path.join(this.dir, 'timeline.json');

    this.utterances = [];
    this.nextIndex = 0;
    this.pending = new Set(); // promesses de capture en cours
    this.activeStreams = new Set(); // flux Opus en cours (à couper à l'arrêt)
    this.connection = null;

    mkdirSync(this.dir, { recursive: true });
  }

  resolveName(userId) {
    return this.names.get(userId) ?? userId;
  }

  /** Réserve un index + un chemin de fichier pour une nouvelle prise de parole. */
  reserveUtterance(userId) {
    const index = this.nextIndex++;
    const userDir = path.join(this.dir, userId);
    mkdirSync(userDir, { recursive: true });
    const file = path.join(userDir, `${String(index).padStart(4, '0')}.ogg`);
    return { index, file };
  }

  /** Enregistre une prise de parole terminée et persiste la timeline. */
  commitUtterance(entry) {
    this.utterances.push(entry);
    this.writeTimeline();
  }

  writeTimeline() {
    const data = this.utterances
      .slice()
      .sort((a, b) => a.startMs - b.startMs)
      .map((u) => ({
        index: u.index,
        userId: u.userId,
        displayName: u.displayName,
        startMs: u.startMs,
        endMs: u.endMs,
        file: u.file,
      }));
    writeFileSync(this.timelinePath, JSON.stringify(data, null, 2), 'utf8');
  }

  durationMs() {
    return Date.now() - this.startTime;
  }

  participants() {
    return [...new Set(this.utterances.map((u) => u.displayName))];
  }
}
