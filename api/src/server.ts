import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { ensureTablesExist } from './storage/tableClient.js'

const config = loadConfig()

async function main(): Promise<void> {
  await ensureTablesExist()
  const app = createApp({ config })
  app.listen(config.port, () => {
    console.log(`coffee-sub-tracker api listening on :${config.port}`)
  })
}

main().catch((err: unknown) => {
  console.error('failed to start', err)
  process.exit(1)
})
