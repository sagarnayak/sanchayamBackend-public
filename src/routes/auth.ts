import { FastifyInstance } from 'fastify'
import sql from '../db'
import { env } from '../config/env'
import {
  hashPassword,
  verifyPassword,
  hashToken,
  generateSecureToken,
  generateOtp,
  generateProfileCode,
  signAccessToken,
  signResetToken,
  verifyResetToken,
} from '../services/auth'
import { sendOtpEmail } from '../services/email'
import { authenticate, invalidateForceLogoutCache } from '../middleware/auth'
import {
  SetupSchema,
  SignupSchema,
  LoginSchema,
  ForgotPasswordSchema,
  VerifyOtpSchema,
  ResetPasswordSchema,
} from '../schemas'

const REFRESH_EXPIRY_DAYS = 30
const INVITE_EXPIRY_HOURS = 48
const OTP_EXPIRY_MINUTES = 15
const COOKIE_NAME = 'sanchayam_refresh'

function refreshCookieOpts(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    expires: expiresAt,
  }
}

async function issueSession(userId: string, isMasterAdmin: boolean, reply: import('fastify').FastifyReply) {
  const rawRefresh = generateSecureToken()
  const tokenHash = hashToken(rawRefresh)
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRY_DAYS * 86400 * 1000)

  await sql`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${tokenHash}, ${expiresAt})
  `

  const accessToken = signAccessToken(userId, isMasterAdmin)
  reply.setCookie(COOKIE_NAME, rawRefresh, refreshCookieOpts(expiresAt))
  return { access_token: accessToken }
}

async function forceLogoutUser(userId: string) {
  await sql`
    INSERT INTO force_logout (user_id, logged_out_at)
    VALUES (${userId}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET logged_out_at = NOW()
  `
  invalidateForceLogoutCache(userId)
}

