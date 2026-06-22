import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CostService, PricingConfig, ProjectionResult, StaleFlag } from '../../services/cost.service';
import { AssistantConfigService } from '../../services/assistant-config.service';
import { AssistantConfig } from '../../lib/rag/rag.models';

/**
 * Costos: the platform cost-model admin panel. APPROXIMATE ("aproximado").
 *
 * - Editable rate table (config/pricing) with staleness warnings per rate.
 * - Per-assistant real usage for the current month.
 * - Projection calculator with a live "consultas/mes" input. The dominant cost
 *   driver (the LLM model) is surfaced per stage and Pro tiers are flagged.
 *
 * All math is server-side (projectAssistantCost); the live monthly recompute on
 * the slider reuses the returned per-query unit cost (no extra round-trips).
 */
@Component({
  selector: 'app-costos',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <div class="wrap">
      <header class="head">
        <div>
          <h1>Costos <span class="approx">(aproximado)</span></h1>
          <p class="sub">Modelo de costos de la plataforma: ingesta, por consulta, almacenamiento e infraestructura.
             Todas las cifras son estimaciones, no facturas garantizadas.</p>
        </div>
        <a class="tlink" routerLink="/admin">&larr; Admin</a>
      </header>

      <p class="err" *ngIf="error()">{{ error() }}</p>

      <!-- ===================== RATE TABLE ===================== -->
      <section class="card">
        <h2>Tarifas (USD) <span class="muted" *ngIf="pricing()">staleAfterDays: {{ pricing()!.staleAfterDays }}</span></h2>
        <p class="note">Edita una tarifa y se guarda al instante; su fecha de actualizacion se renueva.
           Las tarifas marcadas estan vencidas: verifica que sigan vigentes.</p>

        <div *ngIf="pricing() as p" class="rates">
          <!-- Embedding -->
          <div class="rate-row">
            <span class="rl">Embedding text-embedding-004 <em>/1M tokens</em></span>
            <input type="number" step="0.01" [ngModel]="p.embedding.textEmbedding004.per1MTokens"
                   (change)="onRate('embedding','textEmbedding004','per1MTokens',$event)" />
            <span class="mxnh" *ngIf="fxRate() > 0">~{{ moneyMxn(mxn(p.embedding.textEmbedding004.per1MTokens)) }} MXN</span>
            <span class="stale" *ngIf="staleAge('embedding.textEmbedding004') as d">{{ staleMsg(d) }}</span>
          </div>

          <!-- LLM models -->
          <h3>Modelos LLM <em>(input / output por 1M tokens)</em></h3>
          <div class="rate-row llm" *ngFor="let e of llmEntries(); trackBy: trackLlm">
            <span class="rl">
              {{ e[0] }}
              <span class="badge danger" *ngIf="isExpensive(e[1].inputPer1M)" title="Modelo de tier caro (Pro)">CARO</span>
            </span>
            <label class="io">in
              <input type="number" step="0.01" [ngModel]="e[1].inputPer1M"
                     (change)="onRate('llm', e[0], 'inputPer1M', $event)" />
            </label>
            <label class="io">out
              <input type="number" step="0.01" [ngModel]="e[1].outputPer1M"
                     (change)="onRate('llm', e[0], 'outputPer1M', $event)" />
            </label>
            <span class="mxnh" *ngIf="fxRate() > 0">~{{ moneyMxn(mxn(e[1].inputPer1M)) }} / {{ moneyMxn(mxn(e[1].outputPer1M)) }} MXN</span>
            <span class="stale" *ngIf="staleAge('llm.' + e[0]) as d">{{ staleMsg(d) }}</span>
            <span class="ratenote" *ngIf="e[1].note">{{ e[1].note }}<span *ngIf="e[1].cachedInputPer1M != null"> (cache in: {{ money(e[1].cachedInputPer1M) }}/1M)</span></span>
          </div>

          <!-- Infra / storage scalars -->
          <h3>Firestore / Storage / Functions</h3>
          <div class="rate-row" *ngFor="let r of scalarRates; trackBy: trackRate">
            <span class="rl">{{ r.label }}</span>
            <input type="number" step="0.000001" [ngModel]="value(p, r.category, r.key)"
                   (change)="onRate(r.category, r.key, 'value', $event)" />
            <span class="mxnh" *ngIf="fxRate() > 0">~{{ moneyMxn(mxn(value(p, r.category, r.key))) }} MXN</span>
            <span class="stale" *ngIf="staleAge(r.category + '.' + r.key) as d">{{ staleMsg(d) }}</span>
          </div>

          <div class="rate-row">
            <span class="rl">TTS Piper (navegador)</span>
            <input type="number" [value]="p.tts.piperBrowser.value" disabled />
            <span class="zero">Piper corre en el navegador (cliente) -> costo de servidor = 0.</span>
          </div>

          <!-- Exchange rate: USD stays canonical; MXN is derived = usd * rate. -->
          <h3>Tipo de cambio</h3>
          <div class="rate-row" *ngIf="p.fx?.usdToMxn as fx">
            <span class="rl">USD -&gt; MXN <em>(MXN por 1 USD)</em></span>
            <input type="number" step="0.01" [ngModel]="fx.rate" (change)="onRate('fx','usdToMxn','rate',$event)" />
            <span class="stale" *ngIf="staleAge('fx.usdToMxn') as d">{{ staleMsg(d) }}</span>
            <span class="zero">{{ fx.source }}</span>
          </div>
        </div>
      </section>

      <!-- ===================== PROJECTION ===================== -->
      <section class="card">
        <h2>Proyeccion por asistente</h2>
        <div class="picker">
          <label>Asistente
            <select [ngModel]="selectedId()" (ngModelChange)="selectAssistant($event)">
              <option value="">- elige un asistente -</option>
              <option *ngFor="let a of assistants()" [value]="a.id">{{ a.name || a.id }}</option>
            </select>
          </label>
          <span class="spin" *ngIf="busy()"></span>
        </div>

        <ng-container *ngIf="projection() as pr">
          <!-- Models (dominant cost driver) -->
          <div class="models">
            <span class="mtag">Resumen: <b>{{ pr.models.summary.model }}</b>
              <span class="badge danger" *ngIf="pr.models.summary.expensive">TIER CARO</span>
              <span class="badge warn" *ngIf="!pr.models.summary.rated" title="Sin tarifa en la tabla">sin tarifa</span>
            </span>
            <span class="mtag">Detalle: <b>{{ pr.models.detail.model }}</b>
              <span class="badge danger" *ngIf="pr.models.detail.expensive">TIER CARO</span>
              <span class="badge warn" *ngIf="!pr.models.detail.rated" title="Sin tarifa en la tabla">sin tarifa</span>
            </span>
            <span class="basis">base: {{ pr.basis === 'real-usage' ? 'uso real' : 'supuestos' }}</span>
          </div>

          <!-- Real usage this month -->
          <div class="usage" *ngIf="pr.realUsage as u">
            <h3>Uso real ({{ u.month }})</h3>
            <div class="ug">
              <span>Consultas: <b>{{ u.queries }}</b></span>
              <span>Tokens embedding: <b>{{ u.embedTokens | number }}</b></span>
              <span>Lecturas vectoriales: <b>{{ u.vectorReads | number }}</b></span>
            </div>
            <table class="stages" *ngIf="stageRowsList().length">
              <tr><th>Etapa</th><th>in tokens</th><th>out tokens</th></tr>
              <tr *ngFor="let s of stageRowsList(); trackBy: trackStage"><td>{{ s.name }}</td><td>{{ s.in | number }}</td><td>{{ s.out | number }}</td></tr>
            </table>
          </div>
          <p class="note" *ngIf="!pr.realUsage">Aun no hay uso registrado este mes; la proyeccion usa supuestos por defecto.</p>

          <!-- Live calculator -->
          <div class="calc">
            <label>Consultas / mes
              <input type="number" min="0" step="100" [ngModel]="consultasMes()" (ngModelChange)="consultasMes.set(+$event || 0)" />
            </label>
            <div class="big">Proyeccion mensual ~ <b>{{ dual(liveMonthly()) }}</b> <span class="approx">aprox.</span></div>
          </div>

          <!-- Breakdown -->
          <div class="grid">
            <div class="kpi"><span>Costo por consulta</span><b>{{ dual(pr.perQuery.total) }}</b>
              <small>LLM {{ money(pr.perQuery.llm) }} + embed {{ money(pr.perQuery.embedding) }} + lecturas {{ money(pr.perQuery.vectorReads) }} (USD)</small></div>
            <div class="kpi"><span>Ingesta (una vez)</span><b>{{ dual(pr.ingestion.cost) }}</b>
              <small>{{ pr.ingestion.chunkCount | number }} fragmentos ~ {{ pr.ingestion.estTokens | number }} tokens</small></div>
            <div class="kpi"><span>Almacenamiento / mes</span><b>{{ dual(pr.storageMonthly.total) }}</b>
              <small>vectores {{ money(pr.storageMonthly.vectorsAndChunks) }} + docs {{ money(pr.storageMonthly.documents) }} + media {{ money(pr.storageMonthly.media) }} (USD)</small></div>
            <div class="kpi"><span>Infraestructura / mes</span><b>{{ dual(pr.infraMonthly.cost) }}</b>
              <small>{{ pr.infraMonthly.invocations | number }} invocaciones (estimado)</small></div>
          </div>

          <!-- Rental price (admin sets the margin) -->
          <div class="rental">
            <label>Precio de renta sugerido / mes USD (define tu margen)
              <input type="number" min="0" step="1" [(ngModel)]="rentalPrice" placeholder="0.00" />
            </label>
            <span class="mxnh" *ngIf="rentalPrice && fxRate() > 0">~{{ moneyMxn(mxn(rentalPrice)) }} MXN</span>
            <span class="margin" *ngIf="rentalPrice && liveMonthly() > 0">
              margen ~ {{ marginPct() }}% sobre el costo proyectado
            </span>
          </div>

          <p class="summaryes">{{ pr.summaryEs }}</p>

          <ul class="notes">
            <li *ngFor="let n of pr.notes">{{ n }}</li>
          </ul>
        </ng-container>
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; background: #0e0f13; color: #e8e9ee; min-height: 100vh; }
    .wrap { max-width: 1000px; margin: 0 auto; padding: 22px 20px 60px; }
    .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    h1 { margin: 0; font-size: 22px; }
    h2 { font-size: 16px; margin: 0 0 6px; }
    h3 { font-size: 13px; color: #b9b0e8; margin: 14px 0 6px; }
    h3 em, .rl em { color: #7d8496; font-style: normal; font-size: 11px; }
    .approx { color: #d9a441; font-size: 12px; font-weight: 600; }
    .sub { color: #8b92a3; font-size: 12.5px; max-width: 680px; margin: 4px 0 0; }
    .tlink { color: #cbb8f8; text-decoration: none; font-size: 13px; white-space: nowrap; }
    .card { background: #15161c; border: 1px solid rgba(255,255,255,.08); border-radius: 12px; padding: 16px; margin-top: 16px; }
    .note { color: #8b92a3; font-size: 11.5px; margin: 2px 0 10px; }
    .muted { color: #6b7384; font-size: 11px; font-weight: 400; margin-left: 8px; }
    .err { color: #f0a6a6; font-size: 13px; }
    .rates { display: flex; flex-direction: column; gap: 6px; }
    .rate-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .rate-row .rl { min-width: 280px; font-size: 12.5px; }
    .rate-row.llm .rl { min-width: 220px; }
    .rate-row input { width: 120px; background: #0e0f13; color: #e8e9ee; border: 1px solid rgba(255,255,255,.12);
      border-radius: 7px; padding: 5px 8px; font-size: 12.5px; }
    .rate-row input:disabled { opacity: .5; }
    .io { font-size: 11px; color: #8b92a3; display: inline-flex; align-items: center; gap: 5px; }
    .io input { width: 90px; }
    .stale { color: #e0b341; font-size: 11px; }
    .zero { color: #6fbf73; font-size: 11px; }
    .mxnh { color: #79c0ff; font-size: 11px; }
    .ratenote { color: #d9a441; font-size: 10.5px; width: 100%; }
    .badge { font-size: 9.5px; font-weight: 700; padding: 1px 6px; border-radius: 999px; margin-left: 6px; vertical-align: middle; }
    .badge.danger { background: rgba(220,70,70,.25); color: #f3a3a3; border: 1px solid rgba(220,70,70,.5); }
    .badge.warn { background: rgba(224,179,65,.2); color: #e0b341; border: 1px solid rgba(224,179,65,.45); }
    .picker { display: flex; align-items: center; gap: 12px; }
    .picker select { background: #0e0f13; color: #e8e9ee; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 7px 10px; min-width: 240px; }
    .models { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; margin: 12px 0; font-size: 12.5px; }
    .basis { color: #8b92a3; font-size: 11px; }
    .usage { margin: 8px 0; }
    .ug { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12.5px; }
    table.stages { margin-top: 8px; border-collapse: collapse; font-size: 12px; }
    table.stages th, table.stages td { border: 1px solid rgba(255,255,255,.1); padding: 4px 10px; text-align: right; }
    table.stages th:first-child, table.stages td:first-child { text-align: left; }
    .calc { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin: 14px 0; padding: 12px;
      background: rgba(139,92,246,.08); border: 1px solid rgba(139,92,246,.25); border-radius: 10px; }
    .calc label, .rental label, .picker label { font-size: 12px; color: #b6bccb; display: flex; flex-direction: column; gap: 4px; }
    .calc input { width: 130px; background: #0e0f13; color: #e8e9ee; border: 1px solid rgba(255,255,255,.14); border-radius: 8px; padding: 7px 9px; }
    .big { font-size: 15px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-top: 12px; }
    .kpi { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; }
    .kpi span { font-size: 11px; color: #8b92a3; }
    .kpi b { font-size: 16px; }
    .kpi small { color: #6b7384; font-size: 10.5px; }
    .rental { margin-top: 14px; display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; }
    .rental input { width: 150px; background: #0e0f13; color: #e8e9ee; border: 1px solid rgba(255,255,255,.14); border-radius: 8px; padding: 7px 9px; }
    .margin { color: #6fbf73; font-size: 12px; }
    .summaryes { margin-top: 14px; font-size: 12.5px; color: #d5d8e0; line-height: 1.5; background: rgba(255,255,255,.03); border-radius: 8px; padding: 10px 12px; }
    .notes { margin: 10px 0 0; padding-left: 18px; color: #8b92a3; font-size: 11.5px; }
    .notes li { margin: 3px 0; }
    .spin { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.25); border-top-color: #cbb8f8; border-radius: 50%; display: inline-block; animation: sp 0.8s linear infinite; }
    @keyframes sp { to { transform: rotate(360deg); } }
  `]
})
export class CostosComponent implements OnInit {
  private svc = inject(CostService);
  private assistantSvc = inject(AssistantConfigService);

  readonly pricing = signal<PricingConfig | null>(null);
  readonly stale = signal<StaleFlag[]>([]);
  readonly assistants = signal<AssistantConfig[]>([]);
  readonly selectedId = signal<string>('');
  readonly projection = signal<ProjectionResult | null>(null);
  readonly consultasMes = signal<number>(1000);
  rentalPrice: number | null = null;

  readonly busy = signal(false);
  readonly error = signal('');

  /** path -> ageDays for quick staleness lookup next to each rate. */
  private readonly staleMap = computed(() => {
    const m: Record<string, number> = {};
    for (const f of this.stale()) m[f.path] = f.ageDays;
    return m;
  });

  readonly llmEntries = computed(() => Object.entries(this.pricing()?.llm ?? {}));

  /** Live monthly = per-query unit * consultas/mes + fixed monthly (storage + infra). */
  readonly liveMonthly = computed(() => {
    const pr = this.projection();
    if (!pr) return 0;
    return pr.perQuery.total * this.consultasMes() + pr.storageMonthly.total + pr.infraMonthly.cost;
  });

  async ngOnInit(): Promise<void> {
    // Load INDEPENDENTLY: a failure (or slow cold start) of the pricing callable
    // must not block the assistant dropdown, and vice versa. (The previous
    // Promise.all coupled them, so a rejected getPricing() left assistants empty.)
    this.assistantSvc.listAssistants()
      .then((list) => this.assistants.set(list))
      .catch((e) => this.error.set('No se pudo cargar la lista de asistentes: ' + (e?.message ?? String(e))));

    try {
      const { pricing, stale } = await this.svc.getPricing();
      this.pricing.set(pricing);
      this.stale.set(stale);
    } catch (e: any) {
      this.error.set('No se pudo cargar la tabla de tarifas: ' + (e?.message ?? String(e)));
    }
  }

  staleAge(path: string): number | undefined { return this.staleMap()[path]; }
  staleMsg(days: number): string { return `Esta tarifa tiene ${days} dias; verifica que siga vigente`; }
  isExpensive(inputPer1M: number): boolean { return inputPer1M >= 1.0; }

  /** Scalar (single-value) rates rendered with a friendly label. STABLE reference
   *  (a constant, not a method): a fresh array each change-detection pass would
   *  make *ngFor recreate the ngModel inputs and loop CD forever (page freeze). */
  readonly scalarRates: { category: 'firestore' | 'storage' | 'functions'; key: string; label: string }[] = [
    { category: 'firestore', key: 'storagePerGiBMonth', label: 'Firestore almacenamiento /GiB-mes' },
    { category: 'firestore', key: 'readPer100kOps', label: 'Firestore lecturas /100k ops' },
    { category: 'firestore', key: 'writePer100kOps', label: 'Firestore escrituras /100k ops' },
    { category: 'storage', key: 'cloudStoragePerGiBMonth', label: 'Cloud Storage /GiB-mes' },
    { category: 'storage', key: 'egressPerGiB', label: 'Egress /GiB' },
    { category: 'functions', key: 'invocationCost', label: 'Functions /invocacion' },
    { category: 'functions', key: 'gbSecondCost', label: 'Functions /GB-segundo' },
  ];

  /** trackBy helpers so *ngFor never tears down rows on a new array reference. */
  trackRate = (_: number, r: { category: string; key: string }) => r.category + '.' + r.key;
  trackLlm = (_: number, e: [string, unknown]) => e[0];
  trackStage = (_: number, s: { name: string }) => s.name;

  /** Memoized stage rows (derived from the projection) for the usage table. */
  readonly stageRowsList = computed(() => {
    const stages = this.projection()?.realUsage?.stages ?? {};
    return Object.entries(stages).map(([name, v]) => ({ name, in: v?.inTokens ?? 0, out: v?.outTokens ?? 0 }));
  });

  value(p: PricingConfig, category: string, key: string): number {
    return (p as any)?.[category]?.[key]?.value ?? 0;
  }

  async onRate(category: any, key: string, field: string, ev: Event): Promise<void> {
    const value = Number((ev.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    try {
      const { pricing, stale } = await this.svc.updatePricingRate(category, key, field, value);
      this.pricing.set(pricing);
      this.stale.set(stale);
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    }
  }

  async selectAssistant(id: string): Promise<void> {
    this.selectedId.set(id);
    this.projection.set(null);
    if (!id) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const pr = await this.svc.projectAssistantCost(id);
      this.projection.set(pr);
      this.consultasMes.set(pr.totals.queriesPerMonth || 1000);
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }

  marginPct(): number {
    const cost = this.liveMonthly();
    if (!this.rentalPrice || cost <= 0) return 0;
    return Math.round(((this.rentalPrice - cost) / cost) * 100);
  }

  money(n: number): string {
    if (!Number.isFinite(n)) return '$0';
    return '$' + (n < 0.01 ? n.toFixed(6) : n.toFixed(2));
  }

  /** USD->MXN rate from config/pricing (single source of truth), or 0 if unset. */
  fxRate(): number { return this.pricing()?.fx?.usdToMxn?.rate ?? 0; }
  /** MXN amount derived from USD at display time. */
  mxn(usd: number): number { const r = this.fxRate(); return r > 0 ? usd * r : 0; }
  moneyMxn(n: number): string {
    if (!Number.isFinite(n)) return '$0';
    return '$' + (n < 0.01 ? n.toFixed(4) : n.toFixed(2));
  }
  /** Dual-currency label, e.g. "$0.0056 USD (~$0.10 MXN)". USD is canonical. */
  dual(usd: number): string {
    const u = this.money(usd) + ' USD';
    const r = this.fxRate();
    return r > 0 ? `${u} (~${this.moneyMxn(this.mxn(usd))} MXN)` : u;
  }
}
