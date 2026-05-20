import { Route as rootRouteImport } from './routes/__root'
import { Route as StatementsRouteImport } from './routes/statements'
import { Route as ProfileRouteImport } from './routes/profile'
import { Route as BookingsRouteImport } from './routes/bookings'
import { Route as AdminRouteImport } from './routes/admin'
import { Route as IndexRouteImport } from './routes/index'
import { Route as CheckoutSuccessRouteImport } from './routes/checkout/success'

declare module '@tanstack/react-router' {
  interface FileRoutesByPath {
    '/': {
      id: '/'
      path: '/'
      fullPath: '/'
      preLoaderRoute: typeof IndexRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/admin': {
      id: '/admin'
      path: '/admin'
      fullPath: '/admin'
      preLoaderRoute: typeof AdminRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/bookings': {
      id: '/bookings'
      path: '/bookings'
      fullPath: '/bookings'
      preLoaderRoute: typeof BookingsRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/profile': {
      id: '/profile'
      path: '/profile'
      fullPath: '/profile'
      preLoaderRoute: typeof ProfileRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/statements': {
      id: '/statements'
      path: '/statements'
      fullPath: '/statements'
      preLoaderRoute: typeof StatementsRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/checkout/success': {
      id: '/checkout/success'
      path: '/checkout/success'
      fullPath: '/checkout/success'
      preLoaderRoute: typeof CheckoutSuccessRouteImport
      parentRoute: typeof rootRouteImport
    }
  }
}
