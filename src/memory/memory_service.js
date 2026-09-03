const { uid, now, compactText } = require("../core/runtime_utils");

function recordCheckpoint(state, projectId, nodeName, graphState, metadata = {}) {
  state.checkpoints = state.checkpoints || [];
  state.checkpoints.unshift({
    id: uid("ckpt"),
    projectId,
    threadId: projectId,
    nodeName,
    state: graphState,
    metadata,
    createdAt: now()
  });
  state.checkpoints = state.checkpoints.slice(0, 500);
}

function rememberProjectEvent(state, projectId, type, text, tags = []) {
  state.memories = state.memories || [];
  const clean = compactText(text, 1800);
  if (!clean) return null;
  const item = {
    id: uid("mem"),
    projectId,
    type,
    text: clean,
    tags,
    createdAt: now()
  };
  state.memories.unshift(item);
  state.memories = state.memories.slice(0, 1000);
  return item;
}

function searchMemory(state, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return [];
  return (state.memories || [])
    .filter((memory) => String(memory.text || "").toLowerCase().includes(needle))
    .map((memory) => {
      const project = state.projects.find((item) => item.id === memory.projectId);
      return {
        type: "memory",
        projectId: memory.projectId,
        projectTitle: project?.title || "전체 메모리",
        text: memory.text,
        createdAt: memory.createdAt
      };
    });
}

module.exports = {
  recordCheckpoint,
  rememberProjectEvent,
  searchMemory
};
