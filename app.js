require("dotenv").config();

const puppeteer = require("puppeteer-core");
const dayjs = require("dayjs");
const cheerio = require("cheerio");
const fs = require("fs");
const inquirer = require("./input");
const treekill = require("tree-kill");

let run = true;
let firstRun = true;
let cookie = null;

// ========================================== CONFIG SECTION =================================================================
const stream = process.env.stream || "gaules";
const baseUrl = "https://www.twitch.tv/";
const streamUrl = baseUrl + stream;

const configPath = "./config.json"
const screenshotFolder = "./screenshots/";

const userAgent = process.env.userAgent || "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.108 Safari/537.36";

const proxy = process.env.proxy || ""; // "ip:port" By https://github.com/Jan710
const proxyAuth = process.env.proxyAuth || "";

const browserScreenshot = process.env.browserScreenshot || true;

const browserConfig = {
  headless: process.env.headlessMode || true,
  args: [
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--no-first-run",
    "--no-zygote",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--single-process",
    "--disable-notifications",
    "--disable-geolocation",
    "--disable-infobars",
    "--silent-debugger-extension-api",
  ]
}; //https://github.com/D3vl0per/Valorant-watcher/issues/24

const cookiePolicyQuery = "button[data-a-target='consent-banner-accept']";
const matureContentQuery = "button[data-a-target='player-overlay-mature-accept']";
const sidebarQuery = "*[data-test-selector='user-menu__toggle']";
const userStatusQuery = "span[data-a-target='presence-text']";
const streamPauseQuery = "button[data-a-target='player-play-pause-button']";
const streamSettingsQuery = "[data-a-target='player-settings-button']";
const streamQualitySettingQuery = "[data-a-target='player-settings-menu-item-quality']";
const streamQualityQuery = "input[data-a-target='tw-radio']";
// ========================================== CONFIG SECTION =================================================================

const watchStream = async (browser, page) => {
  await page.goto(baseUrl, {
    "waitUntil": "networkidle0",
  });

  console.log("🔐 Checking login...");
  await checkLogin(page);

  let lastRefresh = dayjs().add(1, "hour");
  while (run) {
    try {
      if (dayjs(lastRefresh).isBefore(dayjs())) {
        const newSpawn = await restartBrowser(browser, page);
        browser = newSpawn.browser;
        page = newSpawn.page;
        lastRefresh = dayjs().add(1, "hour");
      }

      console.log("\n🔗 Now watching streamer: ", streamUrl);

      await page.goto(streamUrl, {
        "waitUntil": "networkidle2",
      }); //https://github.com/puppeteer/puppeteer/blob/master/docs/api.md#pagegobackoptions

      const isOffline = await queryOnWebsite(page, ".channel-root__player--offline");

      if (isOffline.length === 0) {
        await clickWhenExist(page, cookiePolicyQuery);
        await clickWhenExist(page, matureContentQuery); //Click on accept button

        await page.waitFor(5000)

        if (firstRun) {
          console.log("🔧 Setting lowest possible resolution..");
          await clickWhenExist(page, streamPauseQuery);

          await clickWhenExist(page, streamSettingsQuery);
          await page.waitFor(streamQualitySettingQuery);

          await clickWhenExist(page, streamQualitySettingQuery);
          await page.waitFor(streamQualityQuery);

          const resolutionOptions = await queryOnWebsite(page, streamQualityQuery);
          const lowestResolutionId = resolutionOptions[resolutionOptions.length - 1].attribs.id;
          await page.evaluate((lowestResolutionId) => {
            document.getElementById(lowestResolutionId).click();
          }, lowestResolutionId);

          await clickWhenExist(page, streamPauseQuery);

          await page.keyboard.press("m"); //For unmute
          firstRun = false;
        }

        if (browserScreenshot) {
          await page.waitFor(1000);
          fs.access(screenshotFolder, error => {
            if (error) {
              fs.promises.mkdir(screenshotFolder);
            }
          });
          await page.screenshot({
            path: `${screenshotFolder}${stream}.png`
          });
          console.log("📸 Screenshot created: " + `${stream}.png`);
        }

        await clickWhenExist(page, sidebarQuery); //Open sidebar
        await page.waitFor(userStatusQuery); //Waiting for sidebar
        const status = await queryOnWebsite(page, userStatusQuery); //status jQuery
        await clickWhenExist(page, sidebarQuery); //Close sidebar

        console.log("💡 Account status:", status[0] ? status[0].children[0].data : "Unknown");
      } else {
        console.log("💡 Stream Offline!");
      }

      console.log("🕒 Time: " + dayjs().format("HH:mm:ss"));
      await page.waitFor(1 * 60 * 60 * 1000); // 1 Hour
    } catch (e) {
      console.log("🤬 Error: ", e);
    }
  }
}

