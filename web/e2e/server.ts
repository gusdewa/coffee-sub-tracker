import { createServer, type Server } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'

/**
 * A static server whose served build can be swapped while it runs.
 *
 * That swap *is* the deploy in these tests. Verifying the update lifecycle
 * needs an old tab to meet a newer build, and the honest way to produce that
 * locally is to serve build A, point the server at build B, and let the
 * service worker notice — exactly what a real deploy looks like from the
 * browser's side.
 *
 * Served over http://127.0.0.1, which counts as a secure context, so service
 * workers register the same way they do in production.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

/** Default for the GitHub Pages project site; pass another to serve a root build. */
export const BASE_PATH = '/coffee-sub-tracker/'

export interface SwappableServer {
  url: string
  /** Point the server at a different build — this is the "deploy". */
  serve: (root: string) => void
  close: () => Promise<void>
}

export async function startServer(
  initialRoot: string,
  port = 0,
  basePath: string = BASE_PATH,
): Promise<SwappableServer> {
  let root = initialRoot

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let pathname = decodeURIComponent(url.pathname)

    if (!pathname.startsWith(basePath)) {
      res.writeHead(404).end('outside base')
      return
    }
    pathname = pathname.slice(basePath.length) || 'index.html'
    // Refuse traversal outright rather than resolving it.
    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
    const file = join(root, safe)

    try {
      const info = await stat(file)
      if (!info.isFile()) throw new Error('not a file')
      const body = await readFile(file)
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        // The worker must always be revalidated, as on a real host.
        'cache-control': safe === 'sw.js' ? 'no-cache' : 'no-store',
      })
      res.end(body)
    } catch {
      // No SPA fallback here: the service worker owns navigation, and adding a
      // server-side fallback would mask a broken navigateFallback.
      res.writeHead(404).end('not found')
    }
  })

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port

  return {
    url: `http://127.0.0.1:${boundPort}${basePath}`,
    serve: (next: string) => {
      root = next
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  }
}
