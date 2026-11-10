import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { authenticate, requireUser, signToken, verifyToken } from '../middleware/auth.js';

export const authRouter = express.Router();

const credentials = z.object({ email: z.string().email().transform((e) => e.toLowerCase()), password: z.string().min(8).max(200), name: z.string().max(80).optional() });

function issue(user) {
  return {
    user: { id: user.id, email: user.email, name: user.name },
    token: signToken({ sub: user.id, type: 'access' }, '2h'),
    refreshToken: signToken({ sub: user.id, type: 'refresh' }, '7d'),
  };
}

authRouter.post('/register', async (req, res, next) => {
  try {
    const { email, password, name } = credentials.parse(req.body);
    if (db.findUserByEmail(email)) return res.status(409).json({ error: 'Email already registered' });
    const user = db.createUser({ email, name: name || email.split('@')[0], passwordHash: await bcrypt.hash(password, 10) });
    res.status(201).json(issue(user));
  } catch (e) { next(e); }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = credentials.pick({ email: true, password: true }).parse(req.body);
    const user = db.findUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'Invalid email or password' });
    res.json(issue(user));
  } catch (e) { next(e); }
});

authRouter.post('/refresh', (req, res) => {
  try {
    const decoded = verifyToken(String(req.body.refreshToken || ''));
    const user = decoded.type === 'refresh' && db.findUserById(decoded.sub);
    if (!user) throw new Error();
    res.json(issue(user));
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

authRouter.get('/me', authenticate, requireUser, (req, res) => {
  const user = db.findUserById(req.auth.userId);
  if (!user) return res.status(401).json({ error: 'User no longer exists' });
  res.json({ user: { id: user.id, email: user.email, name: user.name } });
});
