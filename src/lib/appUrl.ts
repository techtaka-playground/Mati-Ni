// 초대 링크를 만들 때 쓰는 기준 주소. 지금은 로컬(127.0.0.1)에서만 접속되므로 초대받은
// 사람이 다른 컴퓨터에서 열려면 서버를 네트워크에서 접근 가능하게 배포하고 .env의 APP_URL을
// 그 주소로 바꿔야 한다 — 그 전까지는 초대 링크도 로컬에서만 열린다.
export function getAppUrl(): string {
  return (process.env.APP_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
}
