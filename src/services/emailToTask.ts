// services/emailToTask.ts
import OpenAI from 'openai';
import { z } from 'zod';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export type DecideExtractInput = {
  subject: string;
  body: string;
  receivedAt?: string;
  fromMe?: boolean; // NEW: true if the email was sent by the connected user
};

export type DecideExtractOutput = {
  actionable: boolean;
  task?: {
    title: string;
    description: string;
    priority: 'low' | 'medium' | 'high';
    dueDate: Date;
  };
};

const PrioritySchema = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const s = v.trim().toLowerCase();
  if (['urgent', 'asap', 'rush', 'high priority'].includes(s)) return 'high';
  if (['med', 'normal'].includes(s)) return 'medium';
  if (['low', 'minor'].includes(s)) return 'low';
  return s; // allow 'high' | 'medium' | 'low' to pass through
}, z.enum(['low', 'medium', 'high']));

// Optional: infer a TS type directly from the schema
type Priority = z.infer<typeof PrioritySchema>; // 'low' | 'medium' | 'high'

export async function decideAndExtractTask(input: DecideExtractInput): Promise<DecideExtractOutput> {
  const cheapText = (input.subject + ' ' + input.body).toLowerCase();

  // Phrases that indicate WE committed to do something (outbound only)
  const outboundCommitment =
    /(i[' ]?ll|i will|i shall|i can|i’m going to|i am going to|i will prepare|i will send|i will upload|i will share|i will schedule|i will book|i will follow up|i will review|i will draft|i will update|i will revise|i will confirm|i will arrange)/i;

  // Generic inbound action hints (requests directed to us)
  const inboundHints =
    /(due|deadline|asap|urgent|please (send|provide|review|sign|approve|confirm|schedule)|need(ed)?|required|by \d{4}-\d{2}-\d{2}|invoice|payment|bank|document|upload|follow up|call|meeting|book|schedule)/i;

  let shouldCallAI = false;
  if (input.fromMe) {
    // Only consider outbound emails if we actually committed to an action
    shouldCallAI = outboundCommitment.test(cheapText);
  } else {
    shouldCallAI = inboundHints.test(cheapText);
  }

  if (!shouldCallAI) return { actionable: false };

  const system = `You are classifying emails into actionable admin tasks
for a Tax Accounting & Planning Advisory Firm.

Return STRICT JSON ONLY (no prose):
{
  "actionable": true|false,
  "reason": "<short>",
  "task": {
    "title": "...",
    "description": "...",
    "priority": "low|medium|high",
    "dueDateISO": "YYYY-MM-DD or RFC3339"
  }
}

Decision rules:
- INBOUND emails (fromMe=false): actionable only if they ask us to do something concrete
  (send/provide/prepare/review/sign/approve/confirm/schedule/pay, a deadline, documents requested, etc.).
- OUTBOUND emails (fromMe=true): actionable only if WE explicitly promised or assigned ourselves a task
  (e.g., "I'll send...", "I will upload...", "I'll prepare by Friday", "I'll schedule...", "I'll review and revert by ...").
- OUTBOUND emails that are merely questions, clarifications, status checks, or requests for
  information from the recipient are NOT actionable.
- Ignore quoted history and signatures/footers if present.
- Prefer concise titles like "Send ISO 27001 certificate" or "Schedule client call".
- If no explicit due date is provided, use a sensible default in dueDateISO (1 week from receivedAt, if given).
- Assume the domain is tax/accounting/planning/advisory, so tasks should reflect follow-ups,
  gathering documents, preparing returns, scheduling calls, handling CRA notices, client requests, etc.
`;

  const perspective = input.fromMe
    ? 'fromMe=true (OUTBOUND email I wrote)'
    : 'fromMe=false (INBOUND email received)';

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    { role: 'assistant', content: `Context: ${perspective}. Assess only the email body provided.` },
    {
      role: 'user',
      content: `Subject: ${input.subject || '(no subject)'}\n\n${input.body}`,
    },
  ];

  const resp = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages,
  });

  const json = safeParse(resp.choices[0].message.content || '{}');
  if (!json || json.actionable !== true || !json.task) return { actionable: false };

  // 1) Normalize priority via Zod (handles "High", "ASAP", etc.)
  const parsedPriority = PrioritySchema.safeParse(json.task.priority ?? 'medium');
  const priority: Priority = parsedPriority.success ? parsedPriority.data : 'medium';

  // 2) Due date handling
  const dueISO = coerceDueDateISO(json.task.dueDateISO, input.receivedAt);
  const due = new Date(dueISO ?? defaultDueDateISO(input.receivedAt));

  return {
    actionable: true,
    task: {
      title: json.task.title || input.subject || 'Follow up',
      description: json.task.description || '',
      priority, // 'low' | 'medium' | 'high'
      dueDate: due,
    },
  };
}

/* --------------------- helpers --------------------- */
function safeParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function defaultDueDateISO(receivedAt?: string): string {
  const base = receivedAt ? new Date(receivedAt) : new Date();
  base.setDate(base.getDate() + 7);
  return base.toISOString();
}

function coerceDueDateISO(input?: string, receivedAt?: string) {
  if (!input) return undefined;
  const s = input.trim();
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (ymd) return new Date(`${ymd[1]}-${ymd[2]}-${ymd[3]}T17:00:00`).toISOString();

  const base = receivedAt ? new Date(receivedAt) : new Date();
  const lower = s.toLowerCase();
  if (lower === 'today') return new Date(base).toISOString();
  if (lower === 'tomorrow') {
    const d = new Date(base);
    d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  return undefined;
}