const readLoginData = async () => {
  const cookie = [{
    "domain": ".twitch.tv",
    "hostOnly": false,
    "httpOnly": false,
    "name": "auth-token",
    "path": "/",
    "sameSite": "no_restriction",
    "secure": true,
    "session": false,
    "storeId": "0",
    "id": 1
  }];

  try {
    console.log("🔎 Checking config file...");

    if (fs.existsSync(configPath)) {
      console.log("✅ Json config found!");

      const configFile = JSON.parse(fs.readFileSync(configPath, "utf8"))

      if (proxy) browserConfig.args.push("--proxy-server=" + proxy);
      browserConfig.executablePath = configFile.exec;
      cookie[0].value = configFile.token;

      return cookie;
    } else if (process.env.token) {
      console.log("✅ Env config found");

      if (proxy) browserConfig.args.push("--proxy-server=" + proxy);
      cookie[0].value = process.env.token; //Set cookie from env
      browserConfig.executablePath = "/usr/bin/google-chrome"; //For docker container

      return cookie;
    } else {
      console.log("❌ No config file found!");

      const input = await inquirer.askLogin();

      fs.writeFile(configPath, JSON.stringify(input), err => err && console.log(err));

      if (proxy) browserConfig.args[6] = "--proxy-server=" + proxy;
      browserConfig.executablePath = input.exec;
      cookie[0].value = input.token;

      return cookie;
    }
  } catch (err) {
    console.log("🤬 Error: ", e);
  }
}

const startBrowser = async () => {
  console.log("=========================");
  console.log("📱 Launching browser...");
  const browser = await puppeteer.launch(browserConfig);
  const page = await browser.newPage();

  console.log("🔧 Setting User-Agent...");
  await page.setUserAgent(userAgent);

  console.log("🔧 Setting auth token...");
  await page.setCookie(...cookie);

  console.log("⏰ Setting timeouts...");
  await page.setDefaultNavigationTimeout(process.env.timeout || 0);
  await page.setDefaultTimeout(process.env.timeout || 0);
  
  await page.setViewport({ width: 1024, height: 768 });

  if (proxyAuth) {
    await page.setExtraHTTPHeaders({
      "Proxy-Authorization": "Basic " + Buffer.from(proxyAuth).toString("base64")
    })
  }

  return {
    browser,
    page
  };
}

const checkLogin = async (page) => {
  const cookieSetByServer = await page.cookies();
  for (let i = 0; i < cookieSetByServer.length; i++) {
    if (cookieSetByServer[i].name == "twilight-user") {
      console.log("✅ Login successful!");
      return true;
    }
  }
  console.log("🛑 Login failed!");
  console.log("🔑 Invalid token!");
  console.log("\nPlease ensure that you have a valid twitch auth-token.\nhttps://github.com/D3vl0per/Valorant-watcher#how-token-does-it-look-like");
  if (!process.env.token) {
    fs.unlinkSync(configPath);
  }
  process.exit();
}

const clickWhenExist = async (page, query) => {
  const result = await queryOnWebsite(page, query);

  try {
    if (result[0].type == "tag" && result[0].name == "button") {
      await page.click(query);
      await page.waitFor(500);
      return;
    }
  } catch (e) {}
}

const queryOnWebsite = async (page, query) => {
  const bodyHTML = await page.evaluate(() => document.body.innerHTML);
  const $ = cheerio.load(bodyHTML);
  const jquery = $(query);
  return jquery;
}

const restartBrowser = async (browser) => {
  const pages = await browser.pages();
  await pages.map((page) => page.close());
  await treekill(browser.process().pid, "SIGKILL");
  return await startBrowser();
}

const shutDown = async () => {
  console.log("\n👋Bye Bye👋");
  run = false;
  process.exit();
}

const startWatcher = async () => {
  console.clear();
  console.log("=========================");
  cookie = await readLoginData();
  const {
    browser,
    page
  } = await startBrowser();
  console.log("=========================");
  console.log("🔭 Running watcher...");
  console.log("=========================");
  await watchStream(browser, page);
};

startWatcher();

process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);
