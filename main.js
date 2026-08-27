// 다올로직스 데스크톱 앱 (Electron 셸).
//
// 이 앱은 프로그램을 **다시 만든 것이 아닙니다.** 배포된 화면을 전용 창으로 열어주는
// 껍데기입니다. 계산도 데이터도 전부 서버(Cloudflare + Supabase)에 있으므로,
// 실행파일을 새로 배포하지 않아도 화면 수정은 그대로 따라옵니다.
//
// 그래서 이 파일이 하는 일은 네 가지뿐입니다:
//   ① 주소를 알고 그 창을 띄운다        ② 로그인 상태를 기억한다
//   ③ 연결이 안 되면 그렇다고 말한다     ④ 바깥 링크는 기본 브라우저로 보낸다
//
// 🔴 주소를 코드에 박지 않았습니다. app-config.json 에서 읽고, 없으면 **에러 화면을
//    띄우고 멈춥니다.** 기본값을 두면 주소가 바뀐 뒤에도 옛 사이트를 조용히 계속
//    열게 되는데, 그게 「되는 것처럼 보이는데 안 되는」 제일 나쁜 상태입니다.
//    (같은 이유로 저장소 전체에서 요율·발신주소의 기본값을 걷어냈습니다.)

const { app, BrowserWindow, Menu, shell, dialog, ipcMain, session } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("fs");
const path = require("path");

const CONFIG_FILE = "app-config.json";

// 창 크기·위치를 기억해 둘 파일. userData 는 %APPDATA%\다올로직스 입니다.
const stateFile = () => path.join(app.getPath("userData"), "window-state.json");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 앱 주소를 정합니다. 우선순위:
 *   ① 환경변수 DAOL_APP_URL     — 임시 확인용 (개발/미리보기 서버)
 *   ② userData 의 app-config.json — 설치 후 관리자가 바꿔 넣는 자리
 *   ③ 설치본에 들어 있는 app-config.json
 * 셋 다 없으면 null 을 돌려주고, 호출한 쪽이 에러 화면을 띄웁니다.
 */
function resolveConfig() {
  const bundled = readJson(path.join(__dirname, CONFIG_FILE)) || {};
  const userCfg = readJson(path.join(app.getPath("userData"), CONFIG_FILE)) || {};
  // 설정은 **합칩니다.** 예전에는 DAOL_APP_URL 만 주면 나머지(창 제목·시작 화면)가
  // 통째로 사라져서, 개발 중에만 다른 화면이 뜨는 혼란이 있었습니다.
  const merged = { ...bundled, ...userCfg };

  const fromEnv = (process.env.DAOL_APP_URL || "").trim();
  if (fromEnv) return { ...merged, appUrl: fromEnv, source: "환경변수 DAOL_APP_URL" };

  const userUrl = typeof userCfg.appUrl === "string" ? userCfg.appUrl.trim() : "";
  if (userUrl) return { ...merged, appUrl: userUrl, source: "사용자 설정 파일" };

  const bundledUrl = typeof bundled.appUrl === "string" ? bundled.appUrl.trim() : "";
  if (bundledUrl) return { ...merged, appUrl: bundledUrl, source: "설치본 설정" };

  return null;
}

const config = { value: null, origin: null };
let mainWindow = null;

// 작업 공간이 알려준 모듈·화면 목록. 받기 전에는 「작업 공간 열기」만 보입니다.
let appMenuData = { modules: [] };

/**
 * 상단 메뉴에서 화면을 엽니다.
 *
 * 주소를 바꾸는 방식(location.href = "/settlement/dashboard")으로 하면 페이지가 새로
 * 뜨면서 **열어둔 창이 전부 닫힙니다.** 그래서 작업 공간이면 이벤트만 던지고,
 * 아직 작업 공간이 아니면 그때만 한 번 이동한 뒤 이어서 엽니다.
 */
function openAppInPage(key) {
  if (!mainWindow) return;
  const k = JSON.stringify(key);
  const js =
    "(() => { try {" +
    "  if (location.pathname.indexOf('/workspace') === 0) {" +
    "    window.dispatchEvent(new CustomEvent('daol:open-app', { detail: " + k + " }));" +
    "  } else {" +
    "    sessionStorage.setItem('daol_pending_app', " + k + ");" +
    "    location.href = '/workspace';" +
    "  }" +
    "} catch (e) {} })()";
  mainWindow.webContents.executeJavaScript(js).catch(() => {});
}

