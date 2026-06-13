import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getDb, getUserByEmail, insertUser } from '../registry.js';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessayez dans 15 minutes.' },
});

export function makeAuthRouter() {
  const router = Router();

  router.post('/login', loginLimiter, async (req, res, next) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'email et password requis' });

      const db = getDb();
      const user = getUserByEmail(db, email);
      if (!user) return res.status(401).json({ error: 'Identifiants invalides' });

      const valid = await argon2.verify(user.password_hash, password);
      if (!valid) return res.status(401).json({ error: 'Identifiants invalides' });

      const token = jwt.sign(
        { sub: user.id, role: user.role },
        config.jwtSecret,
        { expiresIn: '24h' },
      );
      res.json({ token });
    } catch (err) {
      next(err);
    }
  });

  router.post('/register', async (req, res, next) => {
    try {
      if (!config.allowRegister) {
        return res.status(403).json({ error: 'Inscription désactivée. Utilisez npm run create-admin.' });
      }
      const { email, password, name } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'email et password requis' });
      if (password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (8 car. min)' });

      const db = getDb();
      if (getUserByEmail(db, email)) return res.status(409).json({ error: 'Email déjà utilisé' });

      const password_hash = await argon2.hash(password, { type: argon2.argon2id });
      const result = insertUser(db, { email, password_hash, name: name ?? null, role: 'client' });

      const token = jwt.sign(
        { sub: result.lastInsertRowid, role: 'client' },
        config.jwtSecret,
        { expiresIn: '24h' },
      );
      res.status(201).json({ token });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
