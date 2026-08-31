// 로그인 비밀번호를 잊었을 때 쓰는 복구 도구. **이 컴퓨터에서 직접 실행하는 CLI**다.
//
// 왜 웹 화면이 아니라 CLI인가: 비밀번호 재설정 화면을 로그인 없이 열어두면 앱에 접근할 수
// 있는 누구나 관리자 계정을 가져갈 수 있다. 이 앱은 메일 발송 기능이 없어서 "본인 확인 메일"
// 같은 절차를 만들 수도 없다. 반면 CLI는 이미 서버 코드와 DB 접속정보(DATABASE_URL)를 직접
// 만질 수 있는 사람만 쓸 수 있으므로, 새로 열리는 공격 경로가 없다.
//
//   npm run reset-password -- --list
//   npm run reset-password -- sol@techtaka.com "새비밀번호"
//
// 비밀번호는 앱 로그인과 똑같이 bcrypt로 해시해서 저장한다(src/lib/auth.ts와 동일한 방식).

import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const MIN_LENGTH = 8; // createFirstAdmin/resetPassword와 같은 기준

function usage(): never {
  console.log(
    [
      "",
      "사용법:",
      "  npm run reset-password -- --list                      계정 목록 보기",
      '  npm run reset-password -- <이메일> "<새 비밀번호>"     비밀번호 재설정',
      "",
      `비밀번호는 ${MIN_LENGTH}자 이상이어야 합니다. 공백이나 특수문자가 있으면 따옴표로 감싸세요.`,
      "",
    ].join("\n")
  );
  process.exit(1);
}

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") usage();

    if (args[0] === "--list") {
      const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
      if (users.length === 0) {
        console.log(
          "\n계정이 하나도 없습니다. 이때는 앱의 /login 화면이 '최초 관리자 계정 생성'으로" +
            " 바뀌므로 거기서 새로 만드시면 됩니다.\n"
        );
        return;
      }
      console.log(`\n계정 ${users.length}개:`);
      for (const u of users) {
        const role = u.role === "admin" ? "관리자" : "일반";
        console.log(
          `  ${u.email}  [${role}]  세금계산서 열람 ${u.canViewTaxInvoices ? "허용" : "미허용"}`
        );
      }
      console.log("");
      return;
    }

    const [emailRaw, password] = args;
    if (!emailRaw || !password) usage();

    // 앱의 login()과 같은 규칙으로 정규화한다 — 대문자로 입력해도 찾을 수 있게.
    const email = emailRaw.trim().toLowerCase();
    if (password.length < MIN_LENGTH) {
      console.error(`\n오류: 비밀번호는 ${MIN_LENGTH}자 이상이어야 합니다.\n`);
      process.exit(1);
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.error(`\n오류: "${email}" 계정을 찾을 수 없습니다. --list로 확인해보세요.\n`);
      process.exit(1);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(password, 10) },
    });

    console.log(
      [
        "",
        `완료: ${user.email} 의 비밀번호를 재설정했습니다.`,
        `  권한: ${user.role === "admin" ? "관리자" : "일반"}`,
        "  이제 이 비밀번호로 로그인하세요. 기존에 로그인돼 있던 세션은 그대로 유지됩니다",
        "  (세션 쿠키는 비밀번호와 별개입니다 — 필요하면 로그아웃 후 다시 로그인하세요).",
        "",
      ].join("\n")
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("\n오류:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