/** 모듈(정산·인사…)의 대문을 엽니다. */
function openModuleInPage(moduleKey) {
  if (!mainWindow) return;
  const k = JSON.stringify(moduleKey);
  const js =
    "(() => { try {" +
    "  if (location.pathname.indexOf('/workspace') === 0) {" +
    "    window.dispatchEvent(new CustomEvent('daol:open-module', { detail: " + k + " }));" +
    "  } else {" +
    "    location.href = '/workspace';" +
    "  }" +
    "} catch (e) {} })()";
  mainWindow.webContents.executeJavaScript(js).catch(() => {});
}

function goWorkspace() {
  if (!mainWindow) return;
  mainWindow.webContents
    .executeJavaScript("location.href = '/workspace'")
    .catch(() => {});
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ ...b, maximized: win.isMaximized() }, null, 2),
      "utf8"
    );
  } catch {
    // 상태 저장 실패로 앱이 죽으면 안 됩니다. 다음에 기본 크기로 열릴 뿐입니다.
  }
}

function showError(win, title, detail) {
  const html = `<!doctype html><meta charset="utf-8">
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0E1620;color:#EDEFF2;font-family:'Malgun Gothic','맑은 고딕',sans-serif}
  .box{max-width:460px;text-align:center;padding:32px}
  h1{font-size:17px;margin:0 0 10px}
  p{font-size:13px;line-height:1.8;color:#8C99A6;margin:0 0 20px;white-space:pre-line}
  button{background:#2FBF9F;color:#04342C;border:0;border-radius:6px;
         padding:10px 22px;font-size:13px;font-weight:700;cursor:pointer}
  code{color:#E8A33D;font-size:12px}
</style>
<div class="box">
  <h1>${title}</h1>
  <p>${detail}</p>
  <button onclick="window.daol && window.daol.retry()">다시 시도</button>
</div>`;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

function loadApp(win) {
  if (!config.value) {
    showError(
      win,
      "앱 주소가 설정되지 않았습니다",
      "app-config.json 의 appUrl 이 비어 있습니다.\n관리자에게 문의하거나 설치본을 다시 받아주세요."
    );
    return;
  }
  // 기본으로 여는 곳은 작업 공간입니다 (창을 여러 개 띄우는 화면).
  // 예전처럼 한 화면씩 보고 싶으면 그 화면 오른쪽 위 「기본 화면」으로 갈 수 있습니다.
  const start = (config.value.startPath || "").trim();
  win.loadURL(start ? new URL(start, config.value.appUrl).toString() : config.value.appUrl);
}

function createWindow() {
  const saved = readJson(stateFile()) || {};
  mainWindow = new BrowserWindow({
    width: saved.width || 1280,
    height: saved.height || 860,
    x: saved.x,
    y: saved.y,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0E1620", // 흰 화면이 번쩍이지 않게 (기본 테마가 어둡습니다)
    title: (config.value && config.value.windowTitle) || "다올로직스",
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // 원격 화면을 여는 창이므로 Node 접근은 전부 막습니다.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  if (saved.maximized) mainWindow.maximize();

  // 연결 실패(-6 파일없음 등 사소한 것 제외)면 이유를 화면에 씁니다.
  // 그냥 두면 흰 화면만 나와서 "프로그램이 고장났다"고 오해합니다.
  mainWindow.webContents.on("did-fail-load", (_e, errorCode, errorDesc, url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = 사용자가 취소
    showError(
      mainWindow,
      "서버에 연결하지 못했습니다",
      `${errorDesc} (${errorCode})\n주소: ${url}\n\n` +
        "인터넷 연결을 확인하고 다시 시도해주세요.\n계속 안 되면 관리자에게 알려주세요."
    );
  });

  // 새 창(target=_blank)·다른 사이트로 나가는 링크는 기본 브라우저로 보냅니다.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    try {
      if (new URL(url).origin !== config.origin) {
        e.preventDefault();
        shell.openExternal(url);
      }
    } catch {
      e.preventDefault();
    }
  });

  mainWindow.on("close", () => saveWindowState(mainWindow));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  loadApp(mainWindow);
}

