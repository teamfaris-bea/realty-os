// The shell's own registry entry (it uses the same mechanism as every surface).
import { AccountPage, HomeFallbackPage, MorePage } from './ShellPages.js';
import type { PageDef, SurfaceModule } from './types.js';

export const shellSurface: SurfaceModule = {
  pages: [
    {
      path: '/account',
      title: 'Account',
      roles: 'all',
      nav: { phone: 'more', desktop: 'sidebar', section: 'account', icon: 'person', order: 10_000 },
      component: AccountPage,
    },
    // the phone More tab itself (rendered by the tab bar, not listed in nav)
    { path: '/more', title: 'More', roles: 'all', component: MorePage },
  ],
};

/** '/' until a surface (the Priority Feed) registers it. */
export const homeFallback: PageDef = {
  path: '/',
  title: 'Home',
  roles: 'all',
  nav: { phone: 'tab', desktop: 'sidebar', icon: 'home', order: 0 },
  component: HomeFallbackPage,
};
