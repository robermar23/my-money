import "server-only";

import { type SessionOptions, getIronSession } from "iron-session";
import { cookies } from "next/headers";

/**
 * Shape of the iron-session payload.
 *
 * Kept minimal: the session is just "is this request authenticated as our one user?"
 * We store the user id so the request can confirm the row still exists; no need
 * for roles, tenant ids, or scopes — there's only one user.
 */
export interface SessionData {
  userId?: string;
}

/**
 * Reads and validates the session secret from the environment.
 *
 * Exposed as a getter on {@link sessionOptions} so the check is deferred to the
 * first request that actually opens a session — NOT to module load. Validating
 * eagerly broke `next build`: its "Collecting page data" step imports every
 * route module (including ones reachable from this one) while `SESSION_SECRET`
 * is legitimately unset inside the build container, throwing before the app runs.
 *
 * @returns The validated secret (>= 32 chars).
 * @throws If `SESSION_SECRET` is unset or shorter than 32 chars.
 */
function requireSessionSecret(): string {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error(
      "SESSION_SECRET is not set or is shorter than 32 chars. Generate one with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  return sessionSecret;
}

// One year. You're the only user. You set up the box. Forcing periodic re-auth
// on yourself is friction with no security gain — if someone has your laptop
// + your unlocked browser, the password is not what's protecting your data.
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export const sessionOptions: SessionOptions = {
  cookieName: "money_session",
  // Lazy: iron-session reads `password` when a session is opened (request time),
  // so the env check runs then rather than at import. `.cookieName` (used by the
  // logout route) stays accessible without requiring the secret.
  get password(): string {
    return requireSessionSecret();
  },
  cookieOptions: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  },
};

/**
 * Fetch the iron-session for the current request.
 *
 * Use this in server components, server actions, and route handlers to read or
 * mutate the session payload. The session is encrypted in a single cookie; no
 * server-side session store is needed (matches our single-user, self-hosted design).
 */
export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}
