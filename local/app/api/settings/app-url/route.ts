import { withCurrentAdmin } from "@local/lib/api-auth";
import { apiError, json, jsonBodyError, LOCAL_JSON_BODY_LIMITS, readJsonBody } from "@local/lib/http";
import { normalizePublicAppUrl } from "@local/lib/public-app-url";
import { prisma } from "@local/lib/prisma";
import { getAppUrl } from "@local/lib/env";

export async function GET() {
  return withCurrentAdmin(async (admin) => {
    const settings = await prisma.localAdmin.findUnique({
      where: { id: admin.id },
      select: { publicAppUrl: true },
    });
    if (!settings) return apiError("Local admin not found.", "NOT_FOUND", 404);
    return json({ publicAppUrl: settings.publicAppUrl || "", fallbackAppUrl: getAppUrl() });
  });
}

export async function PATCH(request: Request) {
  return withCurrentAdmin(async (admin) => {
    const parsedBody = await readJsonBody(request, LOCAL_JSON_BODY_LIMITS.small);
    if (!parsedBody.ok) return jsonBodyError(parsedBody);
    const value = parsedBody.value && typeof parsedBody.value === "object" && !Array.isArray(parsedBody.value)
      ? (parsedBody.value as Record<string, unknown>).publicAppUrl
      : undefined;

    let publicAppUrl: string | null;
    try {
      publicAppUrl = value === "" || value === null ? null : normalizePublicAppUrl(value);
      if (value !== "" && value !== null && !publicAppUrl) throw new Error("公开访问地址不能为空");
    } catch (error) {
      return apiError(error instanceof Error ? error.message : "公开访问地址无效", "VALIDATION_ERROR", 400);
    }

    const settings = await prisma.localAdmin.update({
      where: { id: admin.id },
      data: { publicAppUrl },
      select: { publicAppUrl: true },
    });
    return json({ publicAppUrl: settings.publicAppUrl || "", fallbackAppUrl: getAppUrl() });
  });
}
