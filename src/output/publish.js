import { AttachmentBuilder } from 'discord.js';

/**
 * Poste un résumé + joint transcript.md et transcript.json dans le canal texte.
 */
export async function publishTranscript(textChannel, { markdown, json, meta }) {
  const files = [
    new AttachmentBuilder(Buffer.from(markdown, 'utf8'), { name: 'transcript.md' }),
    new AttachmentBuilder(Buffer.from(JSON.stringify(json, null, 2), 'utf8'), {
      name: 'transcript.json',
    }),
  ];

  const summary =
    `📝 **Transcription terminée** — ${meta.utteranceCount} prise(s) de parole, ` +
    `${meta.participants.length} participant(s) : ${meta.participants.join(', ')}.`;

  await textChannel.send({ content: summary, files });
}
