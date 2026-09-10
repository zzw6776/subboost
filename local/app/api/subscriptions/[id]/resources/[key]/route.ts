import { readCachedResource } from "@local/lib/resource-cache";

type RouteContext = { params: Promise<{ id: string; key: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { id: token, key } = await params;
  const cached = await readCachedResource(token, key);
  if (!cached) return new Response("Cached resource not found.", { status: 404 });
  return new Response(cached.bytes, {
    headers: {
      "content-type": cached.contentType,
      "cache-control": "public, max-age=3600, stale-if-error=86400",
      ...(cached.lastUpdatedAt ? { "last-modified": new Date(cached.lastUpdatedAt).toUTCString() } : {}),
    },
  });
}
