import { logger } from '../lib/logger'
import nodemailer from 'nodemailer'
import sql from '../db'
import { env } from '../config/env'

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

function stripMarkdown(text: string): string {
  return text.replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '').trim()
}

function subject(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case 'FX_RATE_UNAVAILABLE':              return `Sanchayam Alert: FX rate unavailable for ${payload.currency}`
    case 'PROVIDER_CALL_FAILED':             return `Sanchayam Alert: Provider call failed for ${payload.currency}`
    case 'PRICE_FETCH_FAILED':               return `Sanchayam Alert: Price fetch failed for asset ${payload.assetId}`
    case 'CORPORATE_ACTION_VALIDATION_FAILED': return `Sanchayam Alert: Corporate action data validation failed for ${payload.symbol}`
    case 'CORPORATE_ACTION_PRE2003_GAP':     return `Sanchayam Alert: Pre-2003 data gap for ${payload.symbol}`
    case 'BACKFILL_STAGE_FAILED':            return `Sanchayam Alert: Backfill failed for ${payload.symbol} (stage: ${payload.stage})`
    default:                                 return `Sanchayam Alert: ${type}`
  }
}

function body(type: string, payload: Record<string, unknown>): string {
  const ts  = new Date().toISOString()
  const err = payload.error ? stripMarkdown(String(payload.error)) : ''
  switch (type) {
    case 'FX_RATE_UNAVAILABLE':
      return `FX rate is unavailable for currency: ${payload.currency}\n\nError: ${err}\n\nTimestamp: ${ts}`
    case 'PROVIDER_CALL_FAILED':
      return `Provider call failed for currency: ${payload.currency}\n\nError: ${err}\n\nTimestamp: ${ts}`
    case 'PRICE_FETCH_FAILED':
      return `Price fetch permanently failed for asset: ${payload.assetId}\nSymbol: ${payload.symbol}\nRetries: ${payload.retryCount}\n\nError: ${err}\n\nTimestamp: ${ts}`
    case 'CORPORATE_ACTION_VALIDATION_FAILED':
      return `Corporate action data from external source failed validation.\n\nSymbol: ${payload.symbol}\nContext: ${payload.context}\n\nFailures:\n${payload.failures}\n\nNo data was inserted.\n\nTimestamp: ${ts}`
    case 'CORPORATE_ACTION_PRE2003_GAP':
      return `Asset has holding dates before 2003. NSE announcements do not cover this period.\n\nSymbol: ${payload.symbol}\nEarliest lot date: ${payload.earliestDate}\n\nName/symbol changes and mergers before 2003 are not available from any automated source. Manual review required.\n\nTimestamp: ${ts}`
    case 'BACKFILL_STAGE_FAILED':
      return `Backfill pipeline permanently failed for an asset.\n\nSymbol: ${payload.symbol}\nAsset ID: ${payload.assetId}\nStage: ${payload.stage}\nRetries: ${payload.retries}\n\nError: ${err}\n\nTimestamp: ${ts}`
    default:
      return `Event: ${type}\n\nPayload: ${JSON.stringify(payload, null, 2)}\n\nTimestamp: ${ts}`
  }
}

async function deliver(type: string, payload: Record<string, unknown>): Promise<void> {
  const [row] = await sql`
    SELECT c.channel_type, c.recipient_type, c.recipient_ref
    FROM notification_routing r
    JOIN notification_channels c ON c.name = r.channel_name
    WHERE r.notification_type = ${type}
      AND r.is_active = true
      AND c.is_active = true
  `
  if (!row) return

  let toEmail: string | null = null

  if (row.recipient_type === 'master_admin') {
    const [admin] = await sql`SELECT email FROM users WHERE is_master_admin = true AND is_deleted = false LIMIT 1`
    if (!admin) return
    toEmail = admin.email as string
  } else if (row.recipient_type === 'specific_email') {
    toEmail = row.recipient_ref as string | null
  } else if (row.recipient_type === 'specific_user') {
    if (!row.recipient_ref) return
    const [user] = await sql`SELECT email FROM users WHERE id = ${row.recipient_ref} AND is_deleted = false`
    if (!user) return
    toEmail = user.email as string
  }

  if (!toEmail) return

  if (row.channel_type === 'email') {
    await transporter.sendMail({
      from: FROM,
      to: toEmail,
      subject: subject(type, payload),
      text: body(type, payload),
    })
  }
}

async function processEmit(type: string, payload: Record<string, unknown>): Promise<void> {
  const [event] = await sql`
    INSERT INTO notification_events (type, payload)
    VALUES (${type}, ${sql.json(payload as never)})
    RETURNING id
  `

  try {
    await deliver(type, payload)
    await sql`UPDATE notification_events SET status = 'sent', processed_at = NOW() WHERE id = ${event.id}`
  } catch {
    await sql`UPDATE notification_events SET status = 'failed', retry_count = 1, processed_at = NOW() WHERE id = ${event.id}`
  }
}

export function emit(type: string, payload: Record<string, unknown>): void {
  processEmit(type, payload).catch(err => logger.error({ err }, '[notifications] emit error:'))
}

export async function retryFailedNotifications(): Promise<void> {
  const failed = await sql`
    SELECT id, type, payload FROM notification_events
    WHERE status = 'failed' AND retry_count < 3
    ORDER BY created_at ASC
  `

  for (const event of failed) {
    try {
      await deliver(event.type, event.payload as Record<string, unknown>)
      await sql`UPDATE notification_events SET status = 'sent', processed_at = NOW() WHERE id = ${event.id}`
    } catch {
      await sql`
        UPDATE notification_events
        SET status = 'failed', retry_count = retry_count + 1, processed_at = NOW()
        WHERE id = ${event.id}
      `
    }
  }
}
