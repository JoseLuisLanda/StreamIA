import { ApplicationConfig, provideAppInitializer, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { initWebViewSso } from './services/webview-sso';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideBrowserGlobalErrorListeners(),
    // Embedded (Flutter WebView) SSO: if a custom token is present in the URL
    // fragment, sign in BEFORE the router/authGuard run. No-op in normal web use.
    provideAppInitializer(() => initWebViewSso()),
    provideRouter(routes)
  ]
};
