// routes/microsoftNotifications.ts
import express from 'express';
import axios from 'axios';
import mongoose from 'mongoose';
import Task from '../models/Task';
import Subscription from '../models/Subscription';
import { getValidAccessToken } from './microsoftAuth';
import { decideAndExtractTask } from '../services/emailToTask';

const router = express.Router();

/* ------------------------------------------------------------------ */
/* In-memory de-dupe (cuts redundant Graph+AI calls within ~90s)      */
/* ------------------------------------------------------------------ */
const recentMessages = new Map<string, number>(); // messageId -> expiry ms
const RECENT_TTL_MS = 90_000;

function seenRecently(id: string) {
  const now = Date.now();
  for (const [k, v] of recentMessages) if (v < now) recentMessages.delete(k);
  const hit = recentMessages.has(id);
  recentMessages.set(id, now + RECENT_TTL_MS);
  return hit;
}

/* ------------------------------------------------------------------ */
/* Graph validation handshake                                          */
/* ------------------------------------------------------------------ */
router.get('/microsoft/notifications', (req, res) => {
  const token = req.query.validationToken as string | undefined;
  if (token) {
    res.set('Content-Type', 'text/plain');
    res.status(200).send(token);
    return;
  }
  res.sendStatus(400);
});

/* ------------------------------------------------------------------ */
/* Webhook receiver                                                    */
/* ------------------------------------------------------------------ */
router.post('/microsoft/notifications', async (req, res) => {
  // POST-variant validation handshake
  const token = req.query.validationToken as string | undefined;
  if (token) {
    res.set('Content-Type', 'text/plain');
    res.status(200).send(token);
    return;
  }

  // Ack immediately; do work async
  res.sendStatus(202);

  try {
    const notifications: any[] = req.body?.value || [];
    if (!Array.isArray(notifications) || notifications.length === 0) {
      console.log('[WEBHOOK] No notifications in body');
      return;
    }

    for (const n of notifications) {
      try {
        console.log('[WEBHOOK] notif summary:', {
          subscriptionId: n.subscriptionId,
          clientState: !!n.clientState,
          changeType: n.changeType,
          resource: n.resource,
          hasResourceData: !!n.resourceData,
        });

        /* 1) Look up subscription & verify clientState */
        const sub = await Subscription.findOne({ subscriptionId: n.subscriptionId }).lean();
        if (!sub) {
          console.log('[WEBHOOK] skip: no subscription in DB for', n.subscriptionId);
          continue;
        }
        if (!sub.clientState || sub.clientState !== n.clientState) {
          console.log('[WEBHOOK] skip: clientState mismatch for sub', n.subscriptionId);
          continue;
        }

        const userIdStr = String(sub.userId);
        const accessToken = await getValidAccessToken(userIdStr);
        if (!accessToken) {
          console.log('[WEBHOOK] skip: no access token for user', userIdStr);
          continue;
        }

        const loggedInUserEmail = await getLoggedInUserEmail(userIdStr);
        if (!loggedInUserEmail) {
          console.log('[WEBHOOK] skip: could not get logged-in user email.');
          continue;
        }

        /* 2) Parse messageId (resource or resourceData.id) */
        let messageId: string | undefined;
        const match = /messages\('([^']+)'\)/.exec(n.resource || '');
        if (match?.[1]) messageId = match[1];
        else if (n.resourceData?.id) messageId = n.resourceData.id;

        if (!messageId) {
          console.log('[WEBHOOK] skip: cannot parse messageId from notification', n.resource);
          continue;
        }

        // EARLY dedupe: skip burst duplicates before any costly calls
        if (seenRecently(messageId)) {
          console.log('[WEBHOOK] skip: recent duplicate', messageId);
          continue;
        }

        /* 3) Fetch the message (retry a little—Graph can lag) */
        const fetchMessage = async (idToFetch?: string) => {
          const targetId = idToFetch || messageId!;
          const url =
            `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(targetId)}` +
            `?$select=id,subject,receivedDateTime,webLink,from,conversationId,internetMessageId,bodyPreview,uniqueBody,toRecipients`;
          return axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        };

        let msgResp;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            msgResp = await fetchMessage();
            break;
          } catch (e: any) {
            const status = e?.response?.status;
            console.log(`[WEBHOOK] fetch attempt ${attempt} failed (status ${status}). Retrying...`);
            await new Promise((r) => setTimeout(r, 400 * attempt)); // 400ms, 800ms, 1200ms
          }
        }
        if (!msgResp?.data) {
          console.log('[WEBHOOK] skip: message fetch failed for id', messageId);
          continue;
        }
        const msg = msgResp.data;

        const fromAddr = msg?.from?.emailAddress?.address?.toLowerCase() || '';
        const subject = msg?.subject || '';

        // Determine if this is a message sent by the connected user
        const isSentByMe = fromAddr === loggedInUserEmail?.toLowerCase();

        /* 4) Take only the newest chunk of the email (no quoted history) */
        const newestText = selectNewestBody(msg);
        if (!newestText || !newestText.trim()) {
          console.log('[WEBHOOK] skip: newestText empty for id', msg.id);
          continue;
        }

        // Filter certain automated senders (extend as needed)
        if (fromAddr.includes('quickbooks.com') || fromAddr.includes('mailchimp.com')) {
          console.log(`[WEBHOOK] skip: filtered sender ${fromAddr}`);
          continue;
        }

        // Build bodyForAI with perspective-specific stripping
        let bodyForAI = '';
        if (isSentByMe) {
          console.log('[WEBHOOK] Handling email sent by me...');
          // For any email I sent (new or reply), analyze MY message only (aggressive stripping to drop quoted history)
          bodyForAI = stripNoise(newestText, /* aggressive */ true).slice(0, 2000);
        } else {
          // Standard handling for inbound emails
          bodyForAI = stripNoise(newestText, /* aggressive */ false).slice(0, 2000);
        }

        if (!bodyForAI || !bodyForAI.trim()) {
          console.log('[WEBHOOK] skip: processed body is empty for id', msg.id);
          continue;
        }

        /* 5) Ask AI: actionable? If yes, extract single task */
        const result = await decideAndExtractTask({
          subject,
          body: bodyForAI,
          receivedAt: msg?.receivedDateTime,
          fromMe: isSentByMe, // NEW: give perspective to the model
        });

        console.log('[WEBHOOK] AI decision:', {
          actionable: result?.actionable,
          hasTask: !!result?.task,
          title: result?.task?.title,
          priority: result?.task?.priority,
        });

        if (!result.actionable || !result.task) continue;

        /* 6) Atomic upsert (DB-level dedupe) */
        const createdBy = new mongoose.Types.ObjectId(userIdStr);
        const key = {
          createdBy,
          source: 'outlook',
          sourceEmailId: msg.id,
        };

        // meta block for description
        const fromName = msg?.from?.emailAddress?.name || '';
        const toRecipients = msg?.toRecipients || [];
        const toList = toRecipients
          .map((r: any) => {
            const name = r?.emailAddress?.name;
            const address = r?.emailAddress?.address;
            if (name && address) {
              return `${name} <${address}>`;
            } else if (address) {
              return address;
            }
            return '';
          })
          .filter(Boolean);

        const receivedISO = msg?.receivedDateTime ? new Date(msg.receivedDateTime) : undefined;

        const metaBlock =
          `— Source: Outlook` +
          (fromName || fromAddr ? `\n— From: ${fromName || ''} <${fromAddr || ''}>` : '') +
          (toList.length > 0 ? `\n— To: ${toList.join(', ')}` : '') +
          (receivedISO ? `\n— Received: ${receivedISO.toLocaleString()}` : '');

        const description = [result.task.description || '', '', metaBlock].join('\n').trim();

        const doc = {
          title: result.task.title,
          description,
          createdBy,
          assignedTo: [createdBy],
          status: 'pending',
          priority: result.task.priority, // 'low' | 'medium' | 'high'
          dueDate: result.task.dueDate, // Date
          attachments: [],
          comments: [{ user: createdBy, content: 'Auto-created from Outlook email.' }],
          source: 'outlook',
          sourceEmailId: msg.id,
          sourceThreadId: msg?.conversationId,
          sourceWebLink: msg?.webLink,
          sourceFromName: fromName || undefined,
          sourceFromAddress: fromAddr || undefined,
          sourceReceivedAt: receivedISO,
          sourceSubject: msg?.subject || undefined,
          sourceSnippet: bodyForAI || undefined,
          // optional auditing:
          sourcePerspective: isSentByMe ? 'outbound' : 'inbound',
        };

        const upsertRes = await Task.updateOne(key, { $setOnInsert: doc }, { upsert: true });
        const inserted =
          (upsertRes as any).upsertedCount === 1 || !!(upsertRes as any).upsertedId;

        if (inserted) {
          console.log('[WEBHOOK] task created (upsert) for message', msg.id);
        } else {
          console.log('[WEBHOOK] task already existed (upsert no-op) for', msg.id);
        }
      } catch (innerErr) {
        console.error('[WEBHOOK] per-notification error:', innerErr);
      }
    }
  } catch (err) {
    console.error('notifications error', err);
  }
});

