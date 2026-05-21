import { Toaster as Sonner } from 'sonner'

export function Toaster(props: React.ComponentProps<typeof Sonner>) {
  return (
    <Sonner
      richColors
      closeButton
      {...props}
    />
  )
}
