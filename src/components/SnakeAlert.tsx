import { useEffect, useState } from 'react'

interface SnakeAlertProps {
  onClose: () => void
}

const SNAKE_IMAGE = 'https://cdn.shipper.now/image/users/cmmlw0cwc002yjr04bh43ugwo/1778142515164-e3bfa4kq9ji-snake-alert.webp'

export default function SnakeAlert({ onClose }: SnakeAlertProps) {
  const [secondsLeft, setSecondsLeft] = useState(30)
  const [flashOn, setFlashOn] = useState(true)

  useEffect(() => {
    const flashInterval = setInterval(() => setFlashOn(f => !f), 400)
    const countdown = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) {
          clearInterval(countdown)
          clearInterval(flashInterval)
          onClose()
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => {
      clearInterval(flashInterval)
      clearInterval(countdown)
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[200] bg-black flex flex-col items-center justify-center p-4 overflow-hidden">
      <h1
        className={`text-6xl sm:text-8xl md:text-9xl font-black tracking-widest mb-6 transition-opacity duration-200 ${
          flashOn ? 'opacity-100 text-red-600' : 'opacity-20 text-red-900'
        }`}
        style={{ textShadow: '0 0 40px rgba(220,38,38,0.8)' }}
      >
        SNAKE ALERT
      </h1>
      <img
        src={SNAKE_IMAGE}
        alt="Snake"
        className={`w-[80vw] max-w-2xl h-auto rounded-lg transition-opacity duration-200 ${
          flashOn ? 'opacity-30' : 'opacity-100'
        }`}
      />
      <p className="mt-6 text-red-500 text-xl font-mono">{secondsLeft}s</p>
    </div>
  )
}
