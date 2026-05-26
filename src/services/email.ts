import nodemailer from 'nodemailer'
import { env } from '../config/env'

const BAD_EMAIL_URL = process.env.BAD_EMAIL_VALIDATOR_URL

async function isEmailAllowed(email: string): Promise<boolean> {
  if (!BAD_EMAIL_URL) return true
  try {
    const res = await fetch(BAD_EMAIL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailToCheckFor: email }),
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json() as { code: number }
    return data.code === 200
  } catch {
    // fail-open: if the validator is unreachable, allow the email through
    return true
  }
}

const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: true,
  auth: {
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
  },
})

const FROM = env.SMTP_FROM
const FRONTEND = env.FRONTEND_URL

export async function sendOtpEmail(email: string, name: string, otp: string): Promise<void> {
  const allowed = await isEmailAllowed(email)
  if (!allowed) throw new Error('Email address is not valid for delivery')
  await transporter.sendMail({
    from: FROM,
    to: email,
    subject: 'Sanchayam - Password Reset OTP',
    html: `
      <p>Hi ${name},</p>
      <p>Your password reset OTP is: <strong style="font-size:24px;letter-spacing:4px">${otp}</strong></p>
      <p>This OTP expires in 15 minutes. Do not share it with anyone.</p>
      <p>If you did not request a password reset, ignore this email.</p>
    `,
    text: `Hi ${name},\n\nYour Sanchayam password reset OTP is: ${otp}\n\nThis OTP expires in 15 minutes.`,
  })
}

export async function sendInviteEmail(email: string, token: string, label?: string): Promise<void> {
  const allowed = await isEmailAllowed(email)
  if (!allowed) throw new Error('Email address is not valid for delivery')
  const link = `${FRONTEND}/invite/${token}`
  await transporter.sendMail({
    from: FROM,
    to: email,
    subject: 'You have been invited to Sanchayam',
    html: `
      <p>${label ? `Hi ${label},` : 'Hello,'}</p>
      <p>You have been invited to join Sanchayam - a personal portfolio tracker.</p>
      <p><a href="${link}">Click here to create your account</a></p>
      <p>This invite link expires in 48 hours.</p>
    `,
    text: `You have been invited to Sanchayam.\n\nCreate your account: ${link}\n\nThis link expires in 48 hours.`,
  })
}
