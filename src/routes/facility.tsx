// In-app "How to find us" quick page — the 6 condensed facility-access photos +
// a link down to the full facility instructions (/access). Reached from the
// header quick-link (logged-in customers). Mobile-first: single column at phone
// width so it fits the screen with no horizontal scroll; 2-up on wider screens.
// Photos are the shared annotated shots served from /public/access/.
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/facility')({
  component: FacilityAccess,
})

const PHOTOS: Array<{ src: string; cap: string }> = [
  { src: '/access/s1-ann.jpg', cap: '1. Turn in off Jones Street' },
  { src: '/access/s2-ann.jpg', cap: '2. Through the car park to the rear' },
  { src: '/access/s6-ann.jpg', cap: '3. Aerial view of the route' },
  { src: '/access/s3-ann.jpg', cap: '4. Down the laneway to the entrance' },
  { src: '/access/s5-ann.jpg', cap: '5. Keypad on the brick pillar' },
  { src: '/access/s4-ann.jpg', cap: '6. Use the silver keypad — not the intercom' },
]

function FacilityAccess() {
  return (
    <div className="w-full max-w-2xl mx-auto px-4 py-6">
      <header className="mb-4">
        <h1 className="text-2xl font-bold text-gray-900">How to find us</h1>
        <p className="text-sm text-gray-500 mt-1">
          78 Jones Street, Stirling — directions, parking &amp; getting in.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {PHOTOS.map((p) => (
          <figure key={p.src} className="m-0 min-w-0">
            <img
              src={p.src}
              alt={p.cap}
              loading="lazy"
              className="block w-full h-auto rounded-xl border border-gray-200"
            />
            <figcaption className="text-xs text-gray-600 mt-1.5 leading-snug">{p.cap}</figcaption>
          </figure>
        ))}
      </div>

      <a
        href="/access"
        className="mt-6 flex items-center justify-center gap-2 w-full px-4 py-3 bg-emerald-500 hover:bg-emerald-600 active:scale-95 text-white font-semibold rounded-xl shadow-md transition-all"
      >
        Full facility instructions &amp; house rules →
      </a>
      <p className="text-center text-xs text-gray-400 mt-3">
        Can&rsquo;t get in? Call Julian 0451&nbsp;016&nbsp;151 (any hour).
      </p>
    </div>
  )
}
