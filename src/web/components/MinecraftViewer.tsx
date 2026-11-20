import { useEffect, useRef, useState } from 'react'

type Vector3Like = { x: number; y: number; z: number }
type ViewerBridge = {
  camera: { position: Vector3Like }
  controls: { target: Vector3Like; update: () => void } | null
}
type ViewerWindow = Window & { __MC_VIEWER_BRIDGE__?: ViewerBridge }

type Props = {
  src: string
  title: string
}

const movementKeys = new Set(['w', 'a', 's', 'd'])

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}

export function MinecraftViewer({ src, title }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const pressed = useRef(new Set<string>())
  const activeRef = useRef(false)
  const [frameLoad, setFrameLoad] = useState(0)
  const [bridgeReady, setBridgeReady] = useState(false)
  const [active, setActive] = useState(false)

  function activate(next: boolean) {
    activeRef.current = next
    setActive(next)
    if (!next) pressed.current.clear()
  }

  useEffect(() => {
    if (frameLoad === 0) return
    let attempts = 0
    setBridgeReady(false)
    const timer = window.setInterval(() => {
      attempts += 1
      const frameWindow = iframeRef.current?.contentWindow as ViewerWindow | null
      if (frameWindow?.__MC_VIEWER_BRIDGE__?.controls) {
        setBridgeReady(true)
        window.clearInterval(timer)
      } else if (attempts >= 120) {
        window.clearInterval(timer)
      }
    }, 100)
    return () => window.clearInterval(timer)
  }, [frameLoad])

  useEffect(() => {
    const frameWindow = iframeRef.current?.contentWindow
    const keyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (!activeRef.current || !movementKeys.has(key) || isTypingTarget(event.target)) return
      pressed.current.add(key)
      event.preventDefault()
    }
    const keyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (!movementKeys.has(key)) return
      pressed.current.delete(key)
      if (activeRef.current) event.preventDefault()
    }
    const clear = () => pressed.current.clear()
    const framePointerDown = () => activate(true)

    window.addEventListener('keydown', keyDown)
    window.addEventListener('keyup', keyUp)
    window.addEventListener('blur', clear)
    frameWindow?.addEventListener('keydown', keyDown)
    frameWindow?.addEventListener('keyup', keyUp)
    frameWindow?.addEventListener('blur', clear)
    frameWindow?.document.addEventListener('pointerdown', framePointerDown)
    return () => {
      window.removeEventListener('keydown', keyDown)
      window.removeEventListener('keyup', keyUp)
      window.removeEventListener('blur', clear)
      frameWindow?.removeEventListener('keydown', keyDown)
      frameWindow?.removeEventListener('keyup', keyUp)
      frameWindow?.removeEventListener('blur', clear)
      frameWindow?.document.removeEventListener('pointerdown', framePointerDown)
    }
  }, [frameLoad])

  useEffect(() => {
    let animationFrame = 0
    let previous = performance.now()
    const animate = (timestamp: number) => {
      const deltaSeconds = Math.min((timestamp - previous) / 1_000, 0.05)
      previous = timestamp
      const bridge = (iframeRef.current?.contentWindow as ViewerWindow | null)?.__MC_VIEWER_BRIDGE__
      const controls = bridge?.controls
      const camera = bridge?.camera

      if (activeRef.current && controls && camera && pressed.current.size > 0) {
        const forwardX = controls.target.x - camera.position.x
        const forwardZ = controls.target.z - camera.position.z
        const magnitude = Math.hypot(forwardX, forwardZ) || 1
        const fx = forwardX / magnitude
        const fz = forwardZ / magnitude
        const rx = -fz
        const rz = fx
        const forward = (pressed.current.has('w') ? 1 : 0) - (pressed.current.has('s') ? 1 : 0)
        const strafe = (pressed.current.has('d') ? 1 : 0) - (pressed.current.has('a') ? 1 : 0)
        const inputMagnitude = Math.hypot(forward, strafe) || 1
        const distance = 8 * deltaSeconds
        const dx = (fx * forward + rx * strafe) / inputMagnitude * distance
        const dz = (fz * forward + rz * strafe) / inputMagnitude * distance

        camera.position.x += dx
        camera.position.z += dz
        controls.target.x += dx
        controls.target.z += dz
        controls.update()
      }
      animationFrame = requestAnimationFrame(animate)
    }
    animationFrame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(animationFrame)
  }, [])

  return (
    <div
      className={`minecraft-viewer-wrap ${active ? 'controls-active' : ''}`}
      onMouseEnter={() => activate(true)}
      onMouseLeave={() => activate(false)}
    >
      <iframe ref={iframeRef} src={src} title={title} onLoad={() => setFrameLoad((value) => value + 1)} />
      <div className="viewer-controls-hint">
        <span className={`viewer-control-status ${bridgeReady ? 'ready' : ''}`}><i />{bridgeReady ? (active ? 'CAMERA ACTIVE' : 'CAMERA READY') : 'CONNECTING CAMERA'}</span>
        <div className="wasd-keys"><kbd>W</kbd><span><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span></div>
        <small>悬停画面后平移 · 左键旋转 · 滚轮缩放</small>
        <small className="viewer-redstone-legend"><i />红色元件是红石火把 / 红石线，并非报错高亮</small>
      </div>
    </div>
  )
}
