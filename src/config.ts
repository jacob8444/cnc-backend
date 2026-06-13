import fs from 'fs'
import path from 'path'

// Load .env manually — no dotenv dependency
const envPath = path.resolve(process.cwd(), '.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const [k, ...v] = line.split('=')
    if (k && !k.startsWith('#') && v.length) process.env[k.trim()] = v.join('=').trim()
  }
}

export const config = {
  serialPort:        process.env.SERIAL_PORT   ?? '/dev/ttyUSB0',
  serialBaud:        parseInt(process.env.SERIAL_BAUD  ?? '115200'),
  port:              parseInt(process.env.PORT         ?? '8080'),  // single port for HTTP + WS
  filesDir:          path.resolve(process.env.FILES_DIR ?? './files'),
  uiDir:             path.resolve(process.env.UI_DIR   ?? './public'), // built frontend
  authToken:         process.env.AUTH_TOKEN,           // undefined = no auth
  logLevel:          process.env.LOG_LEVEL    ?? 'info',
  pollIntervalRun:   200,  // ms — while cutting
  pollIntervalIdle:  500,  // ms — while idle
  reconnectDelay:    3000 as number, // ms
}
