import express from 'express';
import axios from 'axios';
import Subscription from '../models/Subscription';
import { validateAuth0Token, attachUser } from '../middleware/auth';
import { getValidAccessToken } from './microsoftAuth';
import crypto from 'crypto';

const router = express.Router();
const MAX_MINUTES = 4230;
const REQUEST_MINUTES = MAX_MINUTES - 10; // 4220
function isoRoundedUtcMinutesFromNow(minutes: number) {
  const d = new Date();
  // use UTC setters so the string is clean UTC and on the minute
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString();
}

async function deleteGraphSubscription(accessToken: string, id: string) {
  try {
    await axios.delete(`https://graph.microsoft.com/v1.0/subscriptions/${id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    console.log('[SUBSCRIBE] Deleted Graph subscription', id);
  } catch (e: any) {
    console.log(
      '[SUBSCRIBE] delete old sub failed',
      id,
      e?.response?.status,
      e?.response?.data
    );
  }
}

router.get('/subscribe-status', validateAuth0Token, attachUser as any, async (req, res) => {
    const userId = String(req.user._id);
    const sub = await Subscription.findOne({ userId }).lean();
    res.json({ subscription: sub });
  }
);
/**
 * POST /microsoft/subscribe-inbox
 * Makes a Graph subscription for new messages in the current user's mailbox.
 */
router.post('/subscribe-inbox', validateAuth0Token, attachUser as any, async (req, res) => {
    try {
      const userId = String(req.user._id);
      const accessToken = await getValidAccessToken(userId);
      if (!accessToken) {
        res.status(400).json({ error: 'Microsoft not connected' });
        return;
      }

      const baseUrl = String(process.env.PUBLIC_API_BASE_URL || '');
      if (!/^https:\/\//i.test(baseUrl)) {
        console.error('[SUBSCRIBE] PUBLIC_API_BASE_URL must be HTTPS');
        res.status(400).json({ error: 'PUBLIC_API_BASE_URL must be HTTPS' });
        return;
      }
      const notificationUrl = `${baseUrl}/api/microsoft/notifications`;
      console.log('[SUBSCRIBE] Using notificationUrl =', notificationUrl);

      // Check if we already have a non-expired sub
      const existing = await Subscription.findOne({ userId }).lean();
      const now = Date.now();
      const fifteenMinutes = 15 * 60 * 1000;

        if (existing?.expirationDateTime) {
      const expiryMs = new Date(existing.expirationDateTime as any).getTime();
      if (expiryMs - now > fifteenMinutes) {
        res.json({
          ok: true,
          reused: true,
          subscriptionId: existing.subscriptionId,
          expires: existing.expirationDateTime,
        });
        return;
      }
    }
      // Clean up old (if any)
      if (existing?.subscriptionId) {
        await deleteGraphSubscription(accessToken, existing.subscriptionId);
        await Subscription.deleteOne({ _id: existing._id });
      }

      const clientState = crypto.randomBytes(32).toString('hex');
      const desiredExpiration = isoRoundedUtcMinutesFromNow(REQUEST_MINUTES);
      // const expirationDateTime = new Date(Date.now() + 50 * 60 * 1000).toISOString(); // ~50 min

      const { data } = await axios.post(
        'https://graph.microsoft.com/v1.0/subscriptions',
        {
          changeType: 'created',
          notificationUrl,
          resource: '/me/messages',
          clientState,
          expirationDateTime: desiredExpiration,
        },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      await Subscription.findOneAndUpdate(
        { userId }, // one row per user
        {
          userId,
          subscriptionId: data.id,
          resource: data.resource,
          clientState,
          expirationDateTime: data.expirationDateTime,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );


      

      res.json({ ok: true, reused: false, subscriptionId: data.id, expires: data.expirationDateTime });
      return;
    } catch (e: any) {
      console.error('subscribe-inbox error', e?.response?.data || e);
      res.status(400).json({ error: 'Failed to create subscription' });
      return;
    }
  }
);

export default router;
