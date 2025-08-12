// server/src/middleware/auth.ts
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { jwtVerify, createRemoteJWKSet, JWTPayload } from 'jose';
import axios from 'axios';
import User from '../models/User';
import { FolderService } from '../services/folderService';

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN!;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE!;
const ISSUER = `https://${AUTH0_DOMAIN}/`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}.well-known/jwks.json`));

declare global {
  namespace Express {
    interface Request {
      user?: any;
      authInfo?: {
        payload: JWTPayload & { sub: string };
        token: string;
      };
    }
  }
}

export const validateAuth0Token: RequestHandler = async (req, res, next) => {
  try {
    const authz = req.headers.authorization;
    if (!authz?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing bearer token' });
      return;
    }
    const token = authz.slice(7);

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: AUTH0_AUDIENCE,
    });

    if (!payload?.sub) {
      res.status(401).json({ error: 'Invalid token (sub missing)' });
      return;
    }

    req.authInfo = { payload: payload as JWTPayload & { sub: string }, token };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

export const attachUser: RequestHandler = async (req, res, next) => {
  try {
    const sub = req.authInfo?.payload?.sub;
    if (!sub) {
      res.status(401).json({ message: 'Unauthorized - no sub' });
      return;
    }

    let user = await User.findOne({ auth0Id: sub });

    if (!user) {
      let userInfo: any = {};
      try {
        const resp = await axios.get(`https://${AUTH0_DOMAIN}/userinfo`, {
          headers: { Authorization: `Bearer ${req.authInfo!.token}` },
        });
        userInfo = resp.data || {};
      } catch { /* ok if userinfo fails */ }

      user = await User.create({
        auth0Id: sub,
        email: userInfo.email ?? req.authInfo!.payload.email,
        name: userInfo.name ?? req.authInfo!.payload.name ?? 'New User',
        avatar: userInfo.picture ?? undefined,
        role: 'user',
        status: 'active',
        lastLogin: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await FolderService.createDefaultFolders(user);
    } else {
      user.lastLogin = new Date();
      await user.save();
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('attachUser error:', err);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

/** Verify a raw Auth0 token string (e.g., from query param). Use sparingly. */
export async function verifyAuth0JwtFromString(token: string) {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: AUTH0_AUDIENCE,
    });
    if (!payload?.sub) return null;
    return { token, payload: payload as JWTPayload & { sub: string } };
  } catch {
    return null;
  }
}
