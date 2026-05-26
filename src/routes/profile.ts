import { FastifyInstance } from 'fastify'
import sql from '../db'
import { hashPassword, verifyPassword } from '../services/auth'
import { authenticate } from '../middleware/auth'
import { invalidateBaseCurrencyCache } from './assets'
import { UpdateProfileSchema, ChangePasswordSchema } from '../schemas'

async function forceLogoutOtherSessions(userId: string, currentTokenHash: string) {
  await sql`DELETE FROM sessions WHERE user_id = ${userId} AND token_hash != ${currentTokenHash}`
}

export async function profileRoutes(app: FastifyInstance) {
  // all profile routes require auth
  app.addHook('preHandler', authenticate)

  // ----------------------------------------------------------------
  // PATCH /profile
  // ----------------------------------------------------------------
  app.patch('/profile', async (request, reply) => {
    const parsed = UpdateProfileSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
    }
    const { name, base_currency } = parsed.data

    if (!name && !base_currency) {
      return reply.code(400).send({ error: 'Nothing to update' })
    }

    if (base_currency) {
      const [currency] = await sql`SELECT 1 FROM currencies WHERE code = ${base_currency} AND is_active = true`
      if (!currency) return reply.code(400).send({ error: 'Invalid currency code' })
    }

    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (name) updates.name = name
    if (base_currency) updates.base_currency = base_currency

    const [user] = await sql`
      UPDATE users
      SET
        name = COALESCE(${name ?? null}, name),
        base_currency = COALESCE(${base_currency ?? null}, base_currency),
        updated_at = NOW()
      WHERE id = ${request.user.id}
      RETURNING id, profile_code, email, name, base_currency, created_at, updated_at
    `

    if (base_currency) invalidateBaseCurrencyCache(request.user.id)
    return user
  })

  // ----------------------------------------------------------------
  // PATCH /profile/password
  // ----------------------------------------------------------------
  app.patch(
    '/profile/password',
    async (request, reply) => {
      const parsed = ChangePasswordSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
      }
      const { current_password, new_password } = parsed.data

      const [user] = await sql`SELECT password_hash FROM users WHERE id = ${request.user.id}`
      const valid = await verifyPassword(current_password, user.password_hash)
      if (!valid) return reply.code(400).send({ error: 'Current password is incorrect' })

      const passwordHash = await hashPassword(new_password)
      await sql`UPDATE users SET password_hash = ${passwordHash}, updated_at = NOW() WHERE id = ${request.user.id}`

      // invalidate all other sessions; keep the current one active
      const rawRefresh = request.cookies['sanchayam_refresh']
      if (rawRefresh) {
        const { hashToken } = await import('../services/auth')
        const currentHash = hashToken(rawRefresh)
        await forceLogoutOtherSessions(request.user.id, currentHash)
      }

      return { ok: true }
    }
  )

  // ----------------------------------------------------------------
  // GET /profile/sessions
  // ----------------------------------------------------------------
  app.get('/profile/sessions', async (request) => {
    const sessions = await sql`
      SELECT id, created_at, last_seen_at, expires_at
      FROM sessions
      WHERE user_id = ${request.user.id}
      ORDER BY last_seen_at DESC
    `
    return sessions
  })

  // ----------------------------------------------------------------
  // DELETE /profile/sessions/:id
  // ----------------------------------------------------------------
  app.delete<{ Params: { id: string } }>('/profile/sessions/:id', async (request, reply) => {
    const result = await sql`
      DELETE FROM sessions
      WHERE id = ${request.params.id} AND user_id = ${request.user.id}
      RETURNING id
    `
    if (result.length === 0) return reply.code(404).send({ error: 'Session not found' })
    return { ok: true }
  })
}
