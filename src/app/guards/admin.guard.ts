import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { AdminService } from '../services/admin.service';
import { environment } from '../../environments/environment';

/**
 * Route guard for admin surfaces (e.g. /rag-admin).
 *
 * Always requires an authenticated user (redirect to /login when signed out).
 * The ADMIN-ROLE requirement is gated by environment.enforceAdminRole (mirrors
 * the Functions ENFORCE_ADMIN_ROLE flag):
 *   - false (dev): any signed-in user may enter.
 *   - true (prod): admin authorization (claim / admins allowlist) required;
 *     non-admins are sent home.
 * AdminService is kept and still used when the flag is on -- not stripped.
 * Server-side rules/Functions are the real boundary.
 */
export const adminGuard: CanActivateFn = async (_, state) => {
  const auth = inject(AuthService);
  const admin = inject(AdminService);
  const router = inject(Router);

  await auth.waitUntilReady();

  if (!auth.isAuthenticated) {
    return router.createUrlTree(['/login'], { queryParams: { redirect: state.url } });
  }

  // Dev phase: signed-in is enough.
  if (!environment.enforceAdminRole) return true;

  // Production: enforce admin role.
  const ok = await admin.check();
  if (ok) return true;

  return router.createUrlTree(['/']);
};
