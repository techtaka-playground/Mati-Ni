// 은행 입출금내역의 "송금인/적요"를 거래처 마스터와 맞춰보는 규칙.
//
// 은행 거래내역에는 상대 계좌번호도 사업자번호도 없고 **입금자명만** 온다(README "입출금내역
// 조회" 참고). 그 이름은 거래처 마스터와 표기가 자주 다르다:
//   (주)앱솔브랩      vs  앱솔브랩 / 주식회사 앱솔브랩
//   주)신세계인터내셔날     ← 은행 쪽에서 괄호가 깨져 온다
//   주식회사이너시아        ← 띄어쓰기가 없다
//   그란데클립 에프앤비  vs  그란데클립코리아   ← 서로 다른 회사다(부분일치로 붙이면 오답)
// 그래서 정규화 후 **완전일치를 먼저** 보고, 부분일치는 길이 조건을 걸어 조심스럽게만 쓴다.

// 법인 형태 표기와 구분기호를 걷어내고 비교용 문자열을 만든다.
export function normalizeRemarkForMatch(raw: string): string {
  return (
    (raw ?? "")
      .toLowerCase()
      // 1) 괄호 안의 법인 표기를 **괄호와 함께** 먼저 지운다: "(주)", "주)", "(주", "（주）".
      //    은행 쪽에서 여는 괄호가 빠져 오는 경우가 실제로 있다("주)신세계인터내셔날").
      //    괄호를 먼저 다 지워버리면 "범주해운(주)" → "범주해운주"처럼 잔재가 남는다.
      .replace(/[(（]?\s*[주유]\s*[)）]/g, "")
      .replace(/㈜/g, "")
      // 2) 풀어 쓴 법인 형태.
      .replace(/주식회사|유한회사|합자회사|사단법인|재단법인/g, "")
      // 3) 남은 괄호·구분기호·공백.
      .replace(/[()（）\[\]{}]/g, "")
      .replace(/[\s.,·・\-_/]/g, "")
      .trim()
  );
}

export type PartyLite = { id: string; code: string | null; name: string };
export type MatchSource = "alias" | "exact" | "partial";
export type MatchedParty = { id: string; code: string | null; name: string; source: MatchSource };

// 부분일치를 허용하는 최소 길이. 짧은 문자열끼리는 우연히 포함관계가 생겨 오답이 많다
// (예: "한진" 이 "한진해운"·"대한진흥" 양쪽에 걸린다).
const MIN_PARTIAL_LENGTH = 4;

// aliases: 정규화 문자열 → 거래처. 사람이 한 번 지정한 것이므로 **항상 이긴다.**
export function matchPartyForRemark(
  remark: string,
  parties: PartyLite[],
  aliases: Map<string, PartyLite>
): MatchedParty | null {
  const key = normalizeRemarkForMatch(remark);
  if (!key) return null;

  const alias = aliases.get(key);
  if (alias) return { ...alias, source: "alias" };

  const normalized = parties.map((p) => ({ p, n: normalizeRemarkForMatch(p.name) })).filter((x) => x.n);

  const exact = normalized.filter((x) => x.n === key);
  // 정규화 후 같은 이름이 둘 이상이면 어느 쪽인지 알 수 없으므로 매칭하지 않는다 — 틀린 거래처를
  // 자동으로 붙이는 것보다 비워두고 사람이 고르게 하는 편이 안전하다.
  if (exact.length === 1) return { ...exact[0].p, source: "exact" };
  if (exact.length > 1) return null;

  if (key.length < MIN_PARTIAL_LENGTH) return null;
  const partial = normalized.filter(
    (x) => x.n.length >= MIN_PARTIAL_LENGTH && (x.n.includes(key) || key.includes(x.n))
  );
  if (partial.length === 1) return { ...partial[0].p, source: "partial" };
  return null;
}
