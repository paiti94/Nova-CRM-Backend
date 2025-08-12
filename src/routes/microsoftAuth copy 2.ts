// // routes/microsoftAuth.ts
// import express from 'express';
// import axios from 'axios';
// import crypto from 'crypto';
// import qs from 'qs';
// import User from '../models/User';
// import { verifyAuth0JwtFromString, validateAuth0Token, attachUser } from '../middleware/auth';
// import { AuthorizationCode } from 'simple-oauth2';

// const router = express.Router();

// // Short-lived state store to prevent tampering
// const stateStore = new Map<string, { userId: string; expiresAt: number }>();
// const putState = (userId: string) => {
//   const state = crypto.randomUUID();
//   stateStore.set(state, { userId, expiresAt: Date.now() + 5 * 60_000 }); // 5 min
//   return state;
// };
// const popState = (state: string | undefined) => {
//   if (!state) return null;
//   const item = stateStore.get(state);
//   if (!item) return null;
//   stateStore.delete(state);
//   if (Date.now() > item.expiresAt) return null;
//   return item.userId;
// };

// const CLIENT_ID = process.env.MS_CLIENT_ID!;
// const CLIENT_SECRET = process.env.MS_CLIENT_SECRET!;
// const SERVER_REDIRECT_URI = process.env.MS_REDIRECT_URI!; // e.g. http://localhost:5001/api/microsoft/callback
// const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
// const SCOPES = 'openid profile email offline_access Mail.Read';
// const oauth2 = new AuthorizationCode({
//     client: {
//       id: process.env.MS_CLIENT_ID || "",
//       secret: process.env.MS_CLIENT_SECRET || "",
//     },
//     auth: {
//       tokenHost: "https://login.microsoftonline.com",
//       authorizePath: "/common/oauth2/v2.0/authorize",
//       tokenPath: "/common/oauth2/v2.0/token",
//     },
//   });
  
// router.get("/login", async (req, res) => {
//     try {
//       const raw = typeof req.query.auth_token === 'string' ? req.query.auth_token : '';
//       const auth = raw ? await verifyAuth0JwtFromString(raw) : null;
//       if (!auth) {
//          res.status(401).json({ error: 'Invalid Auth0 token' });
//          return;
//       }

//       const user = await User.findOne({ auth0Id: auth.payload.sub });
//       if (!user) {
//         res.status(401).json({ error: 'User not found' });
//         return;
//       }  
//       // Build Microsoft authorize URL with your server REDIRECT URI
//       const authorizationUri = oauth2.authorizeURL({
//         redirect_uri: process.env.MS_REDIRECT_URI,   // e.g. http://localhost:5001/api/microsoft/callback
//         scope: SCOPES,
//         state: user?._id?.toString(),
//       });
  
//       res.redirect(authorizationUri);
//     } catch (err) {
//       console.error("MS /login error:", err);
//       res.status(500).json({ error: "Failed to start Microsoft auth" });
//     }
//   });
  
// router.get('/callback', async (req, res) => {
//     try {
//       const { code, state } = req.query;
  
//       if (!code || !state) {
//          res.status(400).json({ error: 'Missing code or state' });
//          return;
//       }
  
//       // IMPORTANT: must match Azure "Web" redirect URI exactly
//       const redirectUri = process.env.MS_REDIRECT_URI; // e.g. http://localhost:5001/api/microsoft/callback
//       if (!redirectUri) {
//          res.status(500).json({ error: 'MS_REDIRECT_URI not set' });
//          return;
//       }
  
//       // Do the code-for-token exchange on the server
//       const tokenUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
//       const form = new URLSearchParams({
//         client_id: process.env.MS_CLIENT_ID!,           // Azure App (client) ID
//         client_secret: process.env.MS_CLIENT_SECRET!,   // Azure client secret (VALUE, not ID)
//         grant_type: 'authorization_code',
//         code: String(code),
//         redirect_uri: redirectUri,
//         scope: 'openid profile email offline_access Mail.Read'
//       });
  
//       const tokenRes = await axios.post(tokenUrl, form, {
//         headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
//         validateStatus: () => true, // we’ll inspect non-200s
//       });
  