export default router;

/* -------------------------- helpers -------------------------- */
async function getLoggedInUserEmail(userId: string): Promise<string | null> {
  // TODO: Replace with your real lookup logic (DB or Graph)
  try {
    return 'user@example.com'; // Dummy value
  } catch (e) {
    console.error('Failed to get logged-in user email:', e);
    return null;
  }
}

function selectNewestBody(msg: any) {
  if (msg?.uniqueBody?.content) {
    const html = msg?.uniqueBody?.contentType === 'html';
    return html ? stripHtml(msg.uniqueBody.content) : msg.uniqueBody.content;
  }
  if (msg?.bodyPreview) return msg.bodyPreview;
  return '';
}

function stripHtml(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strips noise from email body.
 * @param text The email body text.
 * @param aggressive If true, uses a more aggressive pattern for replies (drops quoted history).
 */
function stripNoise(text: string, aggressive = false) {
  const lines = text.split(/\r?\n/);

  if (aggressive) {
    const stopIdx = lines.findIndex(
      (l) =>
        /^from:\s/i.test(l) ||
        /^sent:\s/i.test(l) ||
        /^to:\s/i.test(l) ||
        /^subject:\s/i.test(l) ||
        /^on .* wrote:$/i.test(l) ||
        /^[-_]{2,}$/.test(l.trim())
    );
    const upTo = stopIdx > 0 ? lines.slice(0, stopIdx) : lines;
    return upTo.join('\n').trim();
  }

  // Standard stripping for initial emails
  const stopIdx = lines.findIndex(
    (l) => /^from:\s/i.test(l) || /^on .* wrote:$/i.test(l) || /^[-_]{2,}$/.test(l.trim()) || /^>/.test(l)
  );
  const upTo = stopIdx > 0 ? lines.slice(0, stopIdx) : lines;

  // Remove common footers
  const stripped = upTo.filter(
    (l) => !/\b(disclaimer|confidential|unsubscribe|please consider the environment)\b/i.test(l)
  );
  return stripped.join('\n').trim();
}
