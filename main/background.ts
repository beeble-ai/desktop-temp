import { app, dialog, ipcMain, BrowserWindow } from "electron";
import * as log from "electron-log";
import { promisify } from "util";
import serve from "electron-serve";
import { createWindow } from "./helpers";
import { initializeAutoUpdater, autoUpdater } from "./helpers/update-handler"; // Import updateInterval too

const isProd: boolean = process.env.NODE_ENV === "production";

if (isProd) {
  serve({ directory: "app" });
} else {
  app.setPath("userData", `${app.getPath("userData")} (development)`);
}

// initializeAutoUpdater(); // Set up the auto-updater event listeners

(async () => {
  await app.whenReady();

  const mainWindow = createWindow("main", {
    width: 1000,
    height: 600,
  });

  if (isProd) {
    await mainWindow.loadURL("app://./home.html");
  } else {
    const port = process.argv[2];
    await mainWindow.loadURL(`http://localhost:${port}/home`);
    mainWindow.webContents.openDevTools();
  }

  // Check for update on startup
  // autoUpdater.checkForUpdatesAndNotify();
})();

app.on("window-all-closed", () => {
  app.quit();
});

async function isModelUpdateRequired(remoteModelVersion) {
  const fs = require("fs");
  const path = require("path");
  const localConfig = require("./engine-config.json");
  const localModelVersion = Object.keys(localConfig["model"])[0];

  let modelUpdateRequired = false;

  // If model version is different, then update the model
  if (localModelVersion != remoteModelVersion) {
    console.log("Model version is different");
    log.info("Model version is different");
    modelUpdateRequired = true;
  }

  // If model is not saved in local, then update the model
  for (const file of localConfig["model"][localModelVersion]) {
    if (!fs.existsSync(path.join("engine", file))) {
      console.log("Model file is missing", file);
      log.info("Model file is missing", file);
      modelUpdateRequired = true;
      break; // No need to continue checking further once one file is found missing.
    }
  }

  return modelUpdateRequired;
}

ipcMain.on("compare-and-download-engine", async (event, args) => {
  const fs = require("fs");
  const path = require("path");
  const fetch = require("node-fetch");
  const streamPipeline = promisify(require("stream").pipeline);

  log.info(__dirname);
  log.info(app.getAppPath());

  const localConfig = require("./engine-config.json");

  const response = await fetch(
    "https://desktop.beeble.ai/engine/engine-config.json"
  );
  const remoteConfig = await response.json();

  let filesToDownloadMap = {};

  for (const section of Object.keys(remoteConfig)) {
    // Skip model. It needs to be downloaded after api-key is submitted
    if (section === "model") {
      continue;
    }

    for (const version of Object.keys(remoteConfig[section])) {
      const remoteFiles = remoteConfig[section][version];
      const localVersion = Object.keys(localConfig[section] || {})[0];

      let filesToDownload = [];

      // Determine the save directory
      let saveDirectory = "./engine";
      if (section === "sample_images") {
        saveDirectory = "./sample_images";
      }

      // If versions differ, download all files from the remote version
      if (version !== localVersion) {
        filesToDownload = remoteFiles;
      } else {
        // For matching versions, download only the files that do not exist in the local directory
        filesToDownload = remoteFiles.filter((file) => {
          const filePath = path.join(__dirname, saveDirectory, file);
          return !fs.existsSync(filePath);
        });
      }

      // Add these files to filesToDownloadMap
      if (!filesToDownloadMap[section]) {
        filesToDownloadMap[section] = {};
      }
      filesToDownloadMap[section][version] = filesToDownload;
    }
  }

  // Compute totalFiles and downloadedFiles based on filesToDownloadMap
  let totalFiles = 0;
  let downloadedFiles = 0;
  for (const section in filesToDownloadMap) {
    for (const version in filesToDownloadMap[section]) {
      totalFiles += filesToDownloadMap[section][version].length;
    }
  }

  log.info(`Downloading ${totalFiles} files`);
  console.log(`Downloading ${totalFiles} files`);

  // Now proceed with actual downloading
  for (const section in filesToDownloadMap) {
    log.info(section);
    for (const version in filesToDownloadMap[section]) {
      const filesToDownload = filesToDownloadMap[section][version];
      log.info(filesToDownload);
      // Determine the save directory
      let saveDirectory = "./engine";
      if (section === "sample_images") {
        saveDirectory = "./sample_images";
      }
      // Determine the base path for this section and version
      let basePath = section;
      if (section === "thirdparty_libs" && version === "base") {
        basePath = `${section}/base`;
      } else {
        basePath = `${section}/${version}`;
      }

      for (const file of filesToDownload) {
        const filePath = path.join(__dirname, saveDirectory, file);
        const url = `https://desktop.beeble.ai/engine/${basePath}/${file}`;
        const response = await fetch(url);

        log.info(filePath, url, response);

        if (!response.ok) {
          log.info(`Failed to download file`);
          throw new Error(
            `Failed to download file ${url}. Status: ${response.statusText}`
          );
        }

        // Create a directory if it doesn't exist
        const parentDirectory = path.dirname(filePath);
        log.info(parentDirectory, url, response);
        if (!fs.existsSync(parentDirectory)) {
          fs.mkdirSync(parentDirectory, { recursive: true });
          log.info("parent directory is made");
        }

        // Download and save the file to the specified directory
        await streamPipeline(response.body, fs.createWriteStream(filePath));
        downloadedFiles++;
        const percentage = Math.floor((downloadedFiles / totalFiles) * 100);
        log.info(`Downloaded ${percentage}%`);
        console.log(`Downloaded ${percentage}%`);

        // Send the progress percentage to the progress window
        event.reply("compare-and-download-engine", percentage);
      }
    }
  }

  event.reply("compare-and-download-engine", "complete");
});

ipcMain.on("api-key-submitted", (event, apiKey) => {
  const fs = require("fs");
  const path = require("path");
  const fetch = require("node-fetch");

  const apiKeyFilePath = path.join(__dirname, "api-key.txt");
  fs.writeFileSync(apiKeyFilePath, apiKey);
});

ipcMain.on("initialize-engine", async (event) => {
  const fs = require("fs");
  const path = require("path");

  // Get engine executable path
  let exeFolderPath = await path.join(__dirname, "engine");
  let exePath = await path.join(exeFolderPath, "SwitchLight.exe");

  // Read the api-key.txt file
  const apiKeyFilePath = path.join(__dirname, "api-key.txt");
  const apiKey = fs.readFileSync(apiKeyFilePath, "utf8");

  // Check if model update is required
  const response = await fetch(
    "https://desktop.beeble.ai/engine/engine-config.json"
  );
  const remoteConfig = await response.json();
  const remoteModelVersion = Object.keys(remoteConfig["model"])[0];

  const modelUpdateRequired = await isModelUpdateRequired(remoteModelVersion);

  console.log("modelUpdateRequired", modelUpdateRequired);

  // Construct the command
  let command = `${exePath} -m init -k ${apiKey}${
    modelUpdateRequired ? " --download-model" : ""
  } --model-version ${remoteModelVersion}`;
  let option = { cwd: exeFolderPath };
  // Set the modelPath based on the mode
  const { exec } = require("child_process");
  return new Promise((resolve, reject) => {
    exec(command, option, (error, stdout, stderr) => {
      if (error) {
        console.log("Error during engine initialization:", error);
        reject(error);
        return;
      }

      // Update the local configuration file only after successful execution
      fs.writeFileSync(
        "./engine-config.json",
        JSON.stringify(remoteConfig, null, 4)
      );
      resolve(stdout);
    });
  });
});
