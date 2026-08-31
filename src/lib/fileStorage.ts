import { mkdir, writeFile, readFile, unlink, access } from "node:fs/promises";
import path from "node:path";

// 첨부파일(인보이스 PDF 등) 저장소 — 로컬 개발은 디스크(uploads/)에, 배포 환경은 Object
// Storage(S3 호환)에 쓴다(2026-08-31, 아르고런처 배포 컨테이너는 파일시스템이 읽기 전용이고
// 재배포마다 초기화돼 로컬 디스크에 두면 첨부파일이 사라진다). 배포 시 주입되는
// `STORAGE_BUCKET`이 있으면 S3를, 없으면(로컬 개발) 디스크를 쓴다 — 코드 위에서 환경을
// 나누지 않고 이 모듈 하나가 판단해서 나머지 코드는 항상 같은 함수만 부르면 된다.

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const bucket = process.env.STORAGE_BUCKET;

let s3ClientPromise: Promise<import("@aws-sdk/client-s3").S3Client> | null = null;
function getS3Client() {
  if (!s3ClientPromise) {
    s3ClientPromise = import("@aws-sdk/client-s3").then(
      ({ S3Client }) => new S3Client({ region: process.env.STORAGE_REGION ?? "us-east-1" })
    );
  }
  return s3ClientPromise;
}

function keyFor(filename: string): string {
  const prefix = process.env.STORAGE_PREFIX;
  return prefix ? `${prefix.replace(/\/+$/, "")}/${filename}` : filename;
}

export async function storeFile(filename: string, data: Buffer): Promise<void> {
  if (bucket) {
    const [{ PutObjectCommand }, client] = await Promise.all([import("@aws-sdk/client-s3"), getS3Client()]);
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: keyFor(filename), Body: data, ContentType: "application/pdf" })
    );
    return;
  }
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(path.join(UPLOAD_DIR, filename), data);
}

export async function storedFileExists(filename: string): Promise<boolean> {
  if (bucket) {
    const [{ HeadObjectCommand }, client] = await Promise.all([import("@aws-sdk/client-s3"), getS3Client()]);
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: keyFor(filename) }));
      return true;
    } catch {
      return false;
    }
  }
  try {
    await access(path.join(UPLOAD_DIR, filename));
    return true;
  } catch {
    return false;
  }
}

export async function readStoredFile(filename: string): Promise<Buffer> {
  if (bucket) {
    const [{ GetObjectCommand }, client] = await Promise.all([import("@aws-sdk/client-s3"), getS3Client()]);
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(filename) }));
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }
  return readFile(path.join(UPLOAD_DIR, filename));
}

export async function deleteStoredFile(filename: string): Promise<void> {
  if (bucket) {
    const [{ DeleteObjectCommand }, client] = await Promise.all([import("@aws-sdk/client-s3"), getS3Client()]);
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyFor(filename) }));
    return;
  }
  await unlink(path.join(UPLOAD_DIR, filename));
}

// 파일명이 DB(TaxInvoiceAttachment.fileName)에서 왔더라도 경로 탈출 문자가 섞이지 않았는지
// 한 번 더 확인한다 — 저장은 항상 sanitizeSegment를 거친 이름으로만 하지만, 읽는 쪽은 그
// 가정이 깨져도 안전하도록 방어한다.
export function isSafeStoredFilename(filename: string): boolean {
  return filename.length > 0 && !filename.includes("/") && !filename.includes("\\") && !filename.includes("..");
}