// ── 자동 업데이트 ────────────────────────────────────────────────
//
// ⚠️ 헷갈리기 쉬운 부분: **화면이 바뀌는 것과 이 업데이트는 아무 상관이 없습니다.**
//    정산 화면은 서버에서 그때그때 받아오므로 배포하면 바로 반영됩니다
//    (열어둔 창에는 「새 버전이 배포됐습니다」 안내가 뜹니다).
//    여기서 업데이트하는 것은 **이 껍데기 자체**입니다 — 메뉴·창 동작·접속 주소.
//    그래서 자주 일어나지 않습니다.
//
// 배포처는 공개 저장소(daol-logics-desktop)입니다. 정산 저장소는 비공개라
// 거기서 받으려면 토큰을 앱 안에 넣어야 하는데, 그러면 설치본을 가진 사람이
// 토큰을 꺼내 소스 전체를 읽을 수 있습니다. 그래서 **바이너리만 있는 공개
// 저장소**를 따로 두고, 앱에는 아무 비밀도 넣지 않았습니다.

let updateState = "idle"; // idle | checking | downloading | ready
let manualCheck = false;

function initUpdater() {
  // 개발 중(npm start)에는 패키징이 안 돼 있어서 electron-updater 가 예외를 던집니다.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  // 받아만 두고, 설치는 앱을 끌 때 합니다. 정산 작업 도중에 창이 닫히면 안 됩니다.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    updateState = "downloading";
    if (manualCheck) {
      manualCheck = false;
      dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "업데이트",
        message: `새 버전 ${info.version} 을 받는 중입니다.`,
        detail: "다 받으면 다시 알려드립니다. 그동안 계속 쓰셔도 됩니다.",
        buttons: ["확인"],
      });
    }
  });

  autoUpdater.on("update-not-available", () => {
    updateState = "idle";
    if (manualCheck) {
      manualCheck = false;
      dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "업데이트",
        message: "최신 버전입니다.",
        detail: `현재 ${app.getVersion()}`,
        buttons: ["확인"],
      });
    }
  });

  autoUpdater.on("error", (err) => {
    updateState = "idle";
    // 자동 확인이 실패하는 것(사내망 차단·오프라인)까지 매번 알리면 성가십니다.
    // 다만 사람이 직접 눌러 확인한 경우에는 **왜 안 되는지 반드시 말해줍니다.**
    if (manualCheck) {
      manualCheck = false;
      dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "업데이트 확인 실패",
        message: "업데이트를 확인하지 못했습니다.",
        detail: String((err && err.message) || err),
        buttons: ["확인"],
      });
    }
  });

  autoUpdater.on("update-downloaded", async (info) => {
    updateState = "ready";
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "업데이트 준비 완료",
      message: `새 버전 ${info.version} 을 설치할 준비가 됐습니다.`,
      detail:
        "지금 다시 시작하면 바로 적용됩니다.\n" +
        "나중에를 고르면 앱을 끌 때 자동으로 설치됩니다.\n\n" +
        "※ 정산 화면 자체는 이미 최신입니다. 이건 프로그램 껍데기 업데이트입니다.",
      buttons: ["나중에", "지금 다시 시작"],
      defaultId: 1,
      cancelId: 0,
    });
    if (response === 1) {
      saveWindowState(mainWindow);
      autoUpdater.quitAndInstall();
    }
  });

  // 켠 직후는 화면 뜨는 것부터 끝내고, 잠시 뒤에 조용히 확인합니다.
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 8000);
  // 종일 켜두는 앱이라 하루에 두 번쯤 다시 봅니다.
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 12 * 60 * 60 * 1000);
}

function checkForUpdatesManually() {
  if (!app.isPackaged) {
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "업데이트",
      message: "개발 모드에서는 업데이트를 확인하지 않습니다.",
      buttons: ["확인"],
    });
    return;
  }
  if (updateState === "ready") {
    autoUpdater.emit("update-downloaded", { version: "받아둔 버전" });
    return;
  }
  manualCheck = true;
  autoUpdater.checkForUpdates().catch(() => {});
}

