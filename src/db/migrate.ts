import fs from 'fs'
import path from 'path'
import postgres from 'postgres'
import { env } from '../config/env'

const sql = postgres(env.DATABASE_URL, { max: 1 })

async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR NOT NULL UNIQUE,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `

  const dir = path.join(__dirname, 'migrations')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()

  for (const file of files) {
    const applied = await sql`SELECT 1 FROM _migrations WHERE name = ${file}`
    if (applied.length > 0) {
      console.log(`[skip] ${file}`)
      continue
    }

    const content = fs.readFileSync(path.join(dir, file), 'utf8')
    await sql.unsafe(content)
    await sql`INSERT INTO _migrations (name) VALUES (${file})`
    console.log(`[done] ${file}`)
  }

  console.log('All migrations complete.')
  await sql.end()
}

migrate().catch(err => { console.error(err); process.exit(1) })
