import { isIP } from "node:net";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export class ResponseTooLargeError extends Error {
  constructor() {
    super("Subscription response exceeds the configured byte limit");
    this.name = "ResponseTooLargeError";
  }
}

export type DirectHttpResponse = {
  status: number;
  headers: Record<string, string>;
  content: string;
};

export type DirectBinaryHttpResponse = {
  status: number;
  headers: Record<string, string>;
  content: Uint8Array;
};

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

async function readLimitedBytes(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const encoding = String(response.headers["content-encoding"] || "").trim().toLowerCase();
  const decoded = encoding === "gzip" || encoding === "x-gzip"
    ? response.pipe(createGunzip())
    : encoding === "deflate"
      ? response.pipe(createInflate())
      : encoding === "br"
        ? response.pipe(createBrotliDecompress())
        : response;

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const raw of decoded) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      total += chunk.byteLength;
      if (total > maxBytes) throw new ResponseTooLargeError();
      chunks.push(chunk);
    }
  } catch (error) {
    response.destroy();
    if (decoded !== response) decoded.destroy();
    throw error;
  }
  return Buffer.concat(chunks, total);
}

async function readLimitedBody(response: IncomingMessage, maxBytes: number): Promise<string> {
  return (await readLimitedBytes(response, maxBytes)).toString("utf8");
}

function openPinnedRequest(params: {
  parsed: URL;
  address: string;
  method: "GET" | "HEAD";
  userAgent: string;
  signal: AbortSignal;
  requestHeaders?: Record<string, string>;
}): Promise<IncomingMessage> {
  const requestImpl = params.parsed.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = requestImpl({
      protocol: params.parsed.protocol,
      hostname: params.address,
      family: isIP(params.address) || undefined,
      port: params.parsed.port || undefined,
      path: `${params.parsed.pathname}${params.parsed.search}`,
      method: params.method,
      headers: {
        "User-Agent": params.userAgent,
        Accept: "text/plain, application/yaml, application/x-yaml, */*;q=0.8",
        ...params.requestHeaders,
        Host: params.parsed.host,
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
      },
      signal: params.signal,
      ...(params.parsed.protocol === "https:" && !isIP(params.parsed.hostname)
        ? { servername: params.parsed.hostname }
        : {}),
    }, resolve);
    request.once("error", reject);
    request.end();
  });
}

export async function requestPinnedText(params: {
  url: string;
  addresses: readonly string[];
  method: "GET" | "HEAD";
  userAgent: string;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<DirectHttpResponse> {
  const parsed = new URL(params.url);
  let lastError: unknown = new Error("No validated address is available");
  let response: IncomingMessage | null = null;
  for (const address of params.addresses) {
    try {
      response = await openPinnedRequest({ ...params, parsed, address });
      break;
    } catch (error) {
      lastError = error;
      if (params.signal.aborted) throw error;
    }
  }
  if (!response) throw lastError;

  const headers = normalizeHeaders(response.headers);
  if ((response.statusCode || 0) >= 300 && (response.statusCode || 0) < 400) {
    response.destroy();
    return { status: response.statusCode || 0, headers, content: "" };
  }
  const contentLength = Number(headers["content-length"] || "0");
  if (Number.isFinite(contentLength) && contentLength > params.maxBytes) {
    response.destroy();
    throw new ResponseTooLargeError();
  }
  const content = params.method === "HEAD" ? "" : await readLimitedBody(response, params.maxBytes);
  if (params.method === "HEAD") response.resume();
  return { status: response.statusCode || 0, headers, content };
}

export async function requestPinnedBytes(params: {
  url: string;
  addresses: readonly string[];
  userAgent: string;
  maxBytes: number;
  signal: AbortSignal;
  requestHeaders?: Record<string, string>;
}): Promise<DirectBinaryHttpResponse> {
  const parsed = new URL(params.url);
  let lastError: unknown = new Error("No validated address is available");
  let response: IncomingMessage | null = null;
  for (const address of params.addresses) {
    try {
      response = await openPinnedRequest({ ...params, parsed, address, method: "GET" });
      break;
    } catch (error) {
      lastError = error;
      if (params.signal.aborted) throw error;
    }
  }
  if (!response) throw lastError;

  const headers = normalizeHeaders(response.headers);
  const status = response.statusCode || 0;
  if (status >= 300 && status < 400) {
    response.destroy();
    return { status, headers, content: new Uint8Array() };
  }
  const contentLength = Number(headers["content-length"] || "0");
  if (Number.isFinite(contentLength) && contentLength > params.maxBytes) {
    response.destroy();
    throw new ResponseTooLargeError();
  }
  return { status, headers, content: await readLimitedBytes(response, params.maxBytes) };
}
