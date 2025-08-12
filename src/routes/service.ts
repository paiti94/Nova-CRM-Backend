import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,        // e.g. 'your_email@gmail.com'
    pass: process.env.EMAIL_PASS,        // Gmail "App password" (not your Gmail login password)
  },
});

export async function sendMail(to: string, subject: string, text: string) {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to,
    subject,
    text,
  });
}