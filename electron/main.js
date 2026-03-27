"use strict";

const path = require("path");
const { app, BrowserWindow, dialog, shell } = require("electron");

let startServer = null;
let stopServer = null;

let mainWindow = null;
let serverRuntime = null;
let isQuitting = false;

async function ensureServerRuntime() {
  if (serverRuntime) return serverRuntime;
  if (!startServer || !stopServer) {
    process.env.MAC_DASHBOARD_DATA_DIR = path.join(app.getPath("userData"), "runtime");
    ({ startServer, stopServer } = require("../server"));
  }
  serverRuntime = await startServer({ port: 0, host: "127.0.0.1" });
  return serverRuntime;
}

async function createMainWindow() {
  const runtime = await ensureServerRuntime();

  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#111213",
    title: "Mac Sensors Dashboard",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  await window.loadURL(runtime.url);
  return window;
}

async function shutdownRuntime() {
  if (!serverRuntime) return;
  const runtime = serverRuntime;
  serverRuntime = null;
  await stopServer(runtime.server);
}

app.whenReady().then(async () => {
  try {
    mainWindow = await createMainWindow();

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = await createMainWindow();
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("Avvio app fallito", message);
    await shutdownRuntime().catch(() => {});
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  shutdownRuntime()
    .catch(() => {})
    .finally(() => {
      app.quit();
    });
});
