import { auth } from 'express-oauth2-jwt-bearer';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import User from '../models/User';
import { FolderService } from '../services/folderService';
import axios from 'axios';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken'; // or 'jose' for better security in prod

dotenv.config();

export const validateAuth0Token = auth({
  issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}`,   // e.g. dev-xyz.us.auth0.com
  audience: process.env.AUTH0_AUDIENCE,                   // your API Identifier
  tokenSigningAlg: 'RS256',                               // default, but explicit is nice
  // Optional hardening:
  clockTolerance: 5,                                      // small leeway for clock skew (seconds)
}) as RequestHandler;

export const attachUser: RequestHandler = async (req, res, next) => {
  try {
    const sub = req.auth?.payload?.sub;
    if (!sub) { res.status(401).json({ message: 'Unauthorized - no sub' }); return; }

    let user = await User.findOne({ auth0Id: sub });
    if (!user) {
      // Optional: fetch userinfo
      const accessToken = req.headers.authorization?.slice(7) || '';
      let userInfo: any = {};
      try {
        const r = await axios.get(`https://${process.env.AUTH0_DOMAIN}/userinfo`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        userInfo = r.data || {};
      } catch {}

      user = await User.create({
        auth0Id: sub,
        email: userInfo.email,
        name: userInfo.name || 'New User',
        avatar: userInfo.picture,
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
  } catch (e) {
    console.error('attachUser error', e);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

export function verifyAuth0Jwt(token: string) {
  // In production, fetch JWKS keys & verify signature!
  // This example is only for dev/local and will not verify signatures.
  try {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded) throw new Error("Invalid token");
    // Optionally check `aud`, `iss`, etc.
    return decoded.payload;
  } catch (err) {
    return null;
  }
}

// Add type definition for the user property
declare global {
  namespace Express {
    interface Request {
      user?: any;
      AuthResult?: {
        payload: {
          sub: string;
          [key: string]: any;
        };
      };
    }
  }
} 