import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config()

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be exactly 64 hex characters'),
  TWELVE_DATA_API_KEY: z.string().min(1, 'TWELVE_DATA_API_KEY is required'),
  SMTP_HOST: z.string().min(1, 'SMTP_HOST is required'),
  SMTP_USER: z.string().min(1, 'SMTP_USER is required'),
  SMTP_PASS: z.string().min(1, 'SMTP_PASS is required'),
  PORT: z.coerce.number().default(3100),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SMTP_PORT: z.coerce.number().default(2525),
  SMTP_FROM: z.string().default('noreply@sanchayam.com'),
  DEEPSEEK_API_KEY: z.string().optional(),
})

const result = schema.safeParse(process.env)

if (!result.success) {
  console.error('[startup] Missing or invalid environment variables:')
  for (const issue of result.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

export const env = result.data
