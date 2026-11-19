import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { setupTheme } from './theme.js'
import { ensureKatex } from '../services/markdown/katex.js'
import { stopSessionActivity } from '../services/sessionActivity.js'
import './theme.css'
import './global.css'

let root: ReturnType<typeof createRoot> | undefined

export const startApp = () => {
  ensureKatex()
  setupTheme()
  root = createRoot(document.getElementById('root') as HTMLElement)
  root.render(<App />)
}

export const stopAppSession = () => {
  stopSessionActivity(true)
  root?.unmount()
}