export async function authRoutes(app: FastifyInstance) {
  // ----------------------------------------------------------------
  // GET /auth/setup-status
  // ----------------------------------------------------------------
  app.get('/auth/setup-status', async () => {
    const result = await sql`SELECT 1 FROM users WHERE is_master_admin = true LIMIT 1`
    return { setup_complete: result.length > 0 }
  })

  // ----------------------------------------------------------------
  // POST /auth/setup - create master admin (first launch only)
  // ----------------------------------------------------------------
  app.post(
    '/auth/setup',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const existing = await sql`SELECT 1 FROM users WHERE is_master_admin = true LIMIT 1`
      if (existing.length > 0) {
        return reply.code(409).send({ error: 'Setup already complete' })
      }

      const parsed = SetupSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
      }
      const { name, email, password } = parsed.data

      const passwordHash = await hashPassword(password)
      const profileCode = generateProfileCode()

      const [user] = await sql`
        INSERT INTO users (profile_code, email, name, password_hash, is_master_admin)
        VALUES (${profileCode}, ${email.toLowerCase()}, ${name}, ${passwordHash}, true)
        RETURNING id, is_master_admin
      `

      return issueSession(user.id, user.is_master_admin, reply)
    }
  )

  // ----------------------------------------------------------------
  // GET /auth/invite/:token - validate invite token
  // ----------------------------------------------------------------
  app.get<{ Params: { token: string } }>('/auth/invite/:token', async (request, reply) => {
    const tokenHash = hashToken(request.params.token)
    const [invite] = await sql`
      SELECT label, email, expires_at, used_at
      FROM invitations
      WHERE token_hash = ${tokenHash}
    `

    if (!invite) return reply.code(404).send({ error: 'Invite not found or already used' })
    if (invite.used_at) return reply.code(410).send({ error: 'Invite already used' })
    if (new Date(invite.expires_at) < new Date()) return reply.code(410).send({ error: 'Invite expired' })

    return { label: invite.label, email: invite.email }
  })

  // ----------------------------------------------------------------
  // POST /auth/signup - complete signup via invite token
  // ----------------------------------------------------------------
  app.post(
    '/auth/signup',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = SignupSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
      }
      const { token, name, email, password, base_currency } = parsed.data

      const tokenHash = hashToken(token)
      const [invite] = await sql`
        SELECT id, expires_at, used_at FROM invitations WHERE token_hash = ${tokenHash}
      `

      if (!invite) return reply.code(404).send({ error: 'Invalid invite' })
      if (invite.used_at) return reply.code(410).send({ error: 'Invite already used' })
      if (new Date(invite.expires_at) < new Date()) return reply.code(410).send({ error: 'Invite expired' })

      const existing = await sql`SELECT 1 FROM users WHERE email = ${email.toLowerCase()} LIMIT 1`
      if (existing.length > 0) return reply.code(409).send({ error: 'Email already registered' })

      const passwordHash = await hashPassword(password)
      const profileCode = generateProfileCode()

      const [user] = await sql`
        INSERT INTO users (profile_code, email, name, password_hash, base_currency)
        VALUES (${profileCode}, ${email.toLowerCase()}, ${name}, ${passwordHash}, ${base_currency})
        RETURNING id, is_master_admin
      `

      await sql`UPDATE invitations SET used_at = NOW() WHERE id = ${invite.id}`

      return issueSession(user.id, user.is_master_admin, reply)
    }
  )

  // ----------------------------------------------------------------
  // POST /auth/login
  // ----------------------------------------------------------------
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = LoginSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
      }
      const { email, password } = parsed.data

      const [user] = await sql`
        SELECT id, password_hash, is_master_admin, is_suspended, is_deleted
        FROM users
        WHERE email = ${email.toLowerCase()}
      `

      if (!user) {
        // dummy bcrypt to prevent timing-based email enumeration
        await verifyPassword(password, '$2b$12$invalidhashpadding000000000000000000000000000000000000000')
        return reply.code(401).send({ error: 'Invalid credentials' })
      }
      if (user.is_deleted) return reply.code(401).send({ error: 'Account not found' })
      if (user.is_suspended) return reply.code(403).send({ error: 'Account suspended' })

      const valid = await verifyPassword(password, user.password_hash)
      if (!valid) return reply.code(401).send({ error: 'Invalid credentials' })

      return issueSession(user.id, user.is_master_admin, reply)
    }
  )

  // ----------------------------------------------------------------
  // POST /auth/refresh
  // ----------------------------------------------------------------
  app.post('/auth/refresh', async (request, reply) => {
    const rawRefresh = request.cookies[COOKIE_NAME]
    if (!rawRefresh) return reply.code(401).send({ error: 'No refresh token' })

    const tokenHash = hashToken(rawRefresh)

    // reuse detection: if this token was already rotated, force logout
    const reused = await sql`SELECT 1 FROM used_refresh_tokens WHERE token_hash = ${tokenHash}`
    if (reused.length > 0) {
      // find the user this token belonged to and force-logout
      const [session] = await sql`
        SELECT user_id FROM sessions WHERE token_hash = ${tokenHash}
      `
      if (session) await forceLogoutUser(session.user_id)
      reply.clearCookie(COOKIE_NAME, { path: '/' })
      return reply.code(401).send({ error: 'Token reuse detected' })
    }

    const [session] = await sql`
      SELECT s.id, s.user_id, s.expires_at, u.is_master_admin, u.is_suspended, u.is_deleted
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${tokenHash}
    `

    if (!session) return reply.code(401).send({ error: 'Invalid refresh token' })
    if (new Date(session.expires_at) < new Date()) return reply.code(401).send({ error: 'Refresh token expired' })
    if (session.is_deleted || session.is_suspended) return reply.code(403).send({ error: 'Account unavailable' })

    // mark old token as used, delete old session, issue new
    // ON CONFLICT handles the race where two requests arrive with the same token simultaneously
    try {
      await sql`INSERT INTO used_refresh_tokens (token_hash) VALUES (${tokenHash})`
    } catch (err: any) {
      if (err.code === '23505') {
        // duplicate key - another concurrent request already rotated this token
        reply.clearCookie(COOKIE_NAME, { path: '/' })
        return reply.code(401).send({ error: 'Token already rotated' })
      }
      throw err
    }
    await sql`DELETE FROM sessions WHERE id = ${session.id}`

    return issueSession(session.user_id, session.is_master_admin, reply)
  })

  // ----------------------------------------------------------------
  // POST /auth/logout
  // ----------------------------------------------------------------
  app.post('/auth/logout', { preHandler: authenticate }, async (request, reply) => {
    const rawRefresh = request.cookies[COOKIE_NAME]
    if (rawRefresh) {
      const tokenHash = hashToken(rawRefresh)
      await sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`
    }
    reply.clearCookie(COOKIE_NAME, { path: '/' })
    return { ok: true }
  })

  // ----------------------------------------------------------------
  // GET /auth/me
  // ----------------------------------------------------------------
  app.get('/auth/me', { preHandler: authenticate }, async (request, reply) => {
    const [user] = await sql`
      SELECT id, profile_code, email, name, base_currency, is_master_admin, created_at
      FROM users
      WHERE id = ${request.user.id} AND is_deleted = false
    `
    if (!user) return reply.code(404).send({ error: 'User not found' })
    return user
  })

  // ----------------------------------------------------------------
  // POST /auth/forgot-password
  // ----------------------------------------------------------------
  app.post('/auth/forgot-password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = ForgotPasswordSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
    }
    const { email } = parsed.data

    const normalizedEmail = email.toLowerCase()
    const ip = request.ip

    // check lockout
    const [lockout] = await sql`
      SELECT locked_until FROM forgot_password_lockouts
      WHERE email = ${normalizedEmail} AND locked_until > NOW()
    `
    if (lockout) {
      return reply.code(429).send({ error: 'Too many attempts. Try again later.' })
    }

    // log this attempt
    await sql`INSERT INTO forgot_password_log (email, ip) VALUES (${normalizedEmail}, ${ip})`

    // count attempts in last 30 minutes
    const [{ count }] = await sql<[{ count: string }]>`
      SELECT COUNT(*) AS count FROM forgot_password_log
      WHERE email = ${normalizedEmail} AND attempted_at > NOW() - INTERVAL '30 minutes'
    `
    if (parseInt(count) >= 3) {
      await sql`
        INSERT INTO forgot_password_lockouts (email, locked_until)
        VALUES (${normalizedEmail}, NOW() + INTERVAL '24 hours')
        ON CONFLICT (email) DO UPDATE SET locked_until = NOW() + INTERVAL '24 hours', created_at = NOW()
      `
      return reply.code(429).send({ error: 'Too many attempts. Try again in 24 hours.' })
    }

    const [user] = await sql`
      SELECT id, name FROM users WHERE email = ${normalizedEmail} AND is_deleted = false
    `

    // always return 200 to avoid email enumeration
    if (!user) return { ok: true }

    const otp = generateOtp()
    const otpHash = hashToken(otp)
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000)

    // invalidate any existing OTP
    await sql`UPDATE password_reset_otps SET used_at = NOW() WHERE user_id = ${user.id} AND used_at IS NULL`
    await sql`
      INSERT INTO password_reset_otps (user_id, otp_hash, expires_at)
      VALUES (${user.id}, ${otpHash}, ${expiresAt})
    `

    await sendOtpEmail(normalizedEmail, user.name, otp)
    return { ok: true }
  })

  // ----------------------------------------------------------------
  // POST /auth/verify-otp
  // ----------------------------------------------------------------
  app.post('/auth/verify-otp', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = VerifyOtpSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
    }
    const { email, otp } = parsed.data

    const normalizedEmail = email.toLowerCase()
    const ip = request.ip

    // check lockout (shared with forgot-password lockouts)
    const [lockout] = await sql`
      SELECT locked_until FROM forgot_password_lockouts
      WHERE email = ${normalizedEmail} AND locked_until > NOW()
    `
    if (lockout) {
      return reply.code(429).send({ error: 'Too many attempts. Try again later.' })
    }

    const [user] = await sql`
      SELECT id FROM users WHERE email = ${normalizedEmail} AND is_deleted = false
    `
    if (!user) return reply.code(400).send({ error: 'Invalid request' })

    const otpHash = hashToken(otp)
    const [record] = await sql`
      SELECT id, expires_at, used_at FROM password_reset_otps
      WHERE user_id = ${user.id} AND otp_hash = ${otpHash}
      ORDER BY created_at DESC
      LIMIT 1
    `

    if (!record || record.used_at || new Date(record.expires_at) < new Date()) {
      // wrong OTP - log and check attempt count
      await sql`INSERT INTO otp_verify_log (email, ip) VALUES (${normalizedEmail}, ${ip})`

      const [{ count }] = await sql<[{ count: string }]>`
        SELECT COUNT(*) AS count FROM otp_verify_log
        WHERE email = ${normalizedEmail} AND attempted_at > NOW() - INTERVAL '30 minutes'
      `
      if (parseInt(count) >= 4) {
        await sql`
          INSERT INTO forgot_password_lockouts (email, locked_until)
          VALUES (${normalizedEmail}, NOW() + INTERVAL '24 hours')
          ON CONFLICT (email) DO UPDATE SET locked_until = NOW() + INTERVAL '24 hours', created_at = NOW()
        `
        return reply.code(429).send({ error: 'Too many wrong attempts. Try again in 24 hours.' })
      }

      if (!record || record.used_at) return reply.code(400).send({ error: 'Invalid OTP' })
      return reply.code(400).send({ error: 'OTP expired' })
    }

    await sql`UPDATE password_reset_otps SET used_at = NOW() WHERE id = ${record.id}`

    const resetToken = signResetToken(user.id)
    return { reset_token: resetToken }
  })

  // ----------------------------------------------------------------
  // POST /auth/reset-password
  // ----------------------------------------------------------------
  app.post('/auth/reset-password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = ResetPasswordSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
    }
    const { reset_token, password } = parsed.data

    let payload: { sub: string; purpose: string }
    try {
      payload = verifyResetToken(reset_token)
    } catch {
      return reply.code(400).send({ error: 'Invalid or expired reset token' })
    }

    if (payload.purpose !== 'password_reset') {
      return reply.code(400).send({ error: 'Invalid token' })
    }

    const passwordHash = await hashPassword(password)
    await sql`
      UPDATE users SET password_hash = ${passwordHash}, updated_at = NOW()
      WHERE id = ${payload.sub}
    `

    // force logout all existing sessions
    await forceLogoutUser(payload.sub)
    await sql`DELETE FROM sessions WHERE user_id = ${payload.sub}`

    return { ok: true }
  })
}
