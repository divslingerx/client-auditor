/**
 * Detects and groups URLs by their route patterns
 * Example: /blog/post-1, /blog/post-2 -> pattern: /blog/:slug
 */

export interface RoutePattern {
  pattern: string;
  urls: string[];
  sampleUrls: string[]; // Representative samples to audit
}

export class RoutePatternDetector {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /**
   * Groups URLs by their route patterns and selects representative samples
   */
  detectPatterns(urls: string[], samplesPerPattern: number = 3): Map<string, RoutePattern> {
    const patterns = new Map<string, RoutePattern>();

    for (const url of urls) {
      const pattern = this.extractPattern(url);

      if (!patterns.has(pattern)) {
        patterns.set(pattern, {
          pattern,
          urls: [],
          sampleUrls: []
        });
      }

      patterns.get(pattern)!.urls.push(url);
    }

    // Select samples from each pattern
    patterns.forEach((routePattern) => {
      routePattern.sampleUrls = this.selectSamples(
        routePattern.urls,
        samplesPerPattern
      );
    });

    return patterns;
  }

  /**
   * Extracts a route pattern from a URL
   * Examples:
   *   /blog/my-post-title -> /blog/:slug
   *   /products/123 -> /products/:id
   *   /category/tech/page/2 -> /category/:name/page/:num
   */
  private extractPattern(url: string): string {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname;

      // Split path into segments
      const segments = path.split('/').filter(s => s.length > 0);

      if (segments.length === 0) {
        return '/';
      }

      // Convert segments to pattern
      const patternSegments = segments.map(segment => {
        // Numeric IDs
        if (/^\d+$/.test(segment)) {
          return ':id';
        }

        // UUIDs
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
          return ':uuid';
        }

        // Dates (YYYY-MM-DD, YYYY/MM/DD, etc.)
        if (/^\d{4}-\d{2}-\d{2}$/.test(segment) || /^\d{4}$/.test(segment)) {
          return ':date';
        }

        // Common slug-like patterns (lowercase with hyphens)
        if (/^[a-z0-9]+-[a-z0-9-]+$/.test(segment)) {
          return ':slug';
        }

        // Everything else is kept as-is (likely static routes)
        return segment;
      });

      return '/' + patternSegments.join('/');
    } catch {
      return url;
    }
  }

  /**
   * Selects representative samples from a list of URLs
   * Strategy: homepage, shortest path, longest path, and random samples
   */
  private selectSamples(urls: string[], count: number): string[] {
    if (urls.length <= count) {
      return [...urls];
    }

    const samples: string[] = [];

    // Sort by path length
    const sorted = [...urls].sort((a, b) => {
      const aPath = new URL(a).pathname.length;
      const bPath = new URL(b).pathname.length;
      return aPath - bPath;
    });

    // 1. Shortest path (often simplest case)
    samples.push(sorted[0]);

    // 2. Longest path (often most complex case)
    if (sorted.length > 1) {
      samples.push(sorted[sorted.length - 1]);
    }

    // 3. Middle samples
    const remaining = count - samples.length;
    const step = Math.floor((sorted.length - 2) / remaining);
    for (let i = 0; i < remaining && samples.length < count; i++) {
      const index = Math.min(1 + step * (i + 1), sorted.length - 2);
      if (index > 0 && index < sorted.length - 1 && !samples.includes(sorted[index])) {
        samples.push(sorted[index]);
      }
    }

    return samples.slice(0, count);
  }

  /**
   * Returns URLs that should get full audits (Lighthouse + Axe)
   * Includes homepage, high-priority pages, and pattern samples
   */
  getFullAuditUrls(
    allUrls: string[],
    highPriorityUrls: string[],
    samplesPerPattern: number = 3
  ): Set<string> {
    const fullAuditUrls = new Set<string>();

    // Always audit homepage
    fullAuditUrls.add(this.baseUrl);
    fullAuditUrls.add(this.baseUrl + '/');

    // Add all high-priority URLs from sitemap
    highPriorityUrls.forEach(url => fullAuditUrls.add(url));

    // Detect patterns and add sample URLs
    const patterns = this.detectPatterns(allUrls, samplesPerPattern);
    patterns.forEach(pattern => {
      pattern.sampleUrls.forEach(url => fullAuditUrls.add(url));
    });

    return fullAuditUrls;
  }

  /**
   * Template-aware audit URL selection.
   * - Top-level pages (1 path segment: /about, /services) → all get Lighthouse (each is a unique template)
   * - Sub-route pages (2+ segments: /blog/my-post, /team/john) → 1 per pattern group (same template)
   * - Homepage and high-priority sitemap URLs always included
   */
  getTemplateAwareAuditUrls(
    allUrls: string[],
    highPriorityUrls: string[]
  ): Set<string> {
    const fullAuditUrls = new Set<string>();

    // Always audit homepage
    fullAuditUrls.add(this.baseUrl);
    fullAuditUrls.add(this.baseUrl + '/');

    // Add all high-priority URLs from sitemap
    highPriorityUrls.forEach(url => fullAuditUrls.add(url));

    const topLevel: string[] = [];
    const subRoutes: string[] = [];

    for (const url of allUrls) {
      try {
        const urlObj = new URL(url);
        const segments = urlObj.pathname.split('/').filter(s => s.length > 0);

        if (segments.length === 0) {
          // Homepage — already added above
          continue;
        } else if (segments.length === 1) {
          topLevel.push(url);
        } else {
          subRoutes.push(url);
        }
      } catch {
        // If URL parsing fails, treat as top-level to be safe
        topLevel.push(url);
      }
    }

    // All top-level pages get full audit (each is likely a unique template)
    topLevel.forEach(url => fullAuditUrls.add(url));

    // Sub-routes: 1 sample per pattern group
    if (subRoutes.length > 0) {
      const patterns = this.detectPatterns(subRoutes, 1);
      patterns.forEach(pattern => {
        pattern.sampleUrls.forEach(url => fullAuditUrls.add(url));
      });
    }

    return fullAuditUrls;
  }

  /**
   * Gets a summary of detected patterns for logging
   */
  getPatternSummary(urls: string[]): string[] {
    const patterns = this.detectPatterns(urls, 0);
    const summary: string[] = [];

    patterns.forEach((pattern, key) => {
      summary.push(`  ${key} (${pattern.urls.length} pages)`);
    });

    return summary;
  }
}
