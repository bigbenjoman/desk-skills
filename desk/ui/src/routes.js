// The screens the frame can open, in the sidebar's order, each with its ⌘ shortcut (screen-spec §2.3, §13).
// A screen's sidebar item, shortcut and any button that opens it are drawn only once ROUTES holds it:
// each screen's story adds its `id: Component` there. A screen is given { path, go, snapshot, get }.
import { Inbox } from './inbox.jsx';
import { TicketPage } from './ticket.jsx';

export const SCREENS = [
  { id: 'inbox', path: '/inbox', label: 'Inbox', key: '1', icon: 'inbox' },
  { id: 'repos', path: '/repos', label: 'Repos', key: '2', icon: 'folder-git-2' },
  { id: 'workers', path: '/workers', label: 'Workers', key: '3' },
  { id: 'conversations', path: '/conversations', label: 'Conversations', key: '4' },
  { id: 'usage', path: '/usage', label: 'Usage & costs', key: '5' },
  { id: 'levers', path: '/levers', label: 'Levers', key: '6' },
  { id: 'health', path: '/health', label: 'Health', key: '7' },
  { id: 'decisions', path: '/decisions', label: 'Decisions', key: '8' },
  { id: 'settings', path: '/settings', label: 'Settings', key: ',' },
];

// The pages a link opens rather than the sidebar: a ticket's is /t/<repo>/<KEY>[/<tab>], titled by its key.
export const PAGES = [
  { id: 'ticket', path: '/t', label: 'Ticket', title: (path) => path.split('/')[3] ?? 'Ticket' },
];

// The ticket page is read when a screen draws, not as this module loads: it imports the frame, which
// imports this.
export const ROUTES = { inbox: Inbox, get ticket() { return TicketPage; } };

// The screen `path` opens, among those `routes` holds, or null.
export const screenAt = (path, routes) =>
  [...SCREENS, ...PAGES].find((s) => routes[s.id] && (path === s.path || path.startsWith(`${s.path}/`))) ?? null;

// Where a ticket's page is, for a repo named `repo` (the snapshot's repos[].name).
export const ticketPath = (repo, key) => `/t/${encodeURIComponent(repo)}/${encodeURIComponent(key)}`;
