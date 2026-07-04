/**
 * Global navigation registry -- SINGLE SOURCE OF TRUTH for the smart navbar.
 * Data-driven (same philosophy as ADMIN_MODULES): adding a section = one entry
 * here. The navbar filters items by identity (public / auth / admin) using
 * AuthService + AdminService signals.
 *
 * The Administracion category is BUILT from ADMIN_MODULES (admin-hub) so the
 * two surfaces never drift apart.
 */
import { ADMIN_MODULES } from '../../pages/admin-hub/admin-hub.component';

export type NavRequires = 'public' | 'auth' | 'admin';

export interface NavItem {
  label: string;
  route: string;
  /** inline SVG path data (24x24 viewBox, stroked), same style as ADMIN_MODULES. */
  icon: string;
  description?: string;
  requires: NavRequires;
}

export interface NavCategory {
  id: string;
  label: string;
  items: NavItem[];
}

const IC = {
  chat: 'M4 5h16v10H7l-3 3z M8 9h8 M8 12h5',
  ar: 'M12 21s-7-5.3-7-11a7 7 0 0 1 14 0c0 5.7-7 11-7 11z M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  live: 'M23 7l-7 5 7 5V7z M14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z',
  face: 'M12 8a4 4 0 1 0 0-0.01 M4 20c0-4 3.6-6 8-6s8 2 8 6',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z M12 12l8-4.5 M12 12v9 M12 12L4 7.5',
  eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z M12 12a3 3 0 1 0 0-0.01',
  users: 'M16 11a4 4 0 1 0 0-0.01 M8 14c-3 0-5 1.6-5 4 M14 19l2 2 4-4',
  wand: 'M15 4V2 M15 16v-2 M8 9h2 M20 9h2 M17.8 11.8L19 13 M17.8 6.2L19 5 M12.2 6.2L11 5 M12 21l3-9 6 6-9 3z',
  user: 'M12 8a4 4 0 1 0 0-0.01 M4 20c0-4 3.6-6 8-6s8 2 8 6',
};

/** Public/gestor categories. Administracion is appended from ADMIN_MODULES. */
export const NAV_CATEGORIES: NavCategory[] = [
  {
    id: 'experiencias',
    label: 'Experiencias',
    items: [
      { label: 'Text-Avatar', route: '/text-avatar', icon: IC.chat, description: 'Asistente conversacional con avatar', requires: 'auth' },
      { label: 'Visor RA', route: '/ar-assistant', icon: IC.ar, description: 'Realidad aumentada con avatar narrador', requires: 'auth' },
      { label: 'Live Studio', route: '/live', icon: IC.live, description: 'Streaming con avatar', requires: 'auth' },
      { label: 'AR Face Tracking', route: '/ar-face-tracking', icon: IC.face, description: 'Avatar controlado por tu rostro', requires: 'auth' },
      { label: 'AR Viewer', route: '/ar-viewer', icon: IC.eye, description: 'Visor AR de modelos', requires: 'auth' },
      { label: 'Preview 3D', route: '/ar', icon: IC.cube, description: 'Previsualiza modelos GLB', requires: 'auth' },
    ],
  },
  {
    id: 'contenido',
    label: 'Contenido',
    items: [
      { label: 'Asistentes', route: '/assistants', icon: IC.users, description: 'Selector de asistentes', requires: 'auth' },
      { label: 'Mi contenido RA', route: '/ar-content-manager', icon: IC.ar, description: 'Publica elementos de realidad aumentada', requires: 'auth' },
      { label: 'Gesture Studio', route: '/gesture-studio', icon: IC.wand, description: 'Autoria de gestos del avatar', requires: 'public' },
    ],
  },
  {
    id: 'cuenta',
    label: 'Mi cuenta',
    items: [
      { label: 'Perfil y cuota', route: '/profile', icon: IC.user, description: 'Tu saldo de consultas', requires: 'auth' },
    ],
  },
];

/** Admin category derived from the Admin Hub registry (no duplication). */
export function buildAdminCategory(): NavCategory {
  return {
    id: 'admin',
    label: 'Administracion',
    items: [
      { label: 'Admin Hub', route: '/admin', icon: IC.cube, description: 'Panel central de administracion', requires: 'admin' },
      ...ADMIN_MODULES.map((m) => ({
        label: m.title,
        route: m.route,
        icon: m.icon,
        description: m.description,
        requires: 'admin' as NavRequires,
      })),
    ],
  };
}
