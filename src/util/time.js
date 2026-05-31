/**
 * Format a millisecond duration as "HH:MM:SS".
 * Non-finite or negative input is treated as 0.
 * @param {number} ms
 * @returns {string}
 */
export function formatTimestamp(ms) {
  const safe = Number.isFinite(ms) ? ms : 0;
  const totalSeconds = Math.max(0, Math.floor(safe / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
