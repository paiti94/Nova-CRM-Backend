// routes/microsoftAuth.ts
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import qs from 'qs';
import User from '../models/User';
import { verifyAuth0Jwt, validateAuth0Token, attachUser } from '../middleware/auth';
import { AuthorizationCode } from 'simple-oauth2';

const router = express.Router();

// Short-lived state store to prevent tampering
const stateStore = new Map<string, { userId: string; expiresAt: number }>();

function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+\n/g, '\n')
    .trim();
}

// extremely lightweight MIME text extractor
function extractTextFromMime(mime: string): { text?: string; html?: string } {
  // Try to find text/plain part
  const textMatch = mime.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)\r?\n--/i);
  const htmlMatch = mime.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)\r?\n--/i);
  const text = textMatch?.[1]?.trim();
  const html = htmlMatch?.[1]?.trim();
  return { text, html };
}

const CLIENT_ID = process.env.MS_CLIENT_ID!;
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET!;
const SCOPES = 'openid profile email offline_access Mail.Read';
const oauth2 = new AuthorizationCode({
    client: {
      id: process.env.MS_CLIENT_ID || "",
      secret: process.env.MS_CLIENT_SECRET || "",
    },
    auth: {
      tokenHost: "https://login.microsoftonline.com",
      authorizePath: "/common/oauth2/v2.0/authorize",
      tokenPath: "/common/oauth2/v2.0/token",
    },
  });


// 3) Protected: fetch latest email (and auto-refresh)
export async function getValidAccessToken(userId: string) {
  // read tokens including hidden fields
  const user = await User.findById(userId).select('+msTokens.access_token +msTokens.refresh_token').lean();
  const tokens = user?.msTokens;
  if (!tokens?.access_token) return null;

  const isExpired = tokens.expires_at && new Date(tokens.expires_at).getTime() < Date.now();
  if (!isExpired) return tokens.access_token;

  if (!tokens.refresh_token) return null;

  // refresh
  const tokenUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
  const form = qs.stringify({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    scope: SCOPES,
  });

  const r = await axios.post(tokenUrl, form, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const nt = r.data as { access_token: string; refresh_token?: string; expires_in: number; token_type: string; scope?: string };
  const expiresAt = new Date(Date.now() + (nt.expires_in - 60) * 1000);

  await User.findByIdAndUpdate(userId, {
    msTokens: {
      access_token: nt.access_token,
      refresh_token: nt.refresh_token || tokens.refresh_token,
      token_type: nt.token_type,
      scope: nt.scope || SCOPES,
      expires_at: expiresAt,
      expires_in: nt.expires_in,
    }
  });

  return nt.access_token;
}
export async function fetchLatestEmailForUser(userId: string, accessToken: string) {
  const listUrl =
    "https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages" +
    "?$top=1&$orderby=receivedDateTime desc" +
    "&$select=id,subject,from,receivedDateTime,bodyPreview,conversationId,internetMessageId,webLink";

  const listRes = await axios.get(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const m = listRes.data?.value?.[0];
  if (!m) return null;

  const encodedId = encodeURIComponent(m.id);
  const detailUrl =
    `https://graph.microsoft.com/v1.0/me/messages/${encodedId}` +
    `?$select=body,uniqueBody,subject,from,receivedDateTime,conversationId,internetMessageId,webLink`;

  const detailRes = await axios.get(detailUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.body-content-type="text"', // ask for text first
    },
    validateStatus: () => true,
  });

  if (detailRes.status !== 200) {
    console.error("Graph detail error:", detailRes.status, detailRes.data);
    throw new Error(`Failed to fetch email body: ${detailRes.status}`);
  }

  // Prefer full body; fallback to uniqueBody; finally to bodyPreview
  const bodyObj = detailRes.data?.body || detailRes.data?.uniqueBody;
  let bodyText = (bodyObj?.content ?? "").trim();
  if (!bodyText) bodyText = (m.bodyPreview ?? "").trim();

  // If content is suspiciously short, do a MIME fallback
  if (bodyText.length < 15) {
    try {
      const mimeRes = await axios.get(
        `https://graph.microsoft.com/v1.0/me/messages/${encodedId}/$value`,
        { headers: { Authorization: `Bearer ${accessToken}` }, responseType: "text", validateStatus: () => true }
      );
      if (mimeRes.status === 200 && typeof mimeRes.data === "string") {
        const { text, html } = extractTextFromMime(mimeRes.data);
        if (text && text.trim().length > bodyText.length) bodyText = text.trim();
        else if (html && stripHtmlToText(html).length > bodyText.length) bodyText = stripHtmlToText(html);
      } else {
        console.warn("MIME fetch non-200:", mimeRes.status);
      }
    } catch (e) {
      console.warn("MIME fetch failed, continuing with existing bodyText");
    }
  }

  return {
    messageId: m.id as string,
    subject: m.subject ?? "",
    from: m.from?.emailAddress?.address ?? "",
    fromName: m.from?.emailAddress?.name ?? "",   
    receivedAt: m.receivedDateTime as string,
    bodyText,
    conversationId: m.conversationId,
    internetMessageId: m.internetMessageId,
    webLink: m.webLink,
  };
}

  
router.get("/login", async (req, res) => {
    try {
      const { auth_token } = req.query;
      if (!auth_token || typeof auth_token !== "string") {
        res.status(401).json({ error: "Missing or invalid auth_token" });
        return;
      }
  
      // Verify Auth0 JWT and derive the user
      const payload = verifyAuth0Jwt(auth_token);
      if (!payload?.sub) {
        res.status(401).json({ error: "Invalid Auth0 token" });
        return;
      }
  
      const user = await User.findOne({ auth0Id: payload.sub });
      if (!user || !user._id) {
        res.status(401).json({ error: "User not found" });
        return;
      }
  
      // Build Microsoft authorize URL with your server REDIRECT URI
      const authorizationUri = oauth2.authorizeURL({
        redirect_uri: process.env.MS_REDIRECT_URI,   // e.g. http://localhost:5001/api/microsoft/callback
        scope: SCOPES,
        state: user._id.toString(),
      });
  
      res.redirect(authorizationUri);
    } catch (err) {
      console.error("MS /login error:", err);
      res.status(500).json({ error: "Failed to start Microsoft auth" });
    }
  });
  
