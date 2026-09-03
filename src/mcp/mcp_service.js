const { startMcpBridge: createMcpBridgeServer } = require("./mcp_bridge");

function createMcpService({ readState, writeState, uid }) {
  let server = null;

  function start() {
    if (server) return server;
    server = createMcpBridgeServer({
      readState,
      writeState,
      uid,
      onError: () => {
        server = null;
      }
    });
    return server;
  }

  function current() {
    return server;
  }

  return { start, current };
}

module.exports = { createMcpService };
