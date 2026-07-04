import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * LEGACY / DEAD CODE: main.ts bootstraps `App` from ./app.ts, NOT this class.
 * Kept only because the sandbox cannot delete files -- safe to remove. The
 * global navbar is mounted in app.ts (the real root shell).
 */
@Component({
  selector: 'app-root-legacy',
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet></router-outlet>`,
  styles: []
})
export class AppComponent {
  title = 'rpm-face-tracking-angular';
}
