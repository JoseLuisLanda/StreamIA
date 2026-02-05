import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="home-container">
      <div class="content">
        <h1>Face Tracking Avatar</h1>
        <p>Control a 3D avatar with your facial expressions using MediaPipe.</p>
        
        <div class="button-group">
          <a routerLink="/live" class="start-btn vr-btn">
            VR Experience (Avatar)
          </a>
          <a routerLink="/ar" class="start-btn ar-btn">
            AR Experience (Mask)
          </a>
        </div>
      </div>
      
      <div class="background-globes">
         <!-- Ornamental visual -->
      </div>
    </div>
  `,
  styles: [`
    .home-container {
      width: 100vw;
      height: 100vh;
      background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-family: 'Inter', sans-serif;
      overflow: hidden;
    }
    .content {
      z-index: 10;
      text-align: center;
    }
    h1 {
      font-size: 3rem;
      margin-bottom: 1rem;
      background: -webkit-linear-gradient(#eee, #333);
      -webkit-background-clip: text;
      text-shadow: 0 0 20px rgba(255,255,255,0.3);
    }
    p {
      font-size: 1.2rem;
      margin-bottom: 3rem;
      opacity: 0.8;
    }
    .start-btn {
      padding: 1rem 2.5rem;
      font-size: 1.2rem;
      display: inline-block;
      margin: 0.5rem;
    }
    .vr-btn {
      background: linear-gradient(90deg, #ff8a00, #e52e71);
      box-shadow: 0 10px 20px rgba(229, 46, 113, 0.3);
    }
    .ar-btn {
      background: linear-gradient(90deg, #00c6ff, #0072ff);
      box-shadow: 0 10px 20px rgba(0, 114, 255, 0.3);
    }
    .start-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 15px 30px rgba(229, 46, 113, 0.5);
    }
  `]
})
export class HomeComponent { }
