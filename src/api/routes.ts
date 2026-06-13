import express, { type Request, type Response, type NextFunction } from 'express'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import type { MachineStateStore } from '../state/MachineStateStore'
import type { SerialManager } from '../serial/SerialManager'
import { logger } from '../logger'
import { config } from '../config'

const ALLOWED_EXT = new Set(['.nc', '.gcode', '.g', '.tap'])

function safeJoin(base: string, name: string): string {
  const resolved = path.resolve(base, path.basename(name))
  if (!resolved.startsWith(path.resolve(base) + path.sep)) throw new Error('Path traversal')
  return resolved
}

export function createApiServer(
  filesDir: string,
  uiDir: string,
  _serial: SerialManager,
  store: MachineStateStore,
) {
  const app = express()
  app.use(express.json())

  // CORS — allow the frontend origin
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    next()
  })
  app.options('*', (_req, res) => res.sendStatus(204))

  // Auth middleware (skipped when no token configured)
  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (!config.authToken) return next()
    const token = req.headers['x-auth-token'] ?? req.query.token
    if (token === config.authToken) return next()
    res.status(401).json({ error: 'Unauthorized' })
  }

  // Multer — store uploads directly to files/
  const storage = multer.diskStorage({
    destination: filesDir,
    filename: (_req, file, cb) => {
      const safe = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_')
      cb(null, safe)
    },
  })
  const upload = multer({
    storage,
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase()
      cb(null, ALLOWED_EXT.has(ext))
    },
    limits: { fileSize: 50 * 1024 * 1024 },  // 50 MB
  })

  // ── Routes ───────────────────────────────────────────────────────────────

  app.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()) })
  })

  app.get('/api/status', auth, (_req, res) => {
    res.json(store.state)
  })

  app.get('/api/files', auth, (_req, res) => {
    const files = fs.existsSync(filesDir)
      ? fs.readdirSync(filesDir)
          .filter(f => ALLOWED_EXT.has(path.extname(f).toLowerCase()))
          .map(f => {
            const stat = fs.statSync(path.join(filesDir, f))
            return { name: f, size: stat.size, modified: stat.mtime.toISOString() }
          })
      : []
    res.json(files)
  })

  app.post('/api/files', auth, upload.single('file'), (req, res) => {
    if (!req.file) return void res.status(400).json({ error: 'No valid file uploaded' })
    logger.info({ filename: req.file.filename, size: req.file.size }, 'File uploaded')
    res.json({ name: req.file.filename, size: req.file.size })
  })

  app.get('/api/files/:name', auth, (req, res) => {
    try {
      const filepath = safeJoin(filesDir, req.params.name ?? '')
      if (!fs.existsSync(filepath)) return void res.status(404).json({ error: 'Not found' })
      res.download(filepath)
    } catch {
      res.status(400).json({ error: 'Invalid filename' })
    }
  })

  app.delete('/api/files/:name', auth, (req, res) => {
    try {
      const filepath = safeJoin(filesDir, req.params.name ?? '')
      if (!fs.existsSync(filepath)) return void res.status(404).json({ error: 'Not found' })
      fs.unlinkSync(filepath)
      logger.info({ filename: req.params.name }, 'File deleted')
      res.json({ ok: true })
    } catch {
      res.status(400).json({ error: 'Invalid filename' })
    }
  })

  // Serve uploaded G-code files (direct download links)
  app.use('/files', auth, express.static(filesDir))

  // Serve built frontend — must come after API routes so /api/* still matches
  if (fs.existsSync(uiDir)) {
    app.use(express.static(uiDir))
    // SPA fallback: any unmatched GET returns index.html (handles browser refresh)
    app.get('*', (_req, res) => res.sendFile(path.join(uiDir, 'index.html')))
  }

  return app
}