function buildMenu() {
  const template = [
    {
      label: "파일",
      submenu: [
        {
          label: "작업 공간",
          accelerator: "CmdOrCtrl+0",
          click: () => goWorkspace(),
        },
        { type: "separator" },
        {
          label: "새로고침",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow && mainWindow.webContents.reload(),
        },
        {
          label: "인쇄",
          accelerator: "CmdOrCtrl+P",
          click: () => mainWindow && mainWindow.webContents.print(),
        },
        { type: "separator" },
        { role: "quit", label: "종료" },
      ],
    },
    // 파일과 편집 사이에 **업무 모듈**이 옵니다 (정산·인사, 앞으로 붙을 것들).
    //
    // 하위 메뉴를 달지 않습니다. 누르면 곧바로 그 모듈의 **대문**이 뜹니다.
    // 상세 화면은 작업 공간 **좌측 메뉴**에서 고르는 것이 기본 경로인데,
    // 창 메뉴에도 같은 목록을 늘어놓으니 길이 두 개가 되어 오히려 헷갈렸습니다
    // (2026-08-27 하위 메뉴 제거).
    //
    // 목록 자체는 여전히 화면이 알려준 것을 씁니다 — 앱에 모듈 이름을 박으면
    // 모듈이 늘어날 때마다 실행파일을 다시 배포해야 합니다.
    ...appMenuData.modules.map((m) => ({
      label: m.planned ? m.label + " (준비 중)" : m.label,
      click: () => openModuleInPage(m.key),
    })),
    {
      label: "편집",
      submenu: [
        { role: "undo", label: "실행 취소" },
        { role: "redo", label: "다시 실행" },
        { type: "separator" },
        { role: "cut", label: "잘라내기" },
        { role: "copy", label: "복사" },
        { role: "paste", label: "붙여넣기" },
        { role: "selectAll", label: "전체 선택" },
      ],
    },
    {
      label: "보기",
      submenu: [
        {
          label: "뒤로",
          accelerator: "Alt+Left",
          click: () => mainWindow && mainWindow.webContents.navigationHistory.canGoBack() && mainWindow.webContents.navigationHistory.goBack(),
        },
        {
          label: "앞으로",
          accelerator: "Alt+Right",
          click: () => mainWindow && mainWindow.webContents.navigationHistory.canGoForward() && mainWindow.webContents.navigationHistory.goForward(),
        },
        { type: "separator" },
        // 표가 많은 화면이라 확대/축소를 자주 씁니다.
        { role: "resetZoom", label: "기본 크기" },
        { role: "zoomIn", label: "확대" },
        { role: "zoomOut", label: "축소" },
        { type: "separator" },
        { role: "togglefullscreen", label: "전체 화면" },
        { role: "toggleDevTools", label: "개발자 도구" },
      ],
    },
    {
      label: "도움말",
      submenu: [
        {
          label: "이 앱에 대하여",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "다올로직스",
              message: `다올로직스 정산·인사 관리 시스템`,
              detail:
                `앱 버전 ${app.getVersion()}\n` +
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}\n\n` +
                `접속 주소: ${config.value ? config.value.appUrl : "(설정 없음)"}\n` +
                `주소 출처: ${config.value ? config.value.source : "-"}\n\n` +
                `화면과 데이터는 서버에 있습니다. 화면이 바뀌어도 이 앱을\n` +
                `다시 설치할 필요는 없습니다 — 새로고침(Ctrl+R)만 하면 됩니다.\n\n` +
                `프로그램 업데이트: github.com/hayulpapax/daol-logics-desktop\n` +
                `(껍데기가 바뀔 때만 받습니다. 자동으로 확인합니다.)`,
              buttons: ["확인"],
            });
          },
        },
        {
          label: "업데이트 확인",
          click: () => checkForUpdatesManually(),
        },
        {
          label: "브라우저로 열기",
          click: () => config.value && shell.openExternal(config.value.appUrl),
        },
        {
          label: "로그인 정보 지우기",
          click: async () => {
            const { response } = await dialog.showMessageBox(mainWindow, {
              type: "warning",
              title: "로그인 정보 지우기",
              message: "저장된 로그인 정보를 지울까요?",
              detail: "이 PC 에서 로그아웃되고 로그인 화면부터 다시 시작합니다.",
              buttons: ["취소", "지우기"],
              defaultId: 0,
              cancelId: 0,
            });
            if (response !== 1) return;
            await session.defaultSession.clearStorageData();
            loadApp(mainWindow);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 두 번 실행하면 새 창을 띄우지 말고 이미 떠 있는 창을 앞으로 가져옵니다.
// (같은 계정으로 창 두 개를 띄워놓고 한쪽에서만 저장하는 사고를 막습니다.)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    config.value = resolveConfig();
    try {
      config.origin = config.value ? new URL(config.value.appUrl).origin : null;
    } catch {
      config.value = null;
    }
    buildMenu();
    createWindow();
    initUpdater();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  ipcMain.on("daol:retry", () => mainWindow && loadApp(mainWindow));

  // 작업 공간이 뜰 때마다 화면 목록을 보내옵니다. 받을 때마다 메뉴를 다시 만듭니다.
  ipcMain.on("daol:apps", (_e, payload) => {
    if (!payload || !Array.isArray(payload.modules)) return;
    appMenuData = { modules: payload.modules };
    buildMenu();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
