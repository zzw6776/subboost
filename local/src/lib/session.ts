import { cookies } from "next/headers";
import { jwtVerify, SignJWT } from "jose";
import { requireEnv } from "./env";
import { getEffectivePublicAppUrl } from "./public-app-url";

export const SESSION_COOKIE = "subboost_local_session";

export type SessionPayload = {
  adminId: string;
  username: string;
};

function key(): Uint8Array {
  return new TextEncoder().encode(requireEnv("JWT_SECRET"));
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return await new SignJWT({ username: payload.username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.adminId)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(key());
}

export async function readSession(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    const adminId = typeof payload.sub === "string" ? payload.sub : "";
    const username = typeof payload.username === "string" ? payload.username : "";
    return adminId && username ? { adminId, username } : null;
  } catch {
    return null;
  }
}

export async function sessionCookieOptions(ownerId?: string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: (await getEffectivePublicAppUrl(ownerId)).startsWith("https://"),
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  };
}

export async function clearSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: (await getEffectivePublicAppUrl()).startsWith("https://"),
    path: "/",
    maxAge: 0,
  };
}
