import { createRouter, createWebHistory } from 'vue-router'

const EmptyRouteView = {
  render: () => null,
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: EmptyRouteView,
    },
    {
      path: '/thread/:threadId',
      name: 'thread',
      component: EmptyRouteView,
    },
    {
      path: '/apps',
      redirect: '/apps/codex',
    },
    {
      path: '/apps/codex',
      redirect: { name: 'home' },
    },
    {
      path: '/apps/pi',
      name: 'app-pi',
      component: EmptyRouteView,
    },
    {
      path: '/new-thread',
      redirect: { name: 'home' },
    },
    { path: '/:pathMatch(.*)*', redirect: { name: 'home' } },
  ],
})

export default router
