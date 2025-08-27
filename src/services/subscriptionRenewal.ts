// services/subscriptionRenewal.ts
import axios from 'axios';
import Subscription from '../models/Subscription';
import { getValidAccessToken } from '../routes/microsoftAuth';

const RENEW_WINDOW_MIN = 24 * 60;       // renew if less than 24h left
const CHECK_EVERY_MS   = 30 * 60 * 1000; // check every 30 min
const MAX_MINUTES      = 4230;           // Graph max for /me/messages

function addMinutes(date: Date, min: number) {
  return new Date(date.getTime() + min * 60 * 1000);
}

export async function renewDueSubscriptions() {
  const renewBefore = addMinutes(new Date(), RENEW_WINDOW_MIN);

  const due = await Subscription.find({
    expirationDateTime: { $lte: renewBefore.toISOString() },
  }).lean();

  if (!due.length) return;

  for (const sub of due) {
    try {
      const userId = String(sub.userId);
      const accessToken = await getValidAccessToken(userId);
      if (!accessToken) {
        console.log('[RENEW] skip: no token for user', userId);
        continue;
      }

      const newExpiry = addMinutes(new Date(), MAX_MINUTES).toISOString();

      const { data } = await axios.patch(
        `https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(sub.subscriptionId)}`,
        { expirationDateTime: newExpiry },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      await Subscription.updateOne(
        { subscriptionId: sub.subscriptionId },
        { $set: { expirationDateTime: data.expirationDateTime } }
      );

      console.log('[RENEW] renewed', sub.subscriptionId, '->', data.expirationDateTime);
    } catch (e: any) {
      const status = e?.response?.status;
      const msg = e?.response?.data?.error?.message || e?.message;
      console.log('[RENEW] failed for', sub.subscriptionId, status, msg);

      // If the sub is gone/invalid, purge it so your next /subscribe-inbox call recreates cleanly
      if (status === 404 || status === 410 || status === 403) {
        await Subscription.deleteOne({ subscriptionId: sub.subscriptionId });
        console.log('[RENEW] deleted local sub (will recreate on next subscribe-inbox)');
      }
    }
  }
}

let timer: NodeJS.Timeout | null = null;
export function startRenewalScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    renewDueSubscriptions().catch(err => console.error('[RENEW] tick error', err));
  }, CHECK_EVERY_MS);

  // fire once at boot
  renewDueSubscriptions().catch(err => console.error('[RENEW] initial error', err));
  console.log('[RENEW] scheduler started');
}
