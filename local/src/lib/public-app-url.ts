import { getAppUrl } from "./env";
import { prisma } from "./prisma";

export function normalizePublicAppUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("公开访问地址必须是有效的 HTTP 或 HTTPS URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("公开访问地址只支持 HTTP 或 HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("公开访问地址不能包含账号、密码、查询参数或片段");
  }
  return trimmed;
}

export async function getEffectivePublicAppUrl(ownerId?: string): Promise<string> {
  try {
    const admin = ownerId
      ? await prisma.localAdmin.findUnique({ where: { id: ownerId }, select: { publicAppUrl: true } })
      : await prisma.localAdmin.findFirst({ orderBy: { createdAt: "asc" }, select: { publicAppUrl: true } });
    const configured = normalizePublicAppUrl(admin?.publicAppUrl);
    if (configured) return configured;
  } catch {
    // 登录、登出和数据库迁移期间仍应能回退到部署时的 APP_URL。
  }
  return getAppUrl();
}
