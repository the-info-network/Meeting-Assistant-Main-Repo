/**
 * Whether Super Agent (AssemblyAI premium analysis) is enabled.
 * Enabled if:
 * - The calendar has enableSuperAgent set to true (Settings → Bot Settings), or
 * - SUPER_AGENT_ENABLED env is truthy: "true", "1", or "yes" (case-insensitive).
 *
 * @param {import('../models/calendar.js')} [calendar] - Optional calendar instance (may have enableSuperAgent).
 * @returns {boolean}
 */
const ENABLED_VALUES = new Set(["true", "1", "yes", "on", "enabled"]);

export function isSuperAgentEnabled(calendar = null) {
  if (calendar && calendar.enableSuperAgent === true) {
    return true;
  }
  const v = (process.env.SUPER_AGENT_ENABLED || "").trim().toLowerCase();
  return ENABLED_VALUES.has(v);
}

/**
 * Whether a user has premium access (paid subscription or active trial).
 * Wraps user.isPremiumOrTrial() for use in routes.
 *
 * @param {import('../models/user.js')} user - User model instance.
 * @returns {boolean}
 */
export function isUserPremium(user) {
  if (!user || typeof user.isPremiumOrTrial !== "function") return false;
  return user.isPremiumOrTrial();
}

/**
 * Chapters to show in the UI: prefer persisted `chapters`, else AssemblyAI payload on `assemblyResult`
 * (transcription can succeed while the LLM step fails, leaving chapters only on assemblyResult).
 *
 * @param {object|null|undefined} row - MeetingSuperAgentAnalysis Sequelize instance or plain object
 * @returns {Array}
 */
export function effectiveSuperAgentChapters(row) {
  if (!row) return [];
  if (Array.isArray(row.chapters) && row.chapters.length > 0) return row.chapters;
  const ar = row.assemblyResult;
  if (ar && Array.isArray(ar.chapters) && ar.chapters.length > 0) return ar.chapters;
  return [];
}
