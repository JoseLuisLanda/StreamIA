import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { LiveComponent } from './pages/live/live.component';
import { ArPageComponent } from './pages/ar/ar.component';
import { LoginComponent } from './pages/login/login.component';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
    { path: '', component: HomeComponent },
    { path: 'login', component: LoginComponent },
    { path: 'live', component: LiveComponent, canActivate: [authGuard] },
    { path: 'ar', component: ArPageComponent, canActivate: [authGuard] },
    { path: '**', redirectTo: '' }
];
