import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

/**
 * Landing page (pro redesign). Showcases the two flagship experiences --
 * AVATAR CHAT (Text-Avatar: RAG + voz + lipsync) and AR AVATAR (viewer with
 * narrator avatar + anchored content + QR markers) -- plus the studio tools.
 * Navigation chrome (brand, categories, user, logout) lives in the GLOBAL
 * smart navbar (app-navbar, mounted in the root shell), not here.
 * ASCII-only source (repo rule).
 */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="landing">
      <div class="glow g1"></div>
      <div class="glow g2"></div>
      <div class="glow g3"></div>

      <!-- ============ HERO ============ -->
      <section class="hero">
        <p class="tag">Avatares IA + Realidad Aumentada, en tu navegador</p>
        <h1>Avatares que <span class="hl">hablan</span> con tu publico,<br />contenido que <span class="hl2">vive</span> en tu entorno</h1>
        <p class="subtitle">
          Una plataforma web: asistentes conversacionales con voz y lipsync en tiempo real,
          y experiencias de realidad aumentada ancladas al mundo real con marcadores y GPS.
        </p>
        <div class="heroCta">
          <a routerLink="/assistants" class="btn primary big">Probar Avatar Chat</a>
          <a routerLink="/ar-assistant" class="btn arx big">Abrir AR Avatar</a>
        </div>
      </section>

      <!-- ============ FLAGSHIP SECTIONS ============ -->
      <section class="flags">
        <article class="flag chat">
          <div class="fhead">
            <span class="fic">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v10H7l-3 3z M8 9h8 M8 12h5"/></svg>
            </span>
            <div>
              <h2>Avatar Chat</h2>
              <p class="fsub">Asistentes 3D que responden desde TU base de conocimiento</p>
            </div>
          </div>
          <ul class="feats">
            <li>Respuestas fundamentadas (RAG) por asistente, con resumen hablado y detalle bajo demanda</li>
            <li>Voz neuronal en el navegador (espanol primero) con lipsync ARKit y gestos</li>
            <li>Personalidad, avatar GLB, voz y contenido configurables sin tocar codigo</li>
          </ul>
          <div class="factions">
            <a routerLink="/assistants" class="btn primary">Elegir asistente</a>
            <a routerLink="/text-avatar" class="btn ghost">Ir directo al chat</a>
          </div>
        </article>

        <article class="flag ar">
          <div class="fhead">
            <span class="fic arfic">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-5.3-7-11a7 7 0 0 1 14 0c0 5.7-7 11-7 11z M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/></svg>
            </span>
            <div>
              <h2>AR Avatar</h2>
              <p class="fsub">Realidad aumentada narrada por tu asistente</p>
            </div>
          </div>
          <ul class="feats">
            <li>Imagenes, videos y modelos 3D animados anclados a coordenadas GPS o marcadores impresos</li>
            <li>Marcadores con QR integrado: escanear, iniciar sesion y ver el contenido sobre el impreso</li>
            <li>Mini-mapa de contenido cercano y avatar narrador con subtitulos en vivo</li>
          </ul>
          <div class="factions">
            <a routerLink="/ar-assistant" class="btn arx">Abrir visor RA</a>
            <a routerLink="/ar-content-manager" class="btn ghost">Publicar contenido</a>
          </div>
        </article>
      </section>

      <!-- ============ TOOLBELT ============ -->
      <section class="tools">
        <h3>Herramientas de estudio</h3>
        <div class="tgrid">
          <a routerLink="/live" class="tcard">
            <b>Live Studio</b>
            <p>Streaming con tu avatar sincronizado a camara.</p>
          </a>
          <a routerLink="/ar-face-tracking" class="tcard">
            <b>AR Face Tracking</b>
            <p>Tu rostro controla el avatar en tiempo real.</p>
          </a>
          <a routerLink="/ar" class="tcard">
            <b>Preview 3D</b>
            <p>Previsualiza y valida tus modelos GLB.</p>
          </a>
          <a routerLink="/gesture-studio" class="tcard">
            <b>Gesture Studio</b>
            <p>Autoria de gestos y expresiones del avatar.</p>
          </a>
        </div>
      </section>

      <footer class="foot">
        <span *ngIf="authService.user(); else guest">Sesion activa: {{ authService.user()?.email }}</span>
        <ng-template #guest><a routerLink="/login" class="btn ghost sm">Inicia sesion para comenzar</a></ng-template>
      </footer>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .landing { position: relative; min-height: calc(100vh - 52px); overflow: hidden;
      background: radial-gradient(circle at 18% 15%, #1d2340 0%, #0b1020 45%, #06090f 100%);
      color: #f8fafc; font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
      padding: 0 clamp(16px, 5vw, 64px) 48px; }
    .glow { position: absolute; border-radius: 999px; filter: blur(90px); pointer-events: none; }
    .g1 { width: 480px; height: 480px; background: rgba(139,92,246,.28); top: -140px; left: -120px; }
    .g2 { width: 420px; height: 420px; background: rgba(59,130,246,.16); bottom: -120px; right: -80px; }
    .g3 { width: 300px; height: 300px; background: rgba(182,232,74,.08); top: 40%; left: 60%; }

    .hero { position: relative; text-align: center; padding: clamp(40px, 8vh, 90px) 0 34px; max-width: 980px; margin: 0 auto; }
    .tag { display: inline-block; font-size: 11.5px; letter-spacing: 2px; text-transform: uppercase; color: #b9a3f5;
      border: 1px solid rgba(139,92,246,.4); background: rgba(139,92,246,.1); border-radius: 999px; padding: 7px 16px; margin: 0 0 22px; }
    h1 { margin: 0 0 18px; font-size: clamp(30px, 4.6vw, 54px); font-weight: 800; line-height: 1.12; letter-spacing: -0.5px; }
    .hl { background: linear-gradient(90deg, #a78bfa, #8b5cf6); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .hl2 { background: linear-gradient(90deg, #6ee7b7, #b6e84a); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .subtitle { margin: 0 auto; max-width: 640px; color: #aab3c5; font-size: clamp(14px, 1.4vw, 16.5px); line-height: 1.6; }
    .heroCta { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; margin-top: 30px; }

    .btn { display: inline-block; text-decoration: none; cursor: pointer; border-radius: 12px; font-size: 14px; font-weight: 600;
      padding: 12px 22px; border: 1px solid transparent; transition: transform .15s, filter .15s; }
    .btn:hover { transform: translateY(-2px); filter: brightness(1.12); }
    .btn.big { padding: 15px 30px; font-size: 15.5px; }
    .btn.sm { padding: 8px 16px; font-size: 12.5px; }
    .btn.primary { background: linear-gradient(135deg, #8b5cf6, #6d3ef0); color: #fff; box-shadow: 0 8px 26px rgba(139,92,246,.35); }
    .btn.arx { background: linear-gradient(135deg, #0ea5a0, #16a34a); color: #fff; box-shadow: 0 8px 26px rgba(22,163,74,.28); }
    .btn.ghost { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.16); color: #dde2ec; }

    .flags { position: relative; display: grid; grid-template-columns: 1fr 1fr; gap: 22px; max-width: 1120px; margin: 26px auto 0; }
    .flag { border-radius: 22px; padding: 28px; border: 1px solid rgba(255,255,255,.1);
      background: linear-gradient(160deg, rgba(255,255,255,.055), rgba(255,255,255,.015)); backdrop-filter: blur(10px);
      display: flex; flex-direction: column; gap: 18px; transition: border-color .2s, transform .2s; }
    .flag:hover { transform: translateY(-3px); }
    .flag.chat:hover { border-color: rgba(139,92,246,.55); }
    .flag.ar:hover { border-color: rgba(110,231,183,.5); }
    .fhead { display: flex; align-items: center; gap: 14px; }
    .fic { width: 52px; height: 52px; flex: none; display: grid; place-items: center; border-radius: 14px;
      background: rgba(139,92,246,.18); color: #c4b0f7; }
    .fic.arfic { background: rgba(110,231,183,.14); color: #6ee7b7; }
    .flag h2 { margin: 0; font-size: 22px; font-weight: 800; }
    .fsub { margin: 3px 0 0; color: #98a1b3; font-size: 13px; }
    .feats { margin: 0; padding: 0 0 0 2px; list-style: none; display: flex; flex-direction: column; gap: 10px; flex: 1; }
    .feats li { position: relative; padding-left: 24px; color: #c6cddb; font-size: 13.5px; line-height: 1.55; }
    .feats li::before { content: ''; position: absolute; left: 0; top: 7px; width: 8px; height: 8px; border-radius: 3px;
      background: linear-gradient(135deg, #8b5cf6, #6ee7b7); }
    .factions { display: flex; gap: 10px; flex-wrap: wrap; }

    .tools { position: relative; max-width: 1120px; margin: 40px auto 0; }
    .tools h3 { margin: 0 0 14px; font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: #8b93a3; }
    .tgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
    .tcard { display: flex; flex-direction: column; gap: 6px; padding: 18px; border-radius: 16px; text-decoration: none;
      background: rgba(255,255,255,.035); border: 1px solid rgba(255,255,255,.08); color: inherit; transition: border-color .2s, background .2s; }
    .tcard:hover { border-color: rgba(139,92,246,.45); background: rgba(139,92,246,.08); }
    .tcard b { font-size: 14.5px; }
    .tcard p { margin: 0; color: #98a1b3; font-size: 12.5px; line-height: 1.5; }

    .foot { position: relative; text-align: center; margin-top: 44px; color: #7e8798; font-size: 12.5px; }
    @media (max-width: 900px) { .flags { grid-template-columns: 1fr; } }
  `]
})
export class HomeComponent {
  authService = inject(AuthService);
}
