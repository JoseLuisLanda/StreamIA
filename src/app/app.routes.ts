import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { LiveComponent } from './pages/live/live.component';
import { ArPageComponent } from './pages/ar/ar.component';

export const routes: Routes = [
    { path: '', component: HomeComponent },
    { path: 'live', component: LiveComponent },
    { path: 'ar', component: ArPageComponent },
    { path: '**', redirectTo: '' }
];
