import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAppUrl: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("./env", () => ({ getAppUrl: mocks.getAppUrl }));
vi.mock("./prisma", () => ({
  prisma: {
    localAdmin: {
      findFirst: mocks.findFirst,
      findUnique: mocks.findUnique,
    },
  },
}));

import { getEffectivePublicAppUrl, normalizePublicAppUrl } from "./public-app-url";

describe("public app URL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAppUrl.mockReturnValue("http://127.0.0.1:3000");
    mocks.findFirst.mockResolvedValue(null);
    mocks.findUnique.mockResolvedValue(null);
  });

  it("normalizes a configured reverse-proxy URL", () => {
    expect(normalizePublicAppUrl(" https://sub.example.com/ ")).toBe("https://sub.example.com");
    expect(normalizePublicAppUrl("")).toBeNull();
    expect(() => normalizePublicAppUrl("ftp://sub.example.com")).toThrow("只支持 HTTP 或 HTTPS");
    expect(() => normalizePublicAppUrl("https://sub.example.com/?token=x")).toThrow("不能包含账号、密码、查询参数或片段");
  });

  it("prefers the saved URL and falls back to APP_URL when unavailable", async () => {
    mocks.findUnique.mockResolvedValueOnce({ publicAppUrl: "https://sub.example.com/" });
    await expect(getEffectivePublicAppUrl("owner-1")).resolves.toBe("https://sub.example.com");
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { id: "owner-1" }, select: { publicAppUrl: true } });

    mocks.findFirst.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(getEffectivePublicAppUrl()).resolves.toBe("http://127.0.0.1:3000");
  });
});
