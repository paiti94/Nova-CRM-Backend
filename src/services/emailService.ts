import dotenv from 'dotenv';
dotenv.config();

export async function sendSmtp2GoEmail(
  to: string | string[],
  subject: string,
  text: string,
  html: string,
  replyTo?: string
) {
  const apiKey = process.env.SMTP2GO_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) throw new Error("Missing SMTP2GO config");

  const payload: any = {
    api_key: apiKey,
    to: Array.isArray(to) ? to : [to],
    sender: from,
    subject,
    text_body: text,
    html_body: html,
  };

  if (replyTo) {
    payload.custom_headers = [
      { header: "Reply-To", value: replyTo }
    ];
  }

  // If using Node 16 or lower, install node-fetch and import as shown earlier!
  const response = await fetch('https://api.smtp2go.com/v3/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!(data && data.data && data.data.succeeded)) {
    throw new Error('SMTP2GO send failed: ' + JSON.stringify(data));
  }
  return data;
}
