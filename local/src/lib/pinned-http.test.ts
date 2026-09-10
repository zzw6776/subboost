import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestPinnedBytes, requestPinnedText, ResponseTooLargeError } from "./pinned-http";

describe("pinned local HTTP transport", () => {
  let server: Server;
  let port = 0;
  let observedHost = "";
  let observedAuthorization = "";

  beforeAll(async () => {
    server = createServer((request, response) => {
      observedHost = request.headers.host || "";
      observedAuthorization = request.headers.authorization || "";
      const body = request.url === "/large"
        ? "x".repeat(2048)
        : request.url === "/binary"
          ? Buffer.from([0, 255, 1])
          : "ss://node";
      response.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Encoding": "gzip",
      });
      response.end(gzipSync(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("connects only to the validated address while preserving the original Host header", async () => {
    const response = await requestPinnedText({
      url: `http://example.test:${port}/ok`,
      addresses: ["127.0.0.1"],
      method: "GET",
      userAgent: "SubBoost Test",
      maxBytes: 1024,
      signal: new AbortController().signal,
    });

    expect(response).toMatchObject({ status: 200, content: "ss://node" });
    expect(observedHost).toBe(`example.test:${port}`);
  });

  it("enforces the limit after response decompression", async () => {
    await expect(requestPinnedText({
      url: `http://example.test:${port}/large`,
      addresses: ["127.0.0.1"],
      method: "GET",
      userAgent: "SubBoost Test",
      maxBytes: 128,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("returns binary bodies without UTF-8 conversion and forwards provider headers", async () => {
    const response = await requestPinnedBytes({
      url: `http://example.test:${port}/binary`,
      addresses: ["127.0.0.1"],
      userAgent: "SubBoost Test",
      maxBytes: 1024,
      signal: new AbortController().signal,
      requestHeaders: { Authorization: "Bearer cache-token", Host: "attacker.invalid" },
    });

    expect(Array.from(response.content)).toEqual([0, 255, 1]);
    expect(observedAuthorization).toBe("Bearer cache-token");
    expect(observedHost).toBe(`example.test:${port}`);
  });
});
