import { FastifyInstance } from 'fastify'
import sql from '../db'
import { requireAdmin, invalidateForceLogoutCache } from '../middleware/auth'
import { generateSecureToken, hashToken } from '../services/auth'
import { sendInviteEmail } from '../services/email'
import { CreateInvitationSchema } from '../schemas'

const INVITE_EXPIRY_HOURS = 48

async function forceLogoutUser(userId: string) {
  await sql`
    INSERT INTO force_logout (user_id, logged_out_at)
    VALUES (${userId}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET logged_out_at = NOW()
  `
  invalidateForceLogoutCache(userId)
}

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // ----------------------------------------------------------------
  // GET /admin/users
  // ----------------------------------------------------------------
  app.get('/admin/users', async () => {
    return sql`
      SELECT id, profile_code, email, name, base_currency, is_suspended, is_deleted, created_at, updated_at
      FROM users
      WHERE is_master_admin = false
      ORDER BY created_at DESC
    `
  })

  // ----------------------------------------------------------------
  // PATCH /admin/users/:id/suspend
  // ----------------------------------------------------------------
  app.patch<{ Params: { id: string } }>('/admin/users/:id/suspend', async (request, reply) => {
    const [user] = await sql`
      SELECT id, is_master_admin FROM users WHERE id = ${request.params.id} AND is_deleted = false
    `
    if (!user) return reply.code(404).send({ error: 'User not found' })
    if (user.is_master_admin) return reply.code(400).send({ error: 'Cannot suspend master admin' })

    await sql`UPDATE users SET is_suspended = true, updated_at = NOW() WHERE id = ${request.params.id}`
    await forceLogoutUser(request.params.id)

    return { ok: true }
  })

  // ----------------------------------------------------------------
  // PATCH /admin/users/:id/activate
  // ----------------------------------------------------------------
  app.patch<{ Params: { id: string } }>('/admin/users/:id/activate', async (request, reply) => {
    const [user] = await sql`
      SELECT id FROM users WHERE id = ${request.params.id} AND is_deleted = false
    `
    if (!user) return reply.code(404).send({ error: 'User not found' })

    await sql`UPDATE users SET is_suspended = false, updated_at = NOW() WHERE id = ${request.params.id}`
    return { ok: true }
  })

  // ----------------------------------------------------------------
  // PATCH /admin/users/:id/delete
  // ----------------------------------------------------------------
  app.patch<{ Params: { id: string } }>('/admin/users/:id/delete', async (request, reply) => {
    const [user] = await sql`
      SELECT id, is_master_admin FROM users WHERE id = ${request.params.id} AND is_deleted = false
    `
    if (!user) return reply.code(404).send({ error: 'User not found' })
    if (user.is_master_admin) return reply.code(400).send({ error: 'Cannot delete master admin' })

    await sql`
      UPDATE users SET is_deleted = true, deleted_at = NOW(), updated_at = NOW()
      WHERE id = ${request.params.id}
    `
    await forceLogoutUser(request.params.id)

    return { ok: true }
  })

  // ----------------------------------------------------------------
  // GET /admin/invitations
  // ----------------------------------------------------------------
  app.get('/admin/invitations', async () => {
    return sql`
      SELECT id, label, email, expires_at, used_at, created_at
      FROM invitations
      ORDER BY created_at DESC
    `
  })

  // ----------------------------------------------------------------
  // POST /admin/invitations
  // ----------------------------------------------------------------
  app.post(
    '/admin/invitations',
    async (request, reply) => {
      const parsed = CreateInvitationSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
      }
      const { label, email, send_email } = parsed.data

      const rawToken = generateSecureToken()
      const tokenHash = hashToken(rawToken)
      const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 3600 * 1000)

      await sql`
        INSERT INTO invitations (token_hash, label, email, expires_at, created_by)
        VALUES (${tokenHash}, ${label ?? null}, ${email ?? null}, ${expiresAt}, ${request.user.id})
      `

      if (send_email && email) {
        await sendInviteEmail(email, rawToken, label)
      }

      return {
        token: rawToken,
        label: label ?? null,
        email: email ?? null,
        expires_at: expiresAt,
      }
    }
  )

  // ----------------------------------------------------------------
  // DELETE /admin/invitations/:id
  // ----------------------------------------------------------------
  app.delete<{ Params: { id: string } }>('/admin/invitations/:id', async (request, reply) => {
    const [invite] = await sql`SELECT id, used_at FROM invitations WHERE id = ${request.params.id}`
    if (!invite) return reply.code(404).send({ error: 'Invite not found' })
    if (invite.used_at) return reply.code(400).send({ error: 'Cannot revoke a used invite' })

    await sql`DELETE FROM invitations WHERE id = ${request.params.id}`
    return { ok: true }
  })
}
