import crypto from 'node:crypto';
import { HttpError } from './http.js';

/** Bearer token in the Authorization header, or ?token= for <img>, <video> and EventSource. */
export function checkAuth(req, url, token) {
  if (!token) throw new HttpError(500, 'Server has no token configured (set "token" in server/config.json)');
  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : url.searchParams.get('token') || '';
  if (!supplied || supplied.length !== token.length) throw new HttpError(401, 'Unauthorized');
  if (!crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw new HttpError(401, 'Unauthorized');
}

export const randomToken = () => crypto.randomBytes(24).toString('base64url');
