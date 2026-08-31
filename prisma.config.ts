import "dotenv/config";
import path from "node:path";
import { defineConfig } from "@prisma/config";

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  datasource: {
    // 배포 빌드 컨테이너에는 DATABASE_URL이 없다(런타임에만 주입됨).
    // `prisma generate`는 실제 접속 없이 스키마만 읽으므로 빈 값이어도 무방하다.
    url: process.env.DATABASE_URL ?? "",
  },
});
