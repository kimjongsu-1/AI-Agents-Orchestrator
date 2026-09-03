const { app, BrowserWindow } = require("electron");
const { uid, now } = require("./core/runtime_utils");
const { createJsonStore } = require("./storage/json_store");
const { createRouterService } = require("./router/router_service");
const { createRunService } = require("./runners/run_service");
const { createRoutineScheduler } = require("./automation/routine_scheduler");
const { createMcpService } = require("./mcp/mcp_service");
const { agentLabel } = require("./projects/project_service");
const { createWindow } = require("./app/window");
const { registerIpcHandlers } = require("./app/ipc_handlers");

app.setName("AI 오케스트레이터");

const store = createJsonStore({ app, now });
const routerService = createRouterService({
  readState: store.readState,
  writeState: store.writeState,
  dataDir: store.dataDir,
  agentLabel
});
const runService = createRunService({
  readState: store.readState,
  writeState: store.writeState,
  dataDir: store.dataDir,
  routerService
});
const routineScheduler = createRoutineScheduler({
  readState: store.readState,
  writeState: store.writeState
});
const mcpService = createMcpService({
  readState: store.readState,
  writeState: store.writeState,
  uid
});

registerIpcHandlers({
  store,
  routerService,
  runService
});

app.whenReady().then(() => {
  createWindow();
  mcpService.start();
  routineScheduler.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
