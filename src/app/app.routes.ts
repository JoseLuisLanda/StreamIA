import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { LiveComponent } from './pages/live/live.component';
import { ArPageComponent } from './pages/ar/ar.component';
import { ArViewer } from './pages/ar-viewer/ar-viewer';
import { ArFaceTrackingComponent } from './pages/ar-face-tracking/ar-face-tracking.component';
import { LoginComponent } from './pages/login/login.component';
import { authGuard } from './guards/auth.guard';
import { adminGuard } from './guards/admin.guard';

export const routes: Routes = [
    { path: '', component: HomeComponent },
    {
        path: 'assistants',
        canActivate: [authGuard],
        loadComponent: () => import('./pages/assistants/assistants.component').then(m => m.AssistantsComponent)
    },
    { path: 'home', component: HomeComponent },
    { path: 'login', component: LoginComponent },
    {
        path: 'profile',
        canActivate: [authGuard],
        loadComponent: () => import('./pages/profile/profile.component').then(m => m.ProfileComponent)
    },
    { path: 'live', component: LiveComponent, canActivate: [authGuard] },
    { path: 'ar', component: ArPageComponent, canActivate: [authGuard] },
    { path: 'ar-viewer', component: ArViewer, canActivate: [authGuard] },
    { path: 'ar-face-tracking', component: ArFaceTrackingComponent, canActivate: [authGuard] },
    {
        path: 'text-avatar',
        canActivate: [authGuard],
        loadComponent: () => import('./pages/text-avatar/text-avatar.component').then(m => m.TextAvatarComponent)
    },
    {
        path: 'gesture-studio',
        loadComponent: () => import('./pages/gesture-studio/gesture-studio.component').then(m => m.GestureStudioComponent)
    },
    {
        // AR content manager (feature /ar-assistant, FASE 0). authGuard ONLY:
        // gestores are plain authenticated users (they see just their own
        // elements); admin capabilities are resolved in-component.
        path: 'ar-content-manager',
        canActivate: [authGuard],
        loadComponent: () => import('./pages/ar-content-manager/ar-content-manager.component').then(m => m.ArContentManagerComponent)
    },
    {
        path: 'admin',
        canActivate: [adminGuard],
        loadComponent: () => import('./pages/admin-hub/admin-hub.component').then(m => m.AdminHubComponent)
    },
    {
        path: 'rag-admin',
        canActivate: [adminGuard],
        loadComponent: () => import('./pages/rag-admin/rag-admin.component').then(m => m.RagAdminComponent)
    },
    {
        path: 'avatar-manager',
        canActivate: [adminGuard],
        loadComponent: () => import('./pages/avatar-manager/avatar-manager.component').then(m => m.AvatarManagerComponent)
    },
    {
        path: 'assistant-manager',
        canActivate: [adminGuard],
        loadComponent: () => import('./pages/assistant-manager/assistant-manager.component').then(m => m.AssistantManagerComponent)
    },
    {
        path: 'llm-admin',
        canActivate: [adminGuard],
        loadComponent: () => import('./pages/llm-admin/llm-admin.component').then(m => m.LlmAdminComponent)
    },
    {
        path: 'role-admin',
        canActivate: [adminGuard],
        loadComponent: () => import('./pages/role-admin/role-admin.component').then(m => m.RoleAdminComponent)
    },
    {
        path: 'llm-responses',
        canActivate: [adminGuard],
        loadComponent: () => import('./pages/llm-responses/llm-responses.component').then(m => m.LlmResponsesComponent)
    },
    {
        path: 'costos',
        canActivate: [adminGuard],
        loadComponent: () => import('./pages/costos/costos.component').then(m => m.CostosComponent)
    },
    {
        path: 'cuotas',
        canActivate: [adminGuard],
        loadComponent: () => import('./pages/cuotas/cuotas.component').then(m => m.CuotasComponent)
    },
    { path: '**', redirectTo: '' }
];
