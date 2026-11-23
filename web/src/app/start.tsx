import { Component, useLayoutEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { setupTheme } from './theme.js'
import { ensureKatex } from '../services/markdown/katex.js'
import { stopSessionActivity } from '../services/sessionActivity.js'
import './theme.css'
import './global.css'

let root: ReturnType<typeof createRoot> | undefined

class RenderBoundary extends Component<{ children: ReactNode; onFailure: () => void }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch() {
    this.props.onFailure()
  }

  override render() {
    return this.state.failed ? null : this.props.children
  }
}

function Startup({ onReady }: { onReady: () => void }) {
  useLayoutEffect(onReady, [onReady])
  return <App />
}

export const startApp = (onReady: () => void, onRenderFailure: () => void) => {
  ensureKatex()
  setupTheme()
  root = createRoot(document.getElementById('root') as HTMLElement)
  root.render(
    <RenderBoundary onFailure={onRenderFailure}>
      <Startup onReady={onReady} />
    </RenderBoundary>
  )
}

export const stopAppSession = () => {
  stopSessionActivity(true)
  root?.unmount()
}
