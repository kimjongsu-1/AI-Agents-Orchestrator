function now() {
  return new Date().toISOString();
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function compactText(value = "", limit = 1200) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}…`;
}

function safeJsonParse(text = "") {
  try {
    return JSON.parse(text);
  } catch (_error) {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (__error) {
      return null;
    }
  }
}

function quoteForAppleScript(value = "") {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

module.exports = {
  now,
  uid,
  compactText,
  safeJsonParse,
  quoteForAppleScript
};
