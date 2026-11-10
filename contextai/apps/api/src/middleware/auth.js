import jwt from 'jsonwebtoken';
import { db } from '../lib/db.js';
import { sha256 } from '../lib/crypto.js';

// Public keys ship in frontend code, so they may only run read-only intelligence calls.
const PUBLIC_SCOPES = ['ask', 'search'];
const SECRET_SCOPES = ['ask', 'search', 'read', 'manage'];

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET (min 32 chars) must be set');
  return secret;
}

export function signToken(payload, expiresIn = '2h') {
  return jwt.sign(payload, jwtSecret(), { expiresIn });
}

export function verifyToken(token) {
  return jwt.verify(token, jwtSecret());
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Resolves the caller from a developer JWT, a project secret key, or a project public key.
export function authenticate(req, res, next) {
  try {
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    const publicKey = req.headers['x-project-key'];
    const secretKey = req.headers['x-secret-key'] || (bearer?.startsWith('sk_') ? bearer : null);

    if (secretKey) {
      const key = db.findApiKeyBySecretHash(sha256(secretKey));
      if (!key) throw httpError(401, 'Invalid secret key');
      req.auth = { type: 'secretKey', projectId: key.projectId, keyId: key.id, scopes: SECRET_SCOPES };
    } else if (publicKey) {
      const key = db.findApiKeyByPublic(publicKey);
      if (!key) throw httpError(401, 'Invalid project key');
      req.auth = { type: 'publicKey', projectId: key.projectId, keyId: key.id, scopes: PUBLIC_SCOPES };
    } else if (bearer) {
      let decoded;
      try { decoded = verifyToken(bearer); } catch { throw httpError(401, 'Invalid or expired token'); }
      if (decoded.type !== 'access') throw httpError(401, 'Access token required');
      req.auth = { type: 'user', userId: decoded.sub, scopes: SECRET_SCOPES };
    } else {
      throw httpError(401, 'Authentication required');
    }
    next();
  } catch (e) { next(e); }
}

export function requireUser(req, res, next) {
  if (req.auth?.type !== 'user') return next(httpError(403, 'Developer account token required'));
  next();
}

export function projectIdsForCaller(auth) {
  if (auth.type === 'user') return db.listProjects(auth.userId).map((p) => p.id);
  return [auth.projectId];
}

// The project id in the URL is never trusted on its own: it must belong to the caller.
export function requireProject(scope) {
  return (req, res, next) => {
    const project = db.getProject(req.params.id);
    if (!project) return next(httpError(404, 'Project not found'));
    const { auth } = req;
    const allowed = auth.type === 'user' ? project.ownerId === auth.userId : project.id === auth.projectId;
    if (!allowed) return next(httpError(403, 'Not authorized for this project'));
    if (scope && !auth.scopes.includes(scope)) return next(httpError(403, `Missing scope: ${scope}`));
    req.project = project;
    req.actor = auth.type === 'user' ? auth.userId : auth.keyId;
    next();
  };
}
