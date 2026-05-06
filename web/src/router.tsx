import { useEffect } from 'react'
import {
    createRootRoute,
    createRoute,
    createRouter,
    redirect,
    useNavigate,
    Outlet
} from '@tanstack/react-router'
import { AUTH_REQUIRED_EVENT, getToken } from './auth/tokenStore'
import { LoginPage } from './routes/login'
import { SessionsPage } from './routes/sessions'
import { AttachHostPage, AttachPage } from './routes/attach'

const rootRoute = createRootRoute({
    component: RootShell
})

function RootShell() {
    const navigate = useNavigate()
    useEffect(() => {
        const onAuthRequired = () => {
            navigate({ to: '/login' })
        }
        window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
        return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
    }, [navigate])

    return (
        <div className="h-full">
            <Outlet />
        </div>
    )
}

const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: LoginPage
})

const sessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    beforeLoad: () => {
        if (!getToken()) {
            throw redirect({ to: '/login' })
        }
    },
    component: SessionsPage
})

const attachRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/attach/$name',
    beforeLoad: () => {
        if (!getToken()) {
            throw redirect({ to: '/login' })
        }
    },
    component: AttachPage
})

const attachHostRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/attach/$hostId/$name',
    beforeLoad: () => {
        if (!getToken()) {
            throw redirect({ to: '/login' })
        }
    },
    component: AttachHostPage
})

const routeTree = rootRoute.addChildren([loginRoute, sessionsRoute, attachRoute, attachHostRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router
    }
}
