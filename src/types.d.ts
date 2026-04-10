declare module 'google-lighthouse-puppeteer' {
  export function runLighthouseAudit(options: {
    page: any;
    url: string;
    thresholds?: any;
    opts?: {
      onlyCategories?: string[];
    };
  }): Promise<{
    lhr: {
      categories: {
        performance: { score: number | null };
        accessibility: { score: number | null };
        'best-practices': { score: number | null };
        seo: { score: number | null };
      };
    };
  }>;
}