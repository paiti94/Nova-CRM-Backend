import { auth } from 'express-oauth2-jwt-bearer';
import { Request, Response, NextFunction } from 'express';
import User from '../models/User';
import { FolderService } from '../services/folderService';
import axios from 'axios';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken'; // or 'jose' for better security in prod

dotenv.config();

export const validateAuth0Token = auth({
  audience: process.env.AUTH0_AUDIENCE,
  issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}`,
});


export const attachUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth0Id = req.auth?.payload?.sub;
    if (!auth0Id) {
      return res.status(401).json({ message: 'Unauthorized - No auth0Id' });
    }

    // Get the access token from the Authorization header
    const accessToken = req.headers.authorization?.split(' ')[1];
    if (!accessToken) {
      return res.status(401).json({ message: 'No access token provided' });
    }

    let user = await User.findOne({ auth0Id });

    if (!user) {
      // Fetch user info from Auth0
      const userInfo = await getUserInfoFromAuth0(accessToken);
      console.log('Auth0 user info:', userInfo);

      // Create new user
      user = await User.create({
        auth0Id,
        email: userInfo.email,
        name: userInfo.name || userInfo.nickname,
        avatar: userInfo.picture,
        role: 'user', // Default role
        status: 'active',
        lastLogin: new Date(), // Set lastLogin to now
        createdAt: new Date(), // Set createdAt to now
        updatedAt: new Date() 
      });

      // Create default folders for the new user
      await FolderService.createDefaultFolders(user);
      console.log('Created default folders for new user:', user._id);
    }else {
      // Update last login time when user logs in
      user.lastLogin = new Date();
      await user.save();
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Error in attachUser middleware:', error);
    res.status(500).json({ message: 'Internal Server Error' });
    // next(error);
  }
};

async function getUserInfoFromAuth0(accessToken: string) {
  try {
    const response = await axios.get(
      `https://${process.env.AUTH0_DOMAIN}/userinfo`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error fetching user info from Auth0:', error);
    throw error;
  }
}



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