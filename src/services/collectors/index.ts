import crypto from 'crypto'
import sql from '../../db'
import { DataCollector } from './types'
import { TwelveDataCollector } from './twelve-data'
import { env } from '../../config/env'

const registry = new Map<string, DataCollector>()

function encryptKey(text: string, keyHex: string): { enc: string; iv: string } {
  const key = Buffer.from(keyHex, 'hex')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    enc: Buffer.concat([encrypted, tag]).toString('hex'),
    iv: iv.toString('hex'),
  }
}

function decryptKey(encHex: string, ivHex: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex')
  const iv = Buffer.from(ivHex, 'hex')
  const data = Buffer.from(encHex, 'hex')
  const tag = data.slice(data.length - 16)
  const encrypted = data.slice(0, data.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8')
}

async function loadCollectors(): Promise<void> {
  const encKey = env.ENCRYPTION_KEY
  const rows = await sql`
    SELECT name, api_key_enc, api_key_iv, base_url FROM data_collectors WHERE is_active = true
  `

  registry.clear()
  for (const row of rows) {
    if (!row.api_key_enc) continue
    const apiKey = decryptKey(row.api_key_enc, row.api_key_iv, encKey)
    if (row.name === 'twelve-data') {
      registry.set(row.name, new TwelveDataCollector(apiKey, row.base_url ?? undefined))
    }
  }
}

export async function syncCollectors(): Promise<void> {
  const encKey = env.ENCRYPTION_KEY
  const tdApiKey = env.TWELVE_DATA_API_KEY
  const { enc, iv } = encryptKey(tdApiKey, encKey)

  await sql`
    UPDATE data_collectors SET api_key_enc = ${enc}, api_key_iv = ${iv}
    WHERE name = 'twelve-data'
  `

  await loadCollectors()
}

export function getCollector(name: string): DataCollector {
  const c = registry.get(name)
  if (!c) throw new Error(`Collector ${name} not loaded`)
  return c
}
