export interface BrokenLink {
  pageUrl: string;
  linkUrl: string;
  linkType: 'anchor' | 'image' | 'document' | 'url' | 'tel' | 'mailto' | 'other';
  linkText?: string;
  statusCode?: number;
  errorMessage?: string;
  viewport: 'desktop' | 'mobile';
}

export interface AxeResults {
  violations: Array<{
    id?: string;
    impact: 'critical' | 'serious' | 'moderate' | 'minor';
    nodes: any[];
    description: string;
    help: string;
    helpUrl?: string;
    tags?: string[];
  }>;
}

export interface LighthouseResults {
  categories: {
    performance: { score: number };
    accessibility: { score: number };
    'best-practices': { score: number };
    seo: { score: number };
  };
}

export interface SiteConfig {
  url: string;
  domain: string;
}

export interface FailedPageEntry {
  url: string;
  viewport: string;
  error: string;
}

export type AuditTier = 'full' | 'accessibility-only' | 'links-only';

export type ViewportMode = 'both' | 'desktop' | 'mobile';

export interface AuditStrategy {
  mode: 'comprehensive' | 'fast';
  samplesPerPattern: number; // Number of sample pages to fully audit per route pattern (only used in comprehensive mode)
  useSitemap: boolean; // Whether to use sitemap.xml for discovering priority pages
  viewports: ViewportMode; // Which viewports to test
  lighthouseSamples: number; // -2 = template-aware (default), -1 = all pages, 0 = homepage only, N = N samples per pattern
  concurrency: number; // How many Axe-only pages to run in parallel (default 3)
}

export interface PageReport {
  url: string;
  viewport: 'desktop' | 'mobile';
  criticalIssues: number;
  seriousIssues: number;
  moderateIssues: number;
  minorIssues: number;
  performanceScore: number;
  accessibilityScore: number;
  bestPracticesScore: number;
  seoScore: number;
  notes: string;
  auditTier?: AuditTier; // Track what level of audit was performed
}