import { env } from './config/env'
import { logger } from './lib/logger'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import cookie from '@fastify/cookie'
import cron from 'node-cron'

import sql from './db'
import { authRoutes } from './routes/auth'
import { profileRoutes } from './routes/profile'
import { connectionRoutes } from './routes/connections'
import { adminRoutes } from './routes/admin'
import { adminFxRoutes } from './routes/admin-fx'
import { adminCollectorsRoutes } from './routes/admin-collectors'
import { adminNotificationsRoutes } from './routes/admin-notifications'
import { adminAssetsRoutes } from './routes/admin-assets'
import { adminPricesRoutes } from './routes/admin-prices'
import { holdingsRoutes } from './routes/holdings'
import { lotsRoutes } from './routes/lots'
import { holdingValuesRoutes } from './routes/holding-values'
import { assetsRoutes } from './routes/assets'
import { portfolioRoutes } from './routes/portfolio'
import { syncCollectors } from './services/collectors'
import { refreshStaleRates } from './services/fx'
import { retryFailedNotifications } from './services/notifications'
import { syncProviders, enqueueStalePrices, startPriceWorker } from './services/prices'
import { enqueueEligibleAssets } from './services/backfill/watcher'
import { startBackfillWorker } from './services/backfill/worker'
import { takeSnapshotsForAllUsers } from './services/snapshots'
import { runHistoricalSnapshotBackfill } from './services/snapshots/backfill'
import { runFamilySnapshotBackfill } from './services/snapshots/family'
import './types'

const app = Fastify({ logger: true, trustProxy: true })

async function start() {
  await app.register(cors, {
    origin: env.FRONTEND_URL,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 7200,
  })

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) => ({
      error: 'Too many requests. Please slow down.',
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  })

  await app.register(cookie)

  app.get('/health', async () => ({
    status: 'ok',
    service: 'sanchayam',
    timestamp: new Date().toISOString(),
  }))


  await app.register(authRoutes)
  await app.register(profileRoutes)
  await app.register(connectionRoutes)
  await app.register(adminRoutes)
  await app.register(adminFxRoutes)
  await app.register(adminCollectorsRoutes)
  await app.register(adminNotificationsRoutes)
  await app.register(adminAssetsRoutes)
  await app.register(adminPricesRoutes)
  await app.register(holdingsRoutes)
  await app.register(lotsRoutes)
  await app.register(holdingValuesRoutes)
  await app.register(assetsRoutes)
  await app.register(portfolioRoutes)

  await syncCollectors()
  await syncProviders()
  startPriceWorker()
  startBackfillWorker()

  // retry failed notifications every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    await retryFailedNotifications()
  })

  // every minute: enqueue stale prices (no data, or 24h+ stale and consumed within 48h)
  cron.schedule('* * * * *', async () => {
    await enqueueStalePrices()
  })

  // every minute: refresh stale FX rates (no data, or 24h+ stale and consumed within 48h)
  cron.schedule('* * * * *', async () => {
    await refreshStaleRates()
  })

  // every minute: backfill watcher - finds assets needing historical data, drops into queue
  cron.schedule('* * * * *', async () => {
    await enqueueEligibleAssets()
  })

  // Friday portfolio snapshot: 11:00 AM UTC = 4:30 PM IST, 30 min after Indian market close
  // Also triggers backfill watcher - the completed week is now eligible for price backfill
  cron.schedule('0 11 * * 5', async () => {
    logger.info('[snapshots] Friday cron: taking portfolio snapshots for all users')
    await takeSnapshotsForAllUsers('cron')
    await enqueueEligibleAssets()
  })

  // Saturday 1 AM UTC: historical snapshot backfill
  // Generates portfolio_snapshots (source='import') for all past Fridays where
  // eligible assets (splits done) have price data. Runs with 10 concurrent workers.
  // After individual backfill completes, regenerates family snapshots for all active families.
  cron.schedule('0 1 * * 6', async () => {
    logger.info('[snapshot-backfill] Saturday cron triggered')
    await runHistoricalSnapshotBackfill()

    // Regenerate family snapshots for every family with active members
    const families = await sql`
      SELECT DISTINCT family_id::text AS family_id
      FROM users
      WHERE family_id IS NOT NULL AND is_deleted = false
    `
    for (const f of families) {
      await runFamilySnapshotBackfill(f.family_id as string)
    }
  })

  // nightly purge at 2am
  cron.schedule('0 2 * * *', async () => {
    const cutoff60 = new Date(Date.now() - 60 * 86400 * 1000)
    const cutoff90 = new Date(Date.now() - 90 * 86400 * 1000)
    await sql`DELETE FROM used_refresh_tokens WHERE used_at < ${cutoff60}`
    await sql`DELETE FROM forgot_password_log WHERE attempted_at < ${cutoff90}`
    await sql`DELETE FROM otp_verify_log WHERE attempted_at < ${cutoff90}`
    await sql`DELETE FROM forgot_password_lockouts WHERE created_at < ${cutoff90}`
    await sql`DELETE FROM price_fetch_queue WHERE queued_at < ${cutoff90}`
    await sql`DELETE FROM collector_call_log WHERE called_at < ${cutoff90}`
    await sql`DELETE FROM notification_events WHERE created_at < ${cutoff90}`
    // price history: keep last 30 days in full + one row per asset per week beyond 30 days
    // the kept row is the latest price that week for that asset (any day, not necessarily Friday)
    // weeks with no data at all are naturally skipped
    await sql`
      DELETE FROM asset_price_history
      WHERE price_date < CURRENT_DATE - INTERVAL '30 days'
        AND id NOT IN (
          SELECT DISTINCT ON (asset_id, DATE_TRUNC('week', price_date))
            id
          FROM asset_price_history
          WHERE price_date < CURRENT_DATE - INTERVAL '30 days'
          ORDER BY asset_id, DATE_TRUNC('week', price_date), price_date DESC
        )
    `
    app.log.info('Nightly purge complete')
  })

  const port = env.PORT
  await app.listen({ port, host: '0.0.0.0' })
  logger.info(`Sanchayam backend running on http://0.0.0.0:${port}`)
}

start().catch(err => { logger.error(err, 'Fatal startup error'); process.exit(1) })
