import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // dev 서버가 이제 -H 없이 0.0.0.0으로 뜨는데(컨테이너에서 접속 가능해야 해서), 그러면
  // 표준 호스트는 "localhost"가 되어 이 프로젝트가 계속 써온 "127.0.0.1"로 접속하면 HMR이
  // cross-origin으로 막힌다 — 127.0.0.1을 허용 목록에 추가해 그대로 쓸 수 있게 한다.
  allowedDevOrigins: ["127.0.0.1"],
  // 개발 모드의 라우트 표시 배지(기본 bottom-left)가 사이드바 하단의 "Sol made it" 문구와
  // 겹쳐서 오른쪽 아래로 옮긴다.
  devIndicators: {
    position: "bottom-right",
  },
  // pdf-parse(pdfjs-dist)는 워커 스크립트를 런타임에 파일 경로로 직접 찾는데, webpack이
  // 서버 코드를 번들로 묶어버리면 그 경로가 사라져 "Setting up fake worker failed"로 계속
  // 실패한다(예외가 나는데도 호출부의 catch가 삼켜서 "PDF 양식을 인식 못함"으로 잘못 보임).
  // Node의 기본 require로 그대로 불러오게 번들링에서 제외해야 한다.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
      {
        // 인보이스 PDF는 화면 안 미리보기 팝업에서 iframe으로 띄운다 — 전체 DENY보다 뒤에
        // 와서 이 경로만 SAMEORIGIN으로 완화한다(외부 사이트의 임베드는 여전히 막힘).
        source: "/api/tax-invoice-file/:path*",
        headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
      },
    ];
  },
};

export default nextConfig;
