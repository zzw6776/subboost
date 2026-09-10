import { withCurrentAdmin } from "@local/lib/api-auth";
import { apiError, json } from "@local/lib/http";
import { refreshSubscriptionResourceCache } from "@local/lib/resource-cache";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: RouteContext) {
  return withCurrentAdmin(async (admin) => {
    const { id } = await params;
    try {
      const result = await refreshSubscriptionResourceCache(admin.id, id);
      if (!result) return apiError("Subscription not found.", "NOT_FOUND", 404);
      return json({ success: true, entryCount: result.entries.length });
    } catch (error) {
      return apiError(error instanceof Error ? error.message : "资源缓存更新失败", "BAD_REQUEST", 400);
    }
  });
}
