// 렌더러(화면)에 딱 하나만 열어줍니다 — 연결 실패 화면의 「다시 시도」 버튼.
//
// contextIsolation 이 켜져 있으므로 페이지 스크립트는 Node 에 못 닿습니다.
// 여기서 노출한 window.daol.retry() 는 「앱 주소를 다시 불러오라」는 신호일 뿐이라,
// 원격 페이지가 이걸 호출해도 새로고침 이상의 일은 일어나지 않습니다.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("daol", {
  retry: () => ipcRenderer.send("daol:retry"),
});
