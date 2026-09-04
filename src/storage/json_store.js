const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { createDefaultState } = require("./default_state");

function createJsonStore({ app, now }) {
  const dataDir = path.join(app.getPath("userData"), "data");
  const dataFile = path.join(dataDir, "orchestrator.json");
  const sqliteFile = path.join(dataDir, "orchestrator.sqlite3");
  const sqliteSyncScript = path.join(__dirname, "sqlite_store.py");

  const defaultState = createDefaultState(now);

  function ensureDataFile() {
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(dataFile)) {
      fs.writeFileSync(dataFile, JSON.stringify(defaultState, null, 2), "utf8");
    }
  }

  function migrateState(state) {
    state.version = state.version || 1;
    state.settings = {
      ...defaultState.settings,
      ...(state.settings || {})
    };
    state.settings.requireApprovalForRiskyRuns = false;
    state.projects = state.projects || [];
    state.runs = state.runs || [];
    state.usageEvents = state.usageEvents || [];
    state.checkpoints = state.checkpoints || [];
    state.memories = state.memories || [];
    state.automations = state.automations || [];
    state.mcpBridge = {
      ...defaultState.mcpBridge,
      ...(state.mcpBridge || {})
    };
    state.finalDrafts = state.finalDrafts || [];
    state.projects.forEach((project) => {
      project.messages = project.messages || [];
      project.tasks = project.tasks || [];
      project.approvals = project.approvals || [];
      project.evals = project.evals || { score: 0, items: [] };
      project.workspacePath = project.workspacePath || state.settings.workspacePath;
      project.autoRoutedMessageIds = project.autoRoutedMessageIds || [];
    });
    return state;
  }

  function readState() {
    ensureDataFile();
    try {
      return migrateState(JSON.parse(fs.readFileSync(dataFile, "utf8")));
    } catch (_error) {
      const backup = `${dataFile}.${Date.now()}.broken`;
      fs.copyFileSync(dataFile, backup);
      fs.writeFileSync(dataFile, JSON.stringify(defaultState, null, 2), "utf8");
      return structuredClone(defaultState);
    }
  }

  function syncSqliteStore() {
    if (!fs.existsSync(sqliteSyncScript)) return;
    const python = process.env.PYTHON || "/usr/bin/python3";
    try {
      spawnSync(python, [sqliteSyncScript, "sync", dataFile, sqliteFile], {
        timeout: 8000,
        stdio: "ignore"
      });
    } catch (_error) {
      // JSON 저장이 원본이다. SQLite 동기화 실패가 앱 실행을 막으면 안 된다.
    }
  }

  function writeState(state) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify(state, null, 2), "utf8");
    syncSqliteStore();
    return state;
  }

  return {
    dataDir,
    dataFile,
    sqliteFile,
    ensureDataFile,
    readState,
    writeState
  };
}

module.exports = { createJsonStore };
