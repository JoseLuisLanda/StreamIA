import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="landing-page">
      <div class="bg-glow glow-1"></div>
      <div class="bg-glow glow-2"></div>

      <header class="navbar">
        <a routerLink="/" class="brand">Avatar Studio</a>

        <nav class="nav-actions">
          <a *ngIf="!authService.user()" routerLink="/login" [queryParams]="{ mode: 'register' }" class="nav-btn nav-btn-ghost">Registro</a>
          <a *ngIf="!authService.user()" routerLink="/login" class="nav-btn nav-btn-solid">Login</a>

          <span *ngIf="authService.user() as user" class="user-pill">{{ user.email }}</span>
          <button *ngIf="authService.user()" type="button" class="nav-btn nav-btn-ghost" (click)="logout()">Cerrar sesión</button>
        </nav>
      </header>

      <main class="hero">
        <p class="tag">Real-time Face Tracking</p>
        <h1>Landing inspirada en Genesis para tu flujo de stream con avatar</h1>
        <p class="subtitle">Crea tu personaje, sincronízalo con tu cámara y produce experiencias Live/AR con almacenamiento persistente en Firebase.</p>

        <div class="hero-cta">
          <a routerLink="/live" class="cta-btn cta-primary">Ir a Live Studio</a>
          <a routerLink="/ar-face-tracking" class="cta-btn cta-secondary">AR con Face Tracking</a>
          <a routerLink="/ar" class="cta-btn cta-tertiary">Preview de Modelos 3D</a>
        </div>

        <section class="feature-grid">
          <article class="feature-card">
            <h3>Avatar Pipeline</h3>
            <p>Carga modelos GLB, guárdalos en Firebase Storage y reutilízalos por usuario.</p>
          </article>
          <article class="feature-card">
            <h3>Auth Integrado</h3>
            <p>Acceso con correo/contraseña y Google para proteger tus escenas y assets.</p>
          </article>
          <article class="feature-card">
            <h3>Escenas Persistentes</h3>
            <p>Mantén colecciones, backgrounds y configuración de avatar entre sesiones.</p>
          </article>
        </section>
      </main>

      <div class="footer-note">
        <span *ngIf="authService.user(); else guestState">Sesión activa</span>
        <ng-template #guestState>Ingresa con Login o Registro para usar Live</ng-template>
      </div>
    </div>
  `,
  styles: [`
    .landing-page {
      width: 100vw;
      height: 100vh;
      background: radial-gradient(circle at 20% 20%, #1d2340 0%, #0b1020 45%, #06090f 100%);
      color: #f8fafc;
      font-family: 'Inter', sans-serif;
      overflow: hidden;
      position: relative;
      padding: 1rem 1.2rem 1.2rem;
    }
    .bg-glow {
      position: absolute;
      border-radius: 999px;
      filter: blur(80px);
      opacity: 0.35;
      pointer-events: none;
      z-index: 0;
    }
    .glow-1 {
      width: 340px;
      height: 340px;
      background: #5c24ff;
      top: -60px;
      left: -80px;
    }
    .glow-2 {
      width: 420px;
      height: 420px;
      background: #ff3bff;
      bottom: -120px;
      right: -120px;
    }
    .navbar {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.6rem 0.9rem;
      border: 1px solid #23293d;
      border-radius: 12px;
      background: rgba(11, 15, 25, 0.7);
      backdrop-filter: blur(10px);
    }
    .brand {
      color: #fff;
      text-decoration: none;
      font-weight: 700;
      letter-spacing: 0.3px;
      font-size: 1rem;
    }
    .nav-actions {
      display: flex;
      gap: 0.55rem;
      align-items: center;
    }
    .nav-btn {
      text-decoration: none;
      padding: 0.5rem 0.85rem;
      border-radius: 8px;
      font-size: 0.82rem;
      font-weight: 600;
      color: #fff;
      border: 1px solid transparent;
      background: transparent;
      cursor: pointer;
    }
    .nav-btn-ghost {
      border-color: #3a435f;
      background: rgba(35, 41, 61, 0.6);
    }
    .nav-btn-solid {
      background: linear-gradient(135deg, #5c24ff, #a855f7);
    }
    .user-pill {
      font-size: 0.78rem;
      color: #94a3b8;
      background: rgba(15, 20, 33, 0.8);
      border: 1px solid #2d3550;
      border-radius: 999px;
      padding: 0.38rem 0.7rem;
    }
    .hero {
      position: relative;
      z-index: 1;
      max-width: 1060px;
      margin: 2.2rem auto 0;
      text-align: center;
    }
    .tag {
      display: inline-block;
      margin: 0;
      padding: 0.35rem 0.7rem;
      border-radius: 999px;
      border: 1px solid #2c3451;
      background: rgba(16, 22, 36, 0.75);
      color: #cbd5e1;
      font-size: 0.74rem;
      text-transform: uppercase;
      letter-spacing: 0.9px;
      font-weight: 600;
    }
    h1 {
      margin: 1rem auto 0;
      max-width: 860px;
      font-size: clamp(2rem, 5vw, 3.2rem);
      line-height: 1.1;
      letter-spacing: -0.6px;
      background: linear-gradient(180deg, #f8fafc, #aab7d7);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      margin: 1rem auto 0;
      max-width: 760px;
      color: #9fb0cf;
      font-size: 1.03rem;
      line-height: 1.65;
    }
    .hero-cta {
      margin-top: 1.35rem;
      display: flex;
      gap: 0.75rem;
      justify-content: center;
      flex-wrap: wrap;
    }
    .cta-btn {
      text-decoration: none;
      border-radius: 10px;
      padding: 0.8rem 1.1rem;
      font-size: 0.92rem;
      font-weight: 600;
      border: 1px solid transparent;
    }
    .cta-primary {
      color: #fff;
      background: linear-gradient(135deg, #7c3aed, #4f46e5);
    }
    .cta-secondary {
      color: #e2e8f0;
      border-color: #35415f;
      background: rgba(14, 19, 31, 0.7);
    }
    .cta-tertiary {
      color: #e2e8f0;
      border-color: #415f35;
      background: rgba(19, 31, 14, 0.7);
    }
    .feature-grid {
      margin: 2rem auto 0;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.75rem;
      max-width: 980px;
    }
    .feature-card {
      border-radius: 12px;
      border: 1px solid #2b3551;
      background: rgba(12, 17, 28, 0.7);
      padding: 0.9rem;
      text-align: left;
    }
    .feature-card h3 {
      margin: 0;
      font-size: 0.95rem;
      color: #f8fafc;
    }
    .feature-card p {
      margin: 0.5rem 0 0;
      font-size: 0.86rem;
      line-height: 1.55;
      color: #9fb0cf;
    }
    .footer-note {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0.9rem;
      text-align: center;
      color: #7f91b5;
      font-size: 0.78rem;
      z-index: 1;
    }
    @media (max-width: 900px) {
      .feature-grid {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 620px) {
      .landing-page {
        padding: 0.8rem;
      }
      .navbar {
        flex-direction: column;
        align-items: flex-start;
        gap: 0.6rem;
      }
      .nav-actions {
        width: 100%;
        flex-wrap: wrap;
      }
    }
  `]
})
export class HomeComponent {
  readonly authService = inject(AuthService);
  private router = inject(Router);

  async logout() {
    await this.authService.logout();
    await this.router.navigate(['/']);
  }
}
