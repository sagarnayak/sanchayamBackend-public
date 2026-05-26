import { FastifyInstance } from 'fastify'
import sql from '../db'
import { requireAdmin } from '../middleware/auth'
import { UpdateRoutingSchema } from '../schemas'

export async function adminNotificationsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // GET /admin/notifications/overview
  // Returns all channels with their routing entries and 7-day event stats
  app.get('/admin/notifications/overview', async () => {
    const channels = await sql`
      SELECT name, channel_type, recipient_type, recipient_ref, is_active
      FROM notification_channels
      ORDER BY name
    `

    const [adminUser] = await sql`
      SELECT email FROM users WHERE is_master_admin = true AND is_deleted = false LIMIT 1
    `

    const routing = await sql`
      SELECT
        r.notification_type,
        r.channel_name,
        r.is_active,
        MAX(e.created_at)                                                              AS last_triggered_at,
        COUNT(e.id) FILTER (WHERE e.created_at > NOW() - INTERVAL '7 days')::int      AS triggered_7d,
        COUNT(e.id) FILTER (WHERE e.created_at > NOW() - INTERVAL '7 days'
                              AND e.status = 'sent')::int                             AS sent_7d
      FROM notification_routing r
      LEFT JOIN notification_events e ON e.type = r.notification_type
      GROUP BY r.notification_type, r.channel_name, r.is_active
      ORDER BY r.channel_name, r.notification_type
    `

    type RoutingRow = typeof routing[number]
    const routingByChannel = new Map<string, RoutingRow[]>()
    for (const r of routing) {
      const key  = r.channel_name as string
      const list = routingByChannel.get(key) ?? ([] as RoutingRow[])
      list.push(r)
      routingByChannel.set(key, list)
    }

    return {
      channels: channels.map(c => {
        const recipientLabel =
          c.recipient_type === 'master_admin'
            ? (adminUser?.email ?? 'Master admin (not found)')
            : (c.recipient_ref ?? '(not configured)')

        return {
          ...c,
          recipient_label: recipientLabel,
          routing: routingByChannel.get(c.name as string) ?? [],
        }
      }),
    }
  })

  // PATCH /admin/notifications/routing/:type
  // Toggle a routing entry active/inactive - mutes or restores a notification type
  app.patch('/admin/notifications/routing/:type', async (req, reply) => {
    const { type }      = req.params as { type: string }
    const parsed = UpdateRoutingSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
    }
    const { is_active } = parsed.data

    const [updated] = await sql`
      UPDATE notification_routing
      SET is_active = ${is_active}
      WHERE notification_type = ${type}
      RETURNING notification_type, is_active
    `

    if (!updated) return reply.status(404).send({ error: 'Routing entry not found' })
    return updated
  })
}
