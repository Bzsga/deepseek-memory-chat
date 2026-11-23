/** Older WebView can still use native structured cloning through MessagePort. */
export async function cloneSnapshot<T>(value: T): Promise<T> {
  if (typeof globalThis.structuredClone === 'function') return structuredClone(value)

  const { port1, port2 } = new MessageChannel()
  try {
    return await new Promise<T>((resolve, reject) => {
      port1.onmessage = event => resolve(event.data as T)
      port1.onmessageerror = () => reject(new DOMException('Unable to clone snapshot', 'DataCloneError'))
      port2.postMessage(value)
    })
  } finally {
    port1.close()
    port2.close()
  }
}
