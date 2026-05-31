import { AttachmentBuilder } from 'discord.js';

const MAX_MESSAGE = 2000; // Discord message content limit
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // Discord default (no boost)

function truncate(str, max) {
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

/**
 * Post a summary + attach transcript.md and transcript.json to the text channel.
 * Oversized files are skipped (they remain on disk) and the summary is capped to
 * Discord's message length, so a long/busy session can't make the post throw.
 */
export async function publishTranscript(textChannel, { markdown, json, meta }) {
  const candidates = [
    [Buffer.from(markdown, 'utf8'), 'transcript.md'],
    [Buffer.from(JSON.stringify(json, null, 2), 'utf8'), 'transcript.json'],
  ];

  const files = [];
  const skipped = [];
  for (const [buf, name] of candidates) {
    if (buf.byteLength <= MAX_ATTACHMENT_BYTES) {
      files.push(new AttachmentBuilder(buf, { name }));
    } else {
      skipped.push(name);
    }
  }

  const lines = [
    `📝 **Transcript ready** — ${meta.utteranceCount} turn(s), ${meta.participants.length} participant(s).`,
  ];
  if (meta.missingCount) {
    lines.push(`⚠️ ${meta.missingCount} turn(s) could not be transcribed (marked in the transcript).`);
  }
  if (skipped.length) {
    lines.push(`⚠️ Too large to attach: ${skipped.join(', ')} — kept on the server.`);
  }

  await textChannel.send({ content: truncate(lines.join('\n'), MAX_MESSAGE), files });
}
