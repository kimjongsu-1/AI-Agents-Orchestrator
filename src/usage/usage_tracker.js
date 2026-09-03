const { uid, now } = require("../core/runtime_utils");

const COST_BASELINE_KRW_PER_1M = {
  router_cloud_baseline_input: 200,
  router_cloud_baseline_output: 800,
  codex_input: 0,
  codex_output: 0,
  claude_input: 0,
  claude_output: 0,
  grok_input: 0,
  grok_output: 0
};

function estimateTokens(text = "") {
  const compact = String(text || "").trim();
  if (!compact) return 0;
  const ascii = (compact.match(/[A-Za-z0-9_./:-]+/g) || []).join(" ").length;
  const nonAscii = compact.length - ascii;
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii * 1.15));
}

function estimateKrwCost(provider, inputTokens, outputTokens, isLocal = false, usageType = "agent_run") {
  if (isLocal) return 0;
  if (usageType === "router") {
    return ((inputTokens / 1_000_000) * COST_BASELINE_KRW_PER_1M.router_cloud_baseline_input) +
      ((outputTokens / 1_000_000) * COST_BASELINE_KRW_PER_1M.router_cloud_baseline_output);
  }
  const inputRate = COST_BASELINE_KRW_PER_1M[`${provider}_input`] || 0;
  const outputRate = COST_BASELINE_KRW_PER_1M[`${provider}_output`] || 0;
  return ((inputTokens / 1_000_000) * inputRate) + ((outputTokens / 1_000_000) * outputRate);
}

function recordUsageEvent(state, event) {
  if (!state.settings?.enableUsageTracking) return null;
  const inputTokens = Number(event.inputTokens || 0);
  const outputTokens = Number(event.outputTokens || 0);
  const isLocal = Boolean(event.isLocal);
  const provider = event.provider || event.agentId || "unknown";
  const usageType = event.usageType || "agent_run";
  const estimatedCostKrw = estimateKrwCost(provider, inputTokens, outputTokens, isLocal, usageType);
  const cloudEquivalentCostKrw = isLocal
    ? estimateKrwCost("router_cloud_baseline", inputTokens, outputTokens, false, usageType)
    : estimatedCostKrw;
  const item = {
    id: uid("usage"),
    projectId: event.projectId || null,
    runId: event.runId || null,
    agentId: event.agentId || provider,
    usageType,
    provider,
    model: event.model || null,
    inputTokens,
    outputTokens,
    callCount: Number(event.callCount || 1),
    estimatedCostKrw,
    actualCostKrw: isLocal ? 0 : estimatedCostKrw,
    cloudEquivalentCostKrw,
    savedCostKrw: Math.max(0, cloudEquivalentCostKrw - (isLocal ? 0 : estimatedCostKrw)),
    isLocal,
    note: event.note || "",
    createdAt: now()
  };
  state.usageEvents.unshift(item);
  return item;
}

module.exports = {
  estimateTokens,
  estimateKrwCost,
  recordUsageEvent
};
