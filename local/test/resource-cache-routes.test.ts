import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  body: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  normalize: vi.fn(),
  refresh: vi.fn(),
  read: vi.fn(),
}));

vi.mock("@local/lib/api-auth", () => ({
  withCurrentAdmin: (callback: (admin: { id: string }) => unknown) => callback({ id: "admin-1" }),
}));
vi.mock("@local/lib/http", () => ({
  LOCAL_JSON_BODY_LIMITS: { small: 1024 },
  readJsonBody: mocks.body,
  jsonBodyError: (value: unknown) => ({ kind: "body-error", value }),
  apiError: (message: string, code: string, status: number) => ({ message, code, status }),
  json: (value: unknown) => ({ kind: "json", value }),
}));
vi.mock("@local/lib/public-app-url", () => ({ normalizePublicAppUrl: mocks.normalize }));
vi.mock("@local/lib/prisma", () => ({
  prisma: { localAdmin: { findUnique: mocks.findUnique, update: mocks.update } },
}));
vi.mock("@local/lib/env", () => ({ getAppUrl: () => "http://internal:3000" }));
vi.mock("@local/lib/resource-cache", () => ({
  refreshSubscriptionResourceCache: mocks.refresh,
  readCachedResource: mocks.read,
}));

import { GET as getAppUrl, PATCH as patchAppUrl } from "../app/api/settings/app-url/route";
import { POST as refreshCache } from "../app/api/subscriptions/[id]/resource-cache/refresh/route";
import { GET as getResource } from "../app/api/subscriptions/[id]/resources/[key]/route";

describe("resource cache and public URL routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.normalize.mockImplementation((value) => typeof value === "string" ? value.replace(/\/$/, "") : null);
  });

  it("loads public URL settings and handles a missing admin", async () => {
    mocks.findUnique
      .mockResolvedValueOnce({ publicAppUrl: "https://sub.example.com" })
      .mockResolvedValueOnce({ publicAppUrl: null })
      .mockResolvedValueOnce(null);
    await expect(getAppUrl()).resolves.toEqual({
      kind: "json",
      value: { publicAppUrl: "https://sub.example.com", fallbackAppUrl: "http://internal:3000" },
    });
    await expect(getAppUrl()).resolves.toMatchObject({ value: { publicAppUrl: "" } });
    await expect(getAppUrl()).resolves.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("validates and saves public URL settings", async () => {
    mocks.body.mockResolvedValueOnce({ ok: false, error: "bad json" });
    await expect(patchAppUrl(new Request("http://test", { method: "PATCH" }))).resolves.toMatchObject({ kind: "body-error" });

    mocks.body.mockResolvedValueOnce({ ok: true, value: { publicAppUrl: "https://sub.example.com/" } });
    mocks.update.mockResolvedValueOnce({ publicAppUrl: "https://sub.example.com" });
    await expect(patchAppUrl(new Request("http://test", { method: "PATCH" }))).resolves.toMatchObject({
      value: { publicAppUrl: "https://sub.example.com", fallbackAppUrl: "http://internal:3000" },
    });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: { publicAppUrl: "https://sub.example.com" } }));

    mocks.body.mockResolvedValueOnce({ ok: true, value: { publicAppUrl: "" } });
    mocks.update.mockResolvedValueOnce({ publicAppUrl: null });
    await patchAppUrl(new Request("http://test", { method: "PATCH" }));
    expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { publicAppUrl: null } }));

    mocks.body.mockResolvedValueOnce({ ok: true, value: { publicAppUrl: null } });
    mocks.update.mockResolvedValueOnce({ publicAppUrl: null });
    await patchAppUrl(new Request("http://test", { method: "PATCH" }));
    expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { publicAppUrl: null } }));
  });

  it.each([
    [{ invalid: true }, "公开访问地址不能为空"],
    [{ publicAppUrl: 123 }, "公开访问地址不能为空"],
  ])("returns validation errors for invalid public URL bodies", async (value, message) => {
    mocks.body.mockResolvedValue({ ok: true, value });
    await expect(patchAppUrl(new Request("http://test", { method: "PATCH" }))).resolves.toMatchObject({
      message,
      code: "VALIDATION_ERROR",
      status: 400,
    });
  });

  it("uses the generic validation message for non-Error normalization failures", async () => {
    mocks.body.mockResolvedValue({ ok: true, value: { publicAppUrl: "https://bad.example.com" } });
    mocks.normalize.mockImplementation(() => { throw "invalid"; });
    await expect(patchAppUrl(new Request("http://test", { method: "PATCH" }))).resolves.toMatchObject({
      message: "公开访问地址无效",
      status: 400,
    });
  });

  it("refreshes a cache and maps not-found and thrown failures", async () => {
    const context = { params: Promise.resolve({ id: "sub-1" }) };
    mocks.refresh
      .mockResolvedValueOnce({ entries: [{}, {}] })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockRejectedValueOnce("refresh failed");
    await expect(refreshCache(new Request("http://test"), context)).resolves.toMatchObject({ value: { success: true, entryCount: 2 } });
    await expect(refreshCache(new Request("http://test"), context)).resolves.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(refreshCache(new Request("http://test"), context)).resolves.toMatchObject({ message: "refresh failed", status: 400 });
    await expect(refreshCache(new Request("http://test"), context)).resolves.toMatchObject({ message: "资源缓存更新失败", status: 400 });
  });

  it("serves cache bytes with headers and returns 404 when absent", async () => {
    const context = { params: Promise.resolve({ id: "token-1", key: "key-1" }) };
    mocks.read.mockResolvedValueOnce(null).mockResolvedValueOnce({
      bytes: new Uint8Array([1, 2]),
      contentType: "application/octet-stream",
      lastUpdatedAt: "2026-01-01T00:00:00.000Z",
    }).mockResolvedValueOnce({ bytes: new Uint8Array([3]), contentType: "text/plain", lastUpdatedAt: null });
    expect((await getResource(new Request("http://test"), context)).status).toBe(404);
    const response = await getResource(new Request("http://test"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("last-modified")).toBe(new Date("2026-01-01T00:00:00.000Z").toUTCString());
    expect(response.headers.get("cache-control")).toContain("stale-if-error");
    expect((await getResource(new Request("http://test"), context)).headers.has("last-modified")).toBe(false);
  });
});
