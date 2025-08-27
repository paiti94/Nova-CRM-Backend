// routes/openai.ts
import { Router, Request, Response } from "express";
import OpenAI from "openai";
import axios from "axios";
import qs from "qs";
import { z } from "zod";
import Task from "../models/Task";
import User from "../models/User";
import { fetchLatestEmailForUser, getValidAccessToken } from "./microsoftAuth"; // ⬅️ reuse
import mongoose from "mongoose";

const router = Router();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// Normalize & map synonyms -> low|medium|high
const PrioritySchema = z.preprocess((v) => {
    if (typeof v !== "string") return v;
    const s = v.trim().toLowerCase();
    if (["urgent", "asap", "rush", "high priority"].includes(s)) return "high";
    if (["med", "normal"].includes(s)) return "medium";
    if (["low", "minor"].includes(s)) return "low";
    return s; // e.g., "high" / "medium" / "low"
  }, z.enum(["low", "medium", "high"]));
  
const AiTaskSchema = z.object({
    title: z.string().min(1),
    description: z.string().optional().default(""),
    dueDateISO: z.string().optional(),
    priority: PrioritySchema.optional().default("medium"),
  });
  
  function defaultDueDateISO(receivedAt?: string): string {
    const base = receivedAt ? new Date(receivedAt) : new Date();
    base.setDate(base.getDate() + 7);
    return base.toISOString();
  }
  // 2) Normalizer
function coerceDueDateISO(input: string | undefined, receivedAt?: string): string | undefined {
    if (!input) return undefined;
    const s = input.trim();
  
    // common date-only (YYYY-MM-DD) — assume 17:00 local and convert to ISO
    const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (ymd) {
      const date = new Date(`${ymd[1]}-${ymd[2]}-${ymd[3]}T17:00:00`); // local 5pm
      if (!isNaN(date.getTime())) return date.toISOString();
    }
  
    // simple natural words
    const base = receivedAt ? new Date(receivedAt) : new Date();
    const lower = s.toLowerCase();
    if (lower === "today") {
      return new Date(base).toISOString();
    }
    if (lower === "tomorrow") {
      const d = new Date(base);
      d.setDate(d.getDate() + 1);
      return d.toISOString();
    }
    // "next friday" / "friday" naive handling (optional)
    const weekdays = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
    const idx = weekdays.indexOf(lower);
    if (idx >= 0) {
      const d = new Date(base);
      const add = (7 + idx - d.getDay()) % 7 || 7; // next occurrence
      d.setDate(d.getDate() + add);
      return d.toISOString();
    }
  
    // Try native Date parsing
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString();
  
    // give up
    return undefined;
  }
/**
 * POST /api/openai/latest-email-to-task
 * Auth: protected (mounted under your protectedRoutes)
 */
router.post("/latest-email-to-task", async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?._id as mongoose.Types.ObjectId | undefined;
      if (!userId) { res.status(401).json({ error: "User context missing" }); return; }
  
      const accessToken = await getValidAccessToken(String(userId));
      if (!accessToken) { res.status(400).json({ error: "Microsoft account not connected" }); return; }
  
      // 1) Pull latest email for THIS user (so mailbox ownership is implicitly enforced by token)
      const email = await fetchLatestEmailForUser(String(userId), accessToken);
      if (!email) { res.status(404).json({ error: "No emails found" }); return; }
  
  
      // 2) ask OpenAI for JSON task
    //   const system = [
    //     "You are an assistant that extracts ONE actionable task from an email for a Canadian CPA firm.",
    //     "Prefer concrete verbs and client-impacting actions.",
    //     "If a clear deadline exists in the email, set dueDateISO (ISO-8601). Otherwise you may omit it.",
    //     "Respond with JSON ONLY: { title, description, dueDateISO?, priority }",
    //   ].join(" ");
    const system = [
        "Extract ONE actionable task from the email for a Canadian CPA firm.",
        "Return JSON ONLY with keys: title, description, priority, dueDateISO.",
        "priority MUST be one of: low, medium, high (lowercase).",
        "If a deadline exists, set dueDateISO as RFC3339 (e.g., 2025-08-15T17:00:00Z).",
        "If only a date exists (YYYY-MM-DD), return that exactly in dueDateISO.",
        "If no clear deadline, omit dueDateISO."
      ].join(" ");

      const userContent = [
        `Subject: ${email.subject}`,
        `From: ${email.from}`,
        email.receivedAt ? `ReceivedAt: ${email.receivedAt}` : "",
        "",
        "Email Body:",
        email.bodyText.slice(0, 8000),
      ].join("\n");
  
      const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
      });
  
      const raw = completion.choices?.[0]?.message?.content || "{}";
      console.log("AI raw JSON:", raw);
      let parsed = AiTaskSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        // force default priority to kill the “High” vs enum issue
        const j = JSON.parse(raw); j.priority = "medium";
        parsed = AiTaskSchema.safeParse(j);
      }
      if (!parsed.success) {
         res.status(400).json({ error: "AI did not return valid task JSON" });
         return
      }
      const metaLines = [
        "— Source: Outlook",
        email.fromName ? `— From: ${email.fromName} <${email.from}>` : `— From: ${email.from || "Unknown"}`,
        email.receivedAt ? `— Received: ${new Date(email.receivedAt).toLocaleString()}` : undefined,
        email.internetMessageId ? `— Internet-Message-ID: ${email.internetMessageId}` : undefined,
        email.messageId ? `— Graph Message ID: ${email.messageId}` : undefined,
        email.webLink ? `— Open in Outlook: ${email.webLink}` : undefined,
      ].filter(Boolean).join("\n");
      
      const descriptionWithMeta = [parsed.data.description || "", "", metaLines].join("\n").trim();
      const coerced = coerceDueDateISO(parsed.data.dueDateISO, email.receivedAt);
      const due = new Date(coerced ?? defaultDueDateISO(email.receivedAt));
     // 3) Hard dedupe: same creator + same source + same message id
     if (email.messageId) {
        const existing = await Task.findOne({
          createdBy: userId,
          source: 'outlook',
          sourceEmailId: email.messageId,
        }).lean();
        if (existing) { res.json({ task: existing, deduped: true }); return; }
      }

      const existing = await Task.findOne({
        createdBy: userId,
        description: { $regex: email.messageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") },
      }).lean();
      if (existing) {
        res.json({ task: existing });
        return;
      } 
     
       // 4) Create task (match model exactly)
       const task = await Task.create({
        title: parsed.data.title,
        description: descriptionWithMeta,
        assignedTo: [userId],         // <— array (model requires ObjectId[])
        createdBy: userId,
        status: "pending",
        priority: parsed.data.priority, // already normalized to low|medium|high
        dueDate: due,
        attachments: [],
        comments: [{
          user: userId,
          content: [
            "Created from Outlook email.",
            email.fromName ? `From: ${email.fromName} <${email.from}>` : `From: ${email.from || "Unknown"}`,
            email.receivedAt ? `Received: ${new Date(email.receivedAt).toLocaleString()}` : undefined,
            email.webLink ? `Open in Outlook: ${email.webLink}` : undefined,
          ].filter(Boolean).join("\n"),
        }],
        source: 'outlook',
        sourceEmailId: email.messageId,
        sourceThreadId: email.conversationId,
      });

      res.status(201).json({ task });
      return;
    } catch (err: any) {
      console.error("latest-email-to-task error:", err?.response?.data || err);
      res.status(400).json({ error: err.message || "Failed to create task" });
      return;
    }
});

export default router;
