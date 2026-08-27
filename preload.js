// 렌더러(화면)에 딱 하나만 열어줍니다 — 연결 실패 화면의 「다시 시도」 버튼.
//
// contextIsolation 이 켜져 있으므로 페이지 스크립트는 Node 에 못 닿습니다.
// 여기서 노출한 window.daol.retry() 는 「앱 주소를 다시 불러오라」는 신호일 뿐이라,
// 원격 페이지가 이걸 호출해도 새로고침 이상의 일은 일어나지 않습니다.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("daol", {
  retry: () => ipcRenderer.send("daol:retry"),
  // 작업 공간이 「어떤 화면들이 있는지」를 알려주면, 그걸로 상단 메뉴를 만듭니다.
  //
  // 화면 이름을 앱 쪽에 박아두면 화면이 늘어날 때마다 실행파일을 다시 배포해야 합니다.
  // 목록의 단일 출처는 웹 쪽(views.ts / hr-nav.ts)이고, 앱은 받아 쓰기만 합니다.
  registerApps: (payload) => ipcRenderer.send("daol:apps", payload),
});
