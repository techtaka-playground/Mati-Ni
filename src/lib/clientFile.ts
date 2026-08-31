// 브라우저에서 선택한 File을 서버 액션으로 넘길 base64 문자열로 변환한다.
// FileReader는 브라우저 API라 클라이언트 컴포넌트에서만 호출해야 한다.
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
