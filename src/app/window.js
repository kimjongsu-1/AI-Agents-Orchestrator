const path = require("path");
const { BrowserWindow, nativeTheme } = require("electron");

function createWindow() {
  nativeTheme.themeSource = "light";

  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    title: "AI 오케스트레이터",
    backgroundColor: "#f5f7fa",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  return win;
}

module.exports = { createWindow };
