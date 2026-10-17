import { StrictMode, Suspense, lazy, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createBrowserRouter, useRouteError } from 'react-router-dom'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import { ToastProvider } from './components/ui.js'
import { Landing } from './pages/Landing.js'
import { NotFound, PageLoading, PageError } from './pages/Fallbacks.js'

// Everything but the landing page is split; the console and PayPal checkout are the heavy parts.
const ConsolePage = lazy(() => import('./pages/console/ConsolePage.js'))
const FanPage = lazy(() => import('./pages/fan/FanPage.js'))
const OverlayPage = lazy(() => import('./pages/Overlay.js'))
const ReceiptPage = lazy(() => import('./pages/Receipt.js'))
const DemoPage = lazy(() => import('./pages/Demo.js'))
const StatusPage = lazy(() => import('./pages/Status.js'))

// ?theme=dark|light and ?scale=130 work on every page (overlays, recordings).
const params = new URLSearchParams(window.location.search)
const theme = params.get('theme')
if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme
const scale = params.get('scale')
if (scale === '130' || scale === '150') document.documentElement.dataset.scale = scale

function RouteError() {
  const err = useRouteError()
  return <PageError title="This page hit an error" detail={err instanceof Error ? err.message : 'Reload to try again.'} />
}

const wrap = (el: ReactNode) => <Suspense fallback={<PageLoading />}>{el}</Suspense>

const router = createBrowserRouter([
  { path: '/', element: <Landing />, errorElement: <RouteError /> },
  { path: '/c/:room', element: wrap(<ConsolePage />), errorElement: <RouteError /> },
  { path: '/f/:room', element: wrap(<FanPage />), errorElement: <RouteError /> },
  { path: '/o/:room', element: wrap(<OverlayPage />), errorElement: <RouteError /> },
  { path: '/r/:token', element: wrap(<ReceiptPage />), errorElement: <RouteError /> },
  { path: '/demo/:room', element: wrap(<DemoPage />), errorElement: <RouteError /> },
  { path: '/status', element: wrap(<StatusPage />), errorElement: <RouteError /> },
  { path: '*', element: <NotFound /> },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </StrictMode>,
)
