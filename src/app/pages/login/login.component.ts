import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <div class="login-page">
      <div class="login-card">
        <h1>Iniciar sesión</h1>
        <p>Accede con correo o Google para usar Live y guardar avatares.</p>

        <form (ngSubmit)="submitEmailAuth()" class="login-form">
          <input
            type="email"
            name="email"
            [(ngModel)]="email"
            placeholder="Correo"
            required
            class="field"
          />
          <input
            type="password"
            name="password"
            [(ngModel)]="password"
            placeholder="Contraseña"
            required
            class="field"
          />

          <button type="submit" class="primary-btn" [disabled]="isLoading()">
            {{ isRegisterMode() ? 'Crear cuenta' : 'Entrar con correo' }}
          </button>
        </form>

        <button type="button" class="google-btn" (click)="loginWithGoogle()" [disabled]="isLoading()">
          Continuar con Google
        </button>

        <button type="button" class="link-btn" (click)="toggleMode()">
          {{ isRegisterMode() ? 'Ya tengo cuenta' : 'Crear cuenta nueva' }}
        </button>

        <p class="error" *ngIf="errorMessage()">{{ errorMessage() }}</p>
        <p class="error" *ngIf="authService.initError()">{{ authService.initError() }}</p>
        <a routerLink="/" class="home-link">← Volver al inicio</a>
      </div>
    </div>
  `,
  styles: [`
    .login-page {
      width: 100vw;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
      color: #fff;
      font-family: 'Inter', sans-serif;
    }
    .login-card {
      width: min(420px, 92vw);
      background: #151926;
      border: 1px solid #23293d;
      border-radius: 12px;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    h1 {
      margin: 0;
      font-size: 1.4rem;
    }
    p {
      margin: 0;
      color: #94a3b8;
      font-size: 0.9rem;
    }
    .login-form {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }
    .field {
      width: 100%;
      padding: 10px;
      border-radius: 6px;
      background: #0b0f19;
      color: #fff;
      border: 1px solid #23293d;
      font-size: 0.9rem;
      outline: none;
    }
    .field:focus {
      border-color: #a855f7;
    }
    .primary-btn,
    .google-btn {
      border: none;
      border-radius: 6px;
      cursor: pointer;
      padding: 10px;
      font-weight: 600;
      font-size: 0.9rem;
      color: #fff;
    }
    .primary-btn {
      background: linear-gradient(135deg, #ff3bff, #5c24ff);
    }
    .google-btn {
      background: #23293d;
    }
    .primary-btn:disabled,
    .google-btn:disabled {
      opacity: 0.7;
      cursor: not-allowed;
    }
    .link-btn {
      border: none;
      background: transparent;
      color: #a855f7;
      cursor: pointer;
      text-align: left;
      padding: 0;
      font-size: 0.85rem;
    }
    .error {
      color: #f87171;
      font-size: 0.85rem;
    }
    .home-link {
      color: #cbd5e1;
      text-decoration: none;
      font-size: 0.85rem;
    }
  `]
})
export class LoginComponent implements OnInit {
  readonly authService = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  email = '';
  password = '';
  isRegisterMode = signal(false);
  isLoading = signal(false);
  errorMessage = signal('');

  ngOnInit() {
    const mode = this.route.snapshot.queryParamMap.get('mode');
    this.isRegisterMode.set(mode === 'register');
  }

  async submitEmailAuth() {
    if (!this.email.trim() || !this.password.trim()) {
      return;
    }

    this.isLoading.set(true);
    this.errorMessage.set('');

    try {
      if (this.isRegisterMode()) {
        await this.authService.signUpWithEmail(this.email.trim(), this.password);
      } else {
        await this.authService.signInWithEmail(this.email.trim(), this.password);
      }
      await this.navigateAfterLogin();
    } catch (error) {
      this.errorMessage.set(this.getAuthError(error));
    } finally {
      this.isLoading.set(false);
    }
  }

  async loginWithGoogle() {
    this.isLoading.set(true);
    this.errorMessage.set('');

    try {
      await this.authService.signInWithGoogle();
      await this.navigateAfterLogin();
    } catch (error) {
      this.errorMessage.set(this.getAuthError(error));
    } finally {
      this.isLoading.set(false);
    }
  }

  toggleMode() {
    this.isRegisterMode.update(value => !value);
    this.errorMessage.set('');
  }

  private async navigateAfterLogin() {
    const redirect = this.route.snapshot.queryParamMap.get('redirect') || '/live';
    await this.router.navigateByUrl(redirect);
  }

  private getAuthError(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return 'No se pudo completar el inicio de sesión.';
  }
}
