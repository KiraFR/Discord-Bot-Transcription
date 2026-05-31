// Sessions d'enregistrement actives, indexées par guildId.
const sessions = new Map();

export function getSession(guildId) {
  return sessions.get(guildId) ?? null;
}

export function setSession(guildId, session) {
  sessions.set(guildId, session);
}

export function clearSession(guildId) {
  sessions.delete(guildId);
}