//       if (tokenRes.status !== 200) {
//         console.error('MS token exchange error:', tokenRes.status, tokenRes.data);
//          res.status(400).json({ error: 'Token exchange failed', detail: tokenRes.data });
//          return;
//       }
  
//       const tok = tokenRes.data as {
//         access_token: string;
//         refresh_token?: string;
//         expires_in: number;
//         token_type: string;
//         scope?: string;
//       };
  
//       // state is the Mongo userId we set in /login
//       const userId = String(state);
//       const user = await User.findById(userId);
//       if (!user) {
//          res.status(404).json({ error: 'User not found for state' });
//          return;
//       }
  
//       const expiresAt = new Date(Date.now() + (tok.expires_in - 60) * 1000);
//       user.msTokens = {
//         access_token: tok.access_token,
//         refresh_token: tok.refresh_token,
//         token_type: tok.token_type,
//         scope: tok.scope || 'openid profile email offline_access Mail.Read',
//         expires_in: tok.expires_in,
//         expires_at: expiresAt,
//       };
//       await user.save();
  
//       const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
//        res.redirect(`${clientUrl}/outlook?connected=1`);
//        return;
//     } catch (err: any) {
//       console.error('MS callback error:', err?.response?.data || err);
//        res.status(500).json({ error: 'OAuth callback failed' });
//        return;
//     }
//   });

// // 3) Protected: fetch latest email (and auto-refresh)
// async function getValidAccessToken(userId: string) {
//   // read tokens including hidden fields
//   const user = await User.findById(userId).select('+msTokens.access_token +msTokens.refresh_token').lean();
//   const tokens = user?.msTokens;
//   if (!tokens?.access_token) return null;

//   const isExpired = tokens.expires_at && new Date(tokens.expires_at).getTime() < Date.now();
//   if (!isExpired) return tokens.access_token;

//   if (!tokens.refresh_token) return null;

//   // refresh
//   const tokenUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
//   const form = qs.stringify({
//     client_id: CLIENT_ID,
//     client_secret: CLIENT_SECRET,
//     grant_type: 'refresh_token',
//     refresh_token: tokens.refresh_token,
//     scope: SCOPES,
//   });

//   const r = await axios.post(tokenUrl, form, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
//   const nt = r.data as { access_token: string; refresh_token?: string; expires_in: number; token_type: string; scope?: string };
//   const expiresAt = new Date(Date.now() + (nt.expires_in - 60) * 1000);

//   await User.findByIdAndUpdate(userId, {
//     msTokens: {
//       access_token: nt.access_token,
//       refresh_token: nt.refresh_token || tokens.refresh_token,
//       token_type: nt.token_type,
//       scope: nt.scope || SCOPES,
//       expires_at: expiresAt,
//       expires_in: nt.expires_in,
//     }
//   });

//   return nt.access_token;
// }

// router.get('/latest-email', validateAuth0Token as express.RequestHandler, attachUser as any, async (req, res) => {
//   try {
//     const userId = String(req.user!._id);
//     const accessToken = await getValidAccessToken(userId);
//     if (!accessToken) { res.status(400).json({ error: 'Microsoft account not connected' }); return; }

//     const graph = await axios.get(
//       'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?$top=1&$orderby=receivedDateTime desc',
//       { headers: { Authorization: `Bearer ${accessToken}` } }
//     );
//     const m = graph.data.value?.[0];
//     res.json(m ? {
//       subject: m.subject,
//       from: m.from?.emailAddress?.address,
//       received: m.receivedDateTime,
//       bodyPreview: m.bodyPreview
//     } : null);
//   } catch (e) {
//     console.error('latest-email error', e);
//     res.status(500).json({ error: 'Failed to fetch latest email' });
//   }
// });

// router.post('/disconnect', validateAuth0Token as express.RequestHandler, attachUser as any, async (req, res) => {
//   await User.findByIdAndUpdate(req.user!._id, { $unset: { msTokens: '' } });
//   res.json({ ok: true });
// });

// export default router;
