import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

// Coalesce timeline writes so a busy session doesn't hit the disk on every turn.
const WRITE_DEBOUNCE_MS = 500;

/**
 * State of a recording session: storage paths, the turn-of-speech timeline, and
 * name resolution. One instance per active guild.
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
    this.pending = new Set(); // in-progress capture promises
    this.activeStreams = new Set(); // in-progress Opus streams (cut on stop)
    this.connection = null;

    this._createdDirs = new Set();
    this._writeTimer = null;

    mkdirSync(this.dir, { recursive: true });
  }

  resolveName(userId) {
    return this.names.get(userId) ?? userId;
  }

  /** Reserve an index + a file path for a new turn of speech. */
  reserveUtterance(userId) {
    const index = this.nextIndex++;
    const userDir = path.join(this.dir, userId);
    if (!this._createdDirs.has(userDir)) {
      mkdirSync(userDir, { recursive: true });
      this._createdDirs.add(userDir);
    }
    const file = path.join(userDir, `${String(index).padStart(4, '0')}.ogg`);
    return { index, file };
  }

  /** Record a finished turn and schedule a (debounced) timeline write. */
  commitUtterance(entry) {
    this.utterances.push(entry);
    this._scheduleTimelineWrite();
  }

  _serializeTimeline() {
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
    return JSON.stringify(data, null, 2);
  }

  _scheduleTimelineWrite() {
    if (this._writeTimer) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      const tmp = `${this.timelinePath}.tmp`;
      // Atomic: write to a temp file then rename over the target.
      writeFile(tmp, this._serializeTimeline(), 'utf8')
        .then(() => rename(tmp, this.timelinePath))
        .catch((err) => console.error('[session] timeline write failed:', err));
    }, WRITE_DEBOUNCE_MS);
  }

  /** Force a final, synchronous, atomic flush of the timeline (used by /stop). */
  writeTimeline() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    const tmp = `${this.timelinePath}.tmp`;
    writeFileSync(tmp, this._serializeTimeline(), 'utf8');
    renameSync(tmp, this.timelinePath);
  }

  durationMs() {
    return Date.now() - this.startTime;
  }

  participants() {
    return [...new Set(this.utterances.map((u) => u.displayName))];
  }
}