router.get('/callback', async (req, res) => {
    try {
      const { code, state } = req.query;
  
      if (!code || !state) {
         res.status(400).json({ error: 'Missing code or state' });
         return;
      }
  
      // IMPORTANT: must match Azure "Web" redirect URI exactly
      const redirectUri = process.env.MS_REDIRECT_URI; // e.g. http://localhost:5001/api/microsoft/callback
      if (!redirectUri) {
         res.status(500).json({ error: 'MS_REDIRECT_URI not set' });
         return;
      }
  
      // Do the code-for-token exchange on the server
      const tokenUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
      const form = new URLSearchParams({
        client_id: process.env.MS_CLIENT_ID!,           // Azure App (client) ID
        client_secret: process.env.MS_CLIENT_SECRET!,   // Azure client secret (VALUE, not ID)
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri,
        scope: 'openid profile email offline_access Mail.Read'
      });
  
      const tokenRes = await axios.post(tokenUrl, form, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true, // we’ll inspect non-200s
      });
  
      if (tokenRes.status !== 200) {
        console.error('MS token exchange error:', tokenRes.status, tokenRes.data);
         res.status(400).json({ error: 'Token exchange failed', detail: tokenRes.data });
         return;
      }
  
      const tok = tokenRes.data as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
        token_type: string;
        scope?: string;
      };
  
      // state is the Mongo userId we set in /login
      const userId = String(state);
      const user = await User.findById(userId);
      if (!user) {
         res.status(404).json({ error: 'User not found for state' });
         return;
      }
  
      const expiresAt = new Date(Date.now() + (tok.expires_in - 60) * 1000);
      user.msTokens = {
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        token_type: tok.token_type,
        scope: tok.scope || 'openid profile email offline_access Mail.Read',
        expires_in: tok.expires_in,
        expires_at: expiresAt,
      };
      await user.save();
  
      const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
      res.redirect(`${clientUrl}/outlook-popup-done`);
      return;
      // res.set('Content-Type', 'text/html').send(`<!doctype html>
      //   <html>
      //     <head><meta charset="utf-8"><title>Connected</title></head>
      //     <body>
      //       <script>
      //         (function () {
      //           try {
      //             if (window.opener && !window.opener.closed) {
      //               // notify the opener (parent SPA) that MS connect finished
      //               window.opener.postMessage({ type: 'ms-connected' }, '${clientUrl}');
      //             }
      //           } catch (e) { /* ignore */ }
      //           // attempt to close the popup
      //           setTimeout(function(){ window.close(); }, 50);
      //         })();
      //       </script>
      //       <p>You can close this window.</p>
      //     </body>
      //   </html>`);
      //   return;
    } catch (err: any) {
      console.error('MS callback error:', err?.response?.data || err);
       res.status(500).json({ error: 'OAuth callback failed' });
       return;
    }
  });


router.get('/latest-email', validateAuth0Token, attachUser as any, async (req, res) => {
  // try {
  //   const userId = String(req.user!._id);
  //   const accessToken = await getValidAccessToken(userId);
  //   if (!accessToken) { res.status(400).json({ error: 'Microsoft account not connected' }); return; }

  //   const graph = await axios.get(
  //     'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?$top=1&$orderby=receivedDateTime desc',
  //     { headers: { Authorization: `Bearer ${accessToken}` } }
  //   );
  //   const m = graph.data.value?.[0];
  //   console.log(m);
  //   res.json(m ? {
  //     subject: m.subject,
  //     from: m.from?.emailAddress?.address,
  //     received: m.receivedDateTime,
  //     bodyPreview: m.bodyPreview
  //   } : null);
  // } catch (e) {
  //   console.error('latest-email error', e);
  //   res.status(500).json({ error: 'Failed to fetch latest email' });
  // }
  try {
    const userId = String(req.user!._id);
    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) { res.status(400).json({ error: 'Microsoft account not connected' }); return; }
    const email = await fetchLatestEmailForUser(userId, accessToken);
    res.json(email); // might be null if no mail
  } catch (e) {
    console.error('latest-email error', e);
    res.status(500).json({ error: 'Failed to fetch latest email' });
  }
});

router.post('/disconnect', validateAuth0Token, attachUser as any, async (req, res) => {
  await User.findByIdAndUpdate(req.user!._id, { $unset: { msTokens: '' } });
  res.json({ ok: true });
});

export default router;
