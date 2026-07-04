import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppNavbarComponent } from './components/app-navbar/app-navbar.component';

/**
 * Root shell (THIS is the bootstrapped component -- see main.ts; the sibling
 * app.component.ts is legacy/dead code). The GLOBAL smart navbar mounts once
 * here and is available on every route; presentation mode per route comes from
 * route data `nav` ('fixed' | 'overlay' | 'hidden') -- see app-navbar.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, AppNavbarComponent],
  template: `
    <app-navbar></app-navbar>
    <router-outlet></router-outlet>
  `,
  styles: []
})
export class App {
  // Shell component
}
