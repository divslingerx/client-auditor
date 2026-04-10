import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer';
import { AxePuppeteer } from '@axe-core/puppeteer';
import * as fs from 'fs';
import * as path from 'path';
import { LinkChecker } from './linkChecker';
import { CSVWriter } from './csvWriter';
import { PageReport, AxeResults, LighthouseResults, AuditStrategy, AuditTier, FailedPageEntry } from './types';
import { ViolationsAggregator } from './violationsAggregator';
import { PDFReportGenerator, PDFReportData } from './pdfReportGenerator';
import { ResumeManager } from './resumeManager';
import { withRetry, isRetryableError } from './retryUtils';
import { runLighthouseSafely, runLighthouseMinimal } from './lighthouseWrapper';
import { SitemapParser } from './sitemapParser';
import { RoutePatternDetector } from './routePatternDetector';

// StealthPlugin helps bypass bot detection on sites that block automated tools
puppeteer.use(StealthPlugin());

export class SiteAuditor {
  private browser: Browser | null = null;
  private csvWriter: CSVWriter;
  private linkChecker: LinkChecker;
  private violationsAggregator: ViolationsAggregator;
  private resumeManager: ResumeManager;
  private baseUrl: string;
  private domain: string;
  private visitedPages = new Set<string>();
  private pagesToVisit: string[] = [];
  private pageReports: PageReport[] = [];
  private readonly MAX_PAGES = 100; // Prevents infinite crawling on large sites or crawler traps
  private auditStrategy: AuditStrategy;
  private sitemapParser: SitemapParser;
  private routePatternDetector: RoutePatternDetector;
  private fullAuditUrls: Set<string> = new Set();
  private failedPages = new Map<string, string>(); // url::viewport → error message

  constructor(siteUrl: string, clearProgress: boolean = false, auditStrategy?: AuditStrategy) {
    this.baseUrl = siteUrl;
    const url = new URL(siteUrl);
    this.domain = url.hostname;
    this.csvWriter = new CSVWriter(this.domain);
    this.linkChecker = new LinkChecker(siteUrl);
    this.violationsAggregator = new ViolationsAggregator();
    this.resumeManager = new ResumeManager(this.domain);
    this.sitemapParser = new SitemapParser(siteUrl);
    this.routePatternDetector = new RoutePatternDetector(siteUrl);

    // Default to fast mode if not specified
    this.auditStrategy = auditStrategy || {
      mode: 'fast',
      samplesPerPattern: 3,
      useSitemap: true,
      viewports: 'both',
      lighthouseSamples: 0, // 0 = homepage only in fast mode
      concurrency: 3
    };

    if (clearProgress) {
      console.log('  Clearing previous progress...');
      this.resumeManager.clearProgress();
    }
  }

  private async launchBrowser(viewport: 'desktop' | 'mobile'): Promise<void> {
    const viewportConfig = viewport === 'desktop' 
      ? { width: 1920, height: 1080 }
      : { width: 393, height: 852 };

    this.browser = await puppeteer.launch({
      headless: 'new' as any, // Use 'new' headless mode per Puppeteer best practices
      defaultViewport: viewportConfig,
      protocolTimeout: 180000, // Increase from default 180s to handle slow pages
      // Lighthouse needs control over certain Chrome flags, so we remove the automation flag
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-features=HttpsFirstBalancedModeAutoEnable' // Prevents ERR_BLOCKED_BY_CLIENT errors
      ]
    });
  }

  private async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  private normalizeUrl(url: string): string {
    try {
      const normalized = new URL(url, this.baseUrl);
      normalized.hash = ''; // Fragments don't affect page content
      // Tracking parameters create duplicate entries for the same page
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'].forEach(param => {
        normalized.searchParams.delete(param);
      });
      const href = normalized.href;
      return href.endsWith('/') ? href.slice(0, -1) : href;
    } catch {
      return url;
    }
  }

  private isInternalUrl(url: string): boolean {
    try {
      const urlObj = new URL(url, this.baseUrl);
      return urlObj.hostname === this.domain;
    } catch {
      return false;
    }
  }

  private shouldSkipUrl(url: string, logSkips: boolean = false): boolean {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname.toLowerCase();
      const search = urlObj.search.toLowerCase();

      // --- Static assets (non-HTML files) ---
      if (/\.(pdf|jpg|jpeg|png|gif|svg|webp|ico|bmp|tiff|avif|mp4|mp3|avi|mov|wmv|flv|webm|ogg|wav|zip|rar|gz|tar|7z|css|js|woff|woff2|ttf|eot|otf|doc|docx|xls|xlsx|ppt|pptx|csv|txt|rtf|swf)$/i.test(path)) {
        return true;
      }

      // --- Event calendar plugins (The Events Calendar, Modern Events, etc.) ---
      // These plugins create massive link graphs between calendar views
      if (/\/(events?|calendar|tribe-events|tribe_events)/.test(path)) {
        return true;
      }
      if (/[?&](tribe|eventcategory|eventdate|ical|action=tribe|eventDisplay)/i.test(search)) {
        return true;
      }
      if (/\/(event-category|event-tag|event-venue|venue|organizer)\//.test(path)) {
        return true;
      }

      // --- WordPress system endpoints ---
      if (/\/wp-json(\/|$)/.test(path) ||
          /\/wp-content\/uploads\//.test(path) ||
          /\/(wp-cron|xmlrpc|wp-trackback)\.php/.test(path) ||
          /\/(wp-login|wp-register|wp-signup|wp-activate)\.php/.test(path)) {
        return true;
      }

      // --- WordPress special pages ---
      // Attachment pages (near-empty pages showing a single media file)
      if (/\/attachment\//.test(path) || /[?&]attachment_id=/i.test(search)) {
        return true;
      }
      // oEmbed pages (stripped-down versions of posts)
      if (/\/embed\/?$/.test(path)) {
        return true;
      }
      // Trackback endpoints
      if (/\/trackback\/?$/.test(path)) {
        return true;
      }
      // Preview/draft URLs (will 404 without auth)
      if (/[?&](preview|preview_id|preview_nonce)=/i.test(search)) {
        return true;
      }
      // Comment reply URLs (same page with different query)
      if (/[?&]replytocom=/i.test(search)) {
        return true;
      }
      // Default WordPress permalink format (same content as pretty URLs)
      if (/^\/?\?p=\d+$/.test(urlObj.pathname + urlObj.search) && path === '/') {
        // Only skip if site also uses pretty permalinks (has other non-?p= pages)
        if (/[?&]p=\d+/i.test(search)) {
          return true;
        }
      }
      // WordPress search results
      if (/[?&]s=/i.test(search)) {
        return true;
      }
      // Per-post and per-category feeds
      if (/\/feed\/?$/.test(path) || /\/comments\/feed\/?$/.test(path)) {
        return true;
      }

      // --- WooCommerce / eCommerce ---
      if (/\/(cart|checkout|my-account|order-received|order-pay|lost-password|edit-account|view-order)/.test(path)) {
        return true;
      }
      if (/[?&](add-to-cart|remove_item|added-to-cart)=/i.test(search)) {
        return true;
      }
      if (/\/product-category\/.*\/page\//.test(path) || /\/shop\/page\//.test(path)) {
        return true;
      }

      // --- Blog archives and date-based pages ---
      if (/\/\d{4}\/\d{1,2}(\/\d{1,2})?\/?$/.test(path)) {
        return true;
      }

      // --- Deep pagination ---
      // Matches page 3+ (single digit 3-9 or any multi-digit number >= 10)
      if (/\/page\/([3-9]|\d{2,})/.test(path) ||
          /[?&](page|p|pg|paged)=([3-9]|\d{2,})(&|$)/.test(search)) {
        if (logSkips) console.log(`    Skipping deep pagination: ${url}`);
        return true;
      }

      // --- Archive pages ---
      if (/\/(archive|archives)\/\d{4}/.test(path)) {
        return true;
      }

      // --- WordPress meta/taxonomy aggregation pages ---
      if (/\/(author|category|tag|taxonomy)\//.test(path)) {
        return true;
      }

      // --- Print, download, export ---
      if (/\/(print|download|export)/.test(path) ||
          /[?&](print|download|export|format=pdf)=/i.test(search)) {
        if (logSkips) console.log(`    Skipping print/download URL: ${url}`);
        return true;
      }

      // --- API endpoints ---
      if (/\/(api|ajax|json|xml)\//.test(path) ||
          path.endsWith('.json') || path.endsWith('.xml')) {
        if (logSkips) console.log(`    Skipping API endpoint: ${url}`);
        return true;
      }

      // --- Feed URLs ---
      if (/\/(rss|atom)/.test(path) ||
          path.endsWith('.rss') || path.endsWith('.atom')) {
        if (logSkips) console.log(`    Skipping feed URL: ${url}`);
        return true;
      }

      // --- Login, logout, admin pages ---
      if (/\/(login|logout|signin|signout|signup|register|admin|wp-admin|dashboard)/.test(path)) {
        if (logSkips) console.log(`    Skipping admin/auth URL: ${url}`);
        return true;
      }

      // --- LMS plugin pages (LearnDash, LifterLMS, etc.) ---
      if (/\/(lessons|quizzes|certificates|assignments|gradebook)\//.test(path)) {
        return true;
      }

      // --- BuddyPress / bbPress community pages ---
      if (/\/(members|activity|forums|groups)\/[^/]+\/(friends|messages|settings|notifications)/.test(path)) {
        return true;
      }

      // --- URLs with too many query parameters (likely filters/facets) ---
      const paramCount = Array.from(urlObj.searchParams.keys()).length;
      if (paramCount > 3) {
        if (logSkips) console.log(`    Skipping URL with many parameters: ${url}`);
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  private async crawlForLinks(page: Page): Promise<string[]> {
    const links = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      return anchors
        .map(a => (a as HTMLAnchorElement).href)
        .filter(href => href && !href.startsWith('#') && !href.startsWith('mailto:') && !href.startsWith('tel:'));
    });

    // Track what we're skipping for summary
    const skippedTypes = {
      events: 0,
      assets: 0,
      wordpress: 0,
      ecommerce: 0,
      pagination: 0,
      archive: 0,
      other: 0
    };

    const internalLinks = links
      .filter(link => this.isInternalUrl(link))
      .filter(link => {
        if (this.shouldSkipUrl(link)) {
          try {
            const linkPath = new URL(link).pathname.toLowerCase();
            const linkSearch = new URL(link).search.toLowerCase();

            // Categorize what was skipped
            if (/\/(events?|calendar|tribe-events)/.test(linkPath) || /tribe|eventcategory|eventdate/i.test(linkSearch)) {
              skippedTypes.events++;
            } else if (/\.(pdf|jpg|jpeg|png|gif|svg|webp|css|js|zip|doc|xlsx|mp4|mp3)$/i.test(linkPath)) {
              skippedTypes.assets++;
            } else if (/\/(wp-json|wp-content|wp-admin|wp-login|attachment|embed|trackback|author|category|tag)/.test(linkPath) ||
                       /[?&](replytocom|preview|s)=/i.test(linkSearch)) {
              skippedTypes.wordpress++;
            } else if (/\/(cart|checkout|my-account|shop\/page|product-category)/.test(linkPath) ||
                       /[?&]add-to-cart=/i.test(linkSearch)) {
              skippedTypes.ecommerce++;
            } else if (/\/page\/([3-9]|\d{2,})/.test(linkPath) || /[?&](page|paged)=/i.test(linkSearch)) {
              skippedTypes.pagination++;
            } else if (/\/(archive|archives)\//.test(linkPath) || /\/\d{4}\/\d{1,2}/.test(linkPath)) {
              skippedTypes.archive++;
            } else {
              skippedTypes.other++;
            }
          } catch { skippedTypes.other++; }
          return false;
        }
        return true;
      })
      .map(link => this.normalizeUrl(link));

    // Only log summary if we skipped a lot
    const totalSkipped = Object.values(skippedTypes).reduce((a, b) => a + b, 0);
    if (totalSkipped > 5) {
      const parts = [];
      if (skippedTypes.events > 0) parts.push(`${skippedTypes.events} events`);
      if (skippedTypes.assets > 0) parts.push(`${skippedTypes.assets} assets`);
      if (skippedTypes.wordpress > 0) parts.push(`${skippedTypes.wordpress} WP system`);
      if (skippedTypes.ecommerce > 0) parts.push(`${skippedTypes.ecommerce} ecommerce`);
      if (skippedTypes.pagination > 0) parts.push(`${skippedTypes.pagination} pagination`);
      if (skippedTypes.archive > 0) parts.push(`${skippedTypes.archive} archive`);
      if (skippedTypes.other > 0) parts.push(`${skippedTypes.other} other`);
      console.log(`    Filtered out ${totalSkipped} URLs: ${parts.join(', ')}`);
    }

    return [...new Set(internalLinks)];
  }

  private async runAxeTest(page: Page): Promise<AxeResults> {
    try {
      const results = await withRetry(
        async () => {
          await page.waitForSelector('body', { timeout: 5000 }).catch(() => {});
          return await new AxePuppeteer(page).analyze();
        },
        {
          maxAttempts: 3,
          initialDelay: 1000,
          backoffMultiplier: 2,
          onRetry: (error, attempt) => {
            console.log(`    Axe test failed, retrying... (${attempt}/3): ${error.message?.slice(0, 80)}`);
          }
        }
      );
      // Preserve all violation metadata for detailed reporting
      return {
        violations: results.violations.map(v => ({
          id: v.id,
          impact: v.impact as any,
          tags: v.tags,
          nodes: v.nodes,
          description: v.description,
          help: v.help,
          helpUrl: v.helpUrl
        }))
      };
    } catch (error: any) {
      console.error('    Axe test failed after 3 attempts:', error?.message || error);
      return { violations: [] };
    }
  }

  private async runLighthouse(page: Page, url: string): Promise<LighthouseResults | null> {
    const viewport = page.viewport()?.width === 393 ? 'mobile' : 'desktop';

    // Attempt 1: Full Lighthouse in child process
    console.log(`    Running Lighthouse (child process)...`);
    let result = await runLighthouseSafely(url, page, viewport);

    if (result) {
      return result;
    }

    // Attempt 2: Retry once — transient CDP/network issues are common
    console.log(`    Retrying Lighthouse...`);
    result = await runLighthouseSafely(url, page, viewport);

    if (result) {
      return result;
    }

    // Attempt 3: Minimal mode
    console.log(`    Attempting minimal Lighthouse...`);
    const wsEndpoint = this.browser?.wsEndpoint();
    const port = wsEndpoint ? new URL(wsEndpoint).port : undefined;
    result = await runLighthouseMinimal(url, port);

    if (!result) {
      console.log(`    ⚠️  All Lighthouse attempts failed, continuing without performance metrics`);
    }

    return result;
  }

  private generateNotes(axeResults: AxeResults, lighthouseResults: LighthouseResults | null): string {
    // Creates human-readable summary for CSV reports
    const axeNotes = this.violationsAggregator.generateNoteSummary(axeResults);
    
    const performanceNotes: string[] = [];
    if (lighthouseResults) {
      if (lighthouseResults.categories.performance.score < 0.5) {
        performanceNotes.push(`Poor performance (${Math.round(lighthouseResults.categories.performance.score * 100)}%)`);
      }
    }

    const allNotes = [axeNotes, ...performanceNotes].filter(n => n);
    return allNotes.join('; ') || 'No major issues found';
  }

  /**
   * Categorize discovered pages into audit tiers based on mode and lighthouse settings
   */
  private categorizePagesForAudit(allUrls: string[], highPriorityUrls: string[]): void {
    if (this.auditStrategy.mode === 'comprehensive' || this.auditStrategy.lighthouseSamples === -1) {
      // Comprehensive mode: all pages get Lighthouse
      this.fullAuditUrls = new Set(allUrls);
    } else if (this.auditStrategy.lighthouseSamples === 0) {
      // Homepage only gets Lighthouse
      this.fullAuditUrls = new Set([this.normalizeUrl(this.baseUrl)]);
    } else if (this.auditStrategy.lighthouseSamples === -2) {
      // Template-aware: all top-level pages + 1 sample per sub-route pattern
      this.fullAuditUrls = this.routePatternDetector.getTemplateAwareAuditUrls(
        allUrls,
        highPriorityUrls
      );
    } else {
      // Use route pattern detection to select N samples per pattern
      this.fullAuditUrls = this.routePatternDetector.getFullAuditUrls(
        allUrls,
        highPriorityUrls,
        this.auditStrategy.lighthouseSamples
      );
    }
  }

  /**
   * Discover pages by crawling without running audits
   */
  private async discoverPages(): Promise<void> {
    console.log('  Crawling site to discover pages...');

    while (this.pagesToVisit.length > 0 && this.visitedPages.size < this.MAX_PAGES) {
      const url = this.pagesToVisit.shift()!;
      const normalizedUrl = this.normalizeUrl(url);

      if (this.visitedPages.has(normalizedUrl)) {
        continue;
      }

      this.visitedPages.add(normalizedUrl);
      this.resumeManager.addDiscoveredUrl(normalizedUrl);

      if (!this.browser) {
        throw new Error('Browser not launched');
      }

      const page = await this.browser.newPage();

      try {
        await page.goto(normalizedUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        }).catch(() => {
          // Ignore navigation errors during discovery
        });

        // Extract links
        const newLinks = await this.crawlForLinks(page);
        newLinks.forEach(link => {
          if (!this.visitedPages.has(link) && !this.pagesToVisit.includes(link)) {
            this.pagesToVisit.push(link);
          }
        });
      } catch (error) {
        // Continue on error during discovery
      } finally {
        await page.close();
      }
    }

    console.log(`  Discovered ${this.visitedPages.size} pages`);
  }

  private async auditPage(url: string, viewport: 'desktop' | 'mobile', shouldCrawl: boolean = true, tier: AuditTier = 'full'): Promise<void> {
    if (!this.browser) {
      throw new Error('Browser not launched');
    }

    const normalizedUrl = this.normalizeUrl(url);

    if (this.visitedPages.has(normalizedUrl)) {
      return;
    }

    // Track this URL for mobile audit (persists across restarts)
    this.resumeManager.addDiscoveredUrl(normalizedUrl);

    // Check if this page was already completed in a previous run
    if (this.resumeManager.isPageCompleted(normalizedUrl, viewport)) {
      this.visitedPages.add(normalizedUrl);
      console.log(`Skipping ${viewport}: ${normalizedUrl} (already completed)`);
      return;
    }

    const tierLabel = tier === 'full' ? '[FULL]' : tier === 'accessibility-only' ? '[AXE]' : '[LINKS]';
    const urlPath = new URL(normalizedUrl).pathname || '/';
    const logPrefix = urlPath.length > 30 ? urlPath.slice(0, 27) + '...' : urlPath;
    console.log(`${tierLabel} Auditing ${viewport}: ${normalizedUrl}`);

    const page = await this.browser.newPage();

    try {
      if (viewport === 'mobile') {
        await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1');
      }

      // Try navigation with retry logic - attempt once, retry once if fails
      const navigationSucceeded = await withRetry(
        async () => {
          try {
            const response = await page.goto(normalizedUrl, {
              waitUntil: 'networkidle2',
              timeout: 45000
            });
            // Don't retry permanent HTTP failures — record and bail immediately
            if (response && (response.status() === 404 || response.status() === 410)) {
              this.failedPages.set(`${normalizedUrl}::${viewport}`, `HTTP ${response.status()}`);
              return false;
            }
            return true;
          } catch (navError: any) {
            // If strict navigation fails, try with less strict wait condition
            console.log(`    Retrying with relaxed navigation...`);
            const response = await page.goto(normalizedUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 45000
            });
            if (response && (response.status() === 404 || response.status() === 410)) {
              this.failedPages.set(`${normalizedUrl}::${viewport}`, `HTTP ${response.status()}`);
              return false;
            }
            // Give page extra time to stabilize
            await new Promise(resolve => setTimeout(resolve, 2000));
            return true;
          }
        },
        {
          maxAttempts: 2,
          initialDelay: 3000,
          onRetry: (error, attempt) => {
            console.log(`    ⚠️  Navigation failed (attempt ${attempt}): ${error.message?.slice(0, 100)}`);
          },
          shouldRetry: (error) => {
            // Only retry on timeout/network errors, not on 404s etc
            return isRetryableError(error);
          }
        }
      ).catch((finalError) => {
        console.log(`    ⚠️  Skipping page after navigation failures: ${finalError.message?.slice(0, 100)}`);
        this.failedPages.set(`${normalizedUrl}::${viewport}`, finalError.message?.slice(0, 200) || 'Navigation failed');
        return false;
      });

      // If navigation failed after retries, skip this page
      if (!navigationSucceeded) {
        console.log(`    Page skipped due to navigation failures`);
        return;
      }

      // Mark as visited only after successful navigation
      this.visitedPages.add(normalizedUrl);

      // Mobile often has different navigation/menus, but we assume desktop discovers all pages
      if (shouldCrawl) {
        const newLinks = await this.crawlForLinks(page);
        newLinks.forEach(link => {
          if (!this.visitedPages.has(link) && !this.pagesToVisit.includes(link)) {
            this.pagesToVisit.push(link);
          }
        });
      }

      // Run tests based on audit tier
      let lighthouseResults: LighthouseResults | null = null;
      let axeResults: AxeResults = { violations: [] };
      let axeSucceeded = false;

      // IMPORTANT: Run Axe FIRST, then Lighthouse on a fresh page
      // This prevents protocol conflicts from Lighthouse corrupting the page for Axe
      if (tier === 'full' || tier === 'accessibility-only') {
        // Run Axe accessibility test first (fast and non-invasive)
        console.log(`  [${logPrefix}] Running Axe...`);
        try {
          axeResults = await this.runAxeTest(page);
          axeSucceeded = true;
        } catch (error: any) {
          console.log(`    ⚠️  Axe test failed: ${error.message?.slice(0, 100)}`);
          axeResults = { violations: [] };
        }
      }

      if (tier === 'full') {
        // Run Lighthouse AFTER Axe, on a fresh page to avoid protocol conflicts
        console.log(`  [${logPrefix}] Running Lighthouse...`);
        lighthouseResults = await this.runLighthouse(page, normalizedUrl);

        // If Lighthouse failed, we can still continue with other tests
        if (!lighthouseResults) {
          console.log(`    Continuing without Lighthouse results...`);
        }
      }

      // Check links only on desktop (links are viewport-agnostic)
      if (viewport === 'desktop') {
        console.log(`  [${logPrefix}] Checking links...`);
        await this.linkChecker.checkPageLinks(page, normalizedUrl, viewport).catch((error) => {
          console.log(`    ⚠️  Link checking failed: ${error.message?.slice(0, 100)}`);
        });
      }

      // Stream processing pattern - write immediately to avoid memory buildup on large sites
      this.writeHtmlReportForPage(normalizedUrl, axeResults, viewport);

      // Add only aggregated data (not full results) to aggregator
      this.violationsAggregator.addAggregatedData(normalizedUrl, axeResults, viewport);

      const impactCounts = {
        critical: 0,
        serious: 0,
        moderate: 0,
        minor: 0
      };

      axeResults.violations.forEach(v => {
        impactCounts[v.impact] += v.nodes.length;
      });

      const pageReport: PageReport = {
        url: normalizedUrl,
        viewport,
        criticalIssues: impactCounts.critical,
        seriousIssues: impactCounts.serious,
        moderateIssues: impactCounts.moderate,
        minorIssues: impactCounts.minor,
        performanceScore: Math.round((lighthouseResults?.categories.performance.score || 0) * 100),
        accessibilityScore: Math.round((lighthouseResults?.categories.accessibility.score || 0) * 100),
        bestPracticesScore: Math.round((lighthouseResults?.categories['best-practices'].score || 0) * 100),
        seoScore: Math.round((lighthouseResults?.categories.seo.score || 0) * 100),
        notes: this.generateNotes(axeResults, lighthouseResults),
        auditTier: tier
      };

      await this.csvWriter.appendPageReport(pageReport);
      this.pageReports.push(pageReport);

      // Only mark as completed if the core tests for this tier actually succeeded.
      // This ensures failed pages are retried on resume.
      const auditSucceeded = tier === 'full'
        ? (axeSucceeded && lighthouseResults !== null)
        : axeSucceeded;

      if (auditSucceeded) {
        this.resumeManager.markPageCompleted(normalizedUrl, viewport);
      } else {
        console.log(`    ⚠️  Partial results saved — page will be retried on next run`);
      }

    } catch (error: any) {
      console.error(`  Error auditing page ${normalizedUrl}:`, error);
      this.failedPages.set(`${normalizedUrl}::${viewport}`, error.message?.slice(0, 200) || 'Unknown error');
    } finally {
      await page.close();
    }
  }

  async audit(): Promise<void> {
    console.log(`\nStarting audit for ${this.domain}`);
    console.log('='.repeat(50));
    console.log(`Audit Mode: ${this.auditStrategy.mode.toUpperCase()}`);
    console.log(`Viewports: ${this.auditStrategy.viewports.toUpperCase()}`);
    console.log(`Lighthouse: ${this.auditStrategy.lighthouseSamples === -2 ? 'Template-aware (all top-level + 1 per sub-route pattern)' : this.auditStrategy.lighthouseSamples === 0 ? 'Homepage only' : this.auditStrategy.lighthouseSamples === -1 ? 'All pages' : `${this.auditStrategy.lighthouseSamples} samples per pattern`}`);
    console.log(`Concurrency: ${this.auditStrategy.concurrency} (Axe-only pages)`);
    console.log(`Use sitemap: ${this.auditStrategy.useSitemap ? 'Yes' : 'No'}`);
    console.log('='.repeat(50));

    // Parse sitemap if enabled
    let sitemapUrls: string[] = [];
    let highPriorityUrls: string[] = [];

    if (this.auditStrategy.useSitemap) {
      console.log('\n📄 Fetching sitemap.xml...');
      const parsedSitemap = await this.sitemapParser.parseSitemap();
      if (parsedSitemap.length > 0) {
        sitemapUrls = this.sitemapParser.getAllUrls(parsedSitemap);
        highPriorityUrls = this.sitemapParser.getHighPriorityUrls(parsedSitemap);
        console.log(`  Found ${sitemapUrls.length} URLs (${highPriorityUrls.length} high-priority)`);
      }
    }

    // Store data for PDF generation
    const pdfData: PDFReportData = {
      domain: this.domain,
      desktop: { pageReports: [], violations: [], brokenLinks: [] },
      mobile: { pageReports: [], violations: [], brokenLinks: [] }
    };

    // Store discovered URLs from desktop to reuse for mobile
    let discoveredUrls: string[] = [];

    // Determine which viewports to test
    const viewportsToTest: ('desktop' | 'mobile')[] = [];
    if (this.auditStrategy.viewports === 'both') {
      viewportsToTest.push('desktop', 'mobile');
    } else if (this.auditStrategy.viewports === 'desktop') {
      viewportsToTest.push('desktop');
    } else if (this.auditStrategy.viewports === 'mobile') {
      viewportsToTest.push('mobile');
    }

    for (const viewport of viewportsToTest) {
      console.log(`\n--- Running ${viewport.toUpperCase()} audit ---`);
      
      this.visitedPages.clear();
      this.linkChecker.clearBrokenLinks();
      this.violationsAggregator.clear();
      this.pageReports = [];

      // For desktop, discover pages. For mobile, use all discovered pages (including from previous runs)
      if (viewport === 'desktop') {
        // Start with previously discovered URLs if resuming
        const previouslyDiscovered = this.resumeManager.getDiscoveredUrls();
        if (previouslyDiscovered.length > 0) {
          // Include all previously discovered URLs
          this.pagesToVisit = [...new Set([this.baseUrl, ...previouslyDiscovered])];
          console.log(`  Found ${previouslyDiscovered.length} previously discovered URLs`);
        } else {
          this.pagesToVisit = [this.baseUrl];
        }
      } else if (viewport === 'mobile' && discoveredUrls.length === 0) {
        // Mobile-only mode without previous desktop run
        console.log('  Mobile-only mode: crawling to discover pages first...');
        this.pagesToVisit = [this.baseUrl];
        
        const desktopCompleted = this.resumeManager.getCompletedCount('desktop');
        if (desktopCompleted > 0) {
          console.log(`  Resuming from previous run (${desktopCompleted} pages already completed)`);
        }
        console.log('  Discovering pages and running audits...');
      } else {
        // Get ALL discovered URLs (including from previous runs that may have failed)
        const allDiscoveredUrls = this.resumeManager.getDiscoveredUrls();
        
        // If we have discovered URLs from a previous run, use those
        // Otherwise use what we just discovered in this desktop run
        if (allDiscoveredUrls.length > 0) {
          this.pagesToVisit = [...allDiscoveredUrls];
          console.log(`  Using ${allDiscoveredUrls.length} pages (from saved progress)...`);
        } else if (discoveredUrls.length > 0) {
          this.pagesToVisit = [...discoveredUrls];
          console.log(`  Using ${discoveredUrls.length} pages discovered from desktop audit...`);
        } else {
          console.log('  WARNING: No URLs discovered for mobile audit');
          this.pagesToVisit = [this.baseUrl];
        }
        
        const mobileCompleted = this.resumeManager.getCompletedCount('mobile');
        if (mobileCompleted > 0) {
          console.log(`  Resuming from previous run (${mobileCompleted} pages already completed)`);
        }
        // Link validation results are viewport-agnostic, so we cache across runs
      }

      await this.launchBrowser(viewport);

      // Determine if we need to crawl for page discovery
      const needsDiscovery = (viewport === 'desktop') || (viewport === 'mobile' && discoveredUrls.length === 0);

      if (needsDiscovery) {
        // Crawl to discover all pages (without running full audits yet)
        console.log('\n🔍 Analyzing page structure...');
        await this.discoverPages();

        // Get all discovered URLs
        const allUrls = Array.from(this.visitedPages);

        // Categorize pages for tiered auditing
        this.categorizePagesForAudit(allUrls, highPriorityUrls);

        console.log(`\n📊 Audit Plan:`);
        console.log(`  Total pages discovered: ${allUrls.length}`);
        console.log(`  Full audits (Lighthouse + Axe): ${this.fullAuditUrls.size}`);
        console.log(`  Accessibility-only audits (Axe): ${allUrls.length - this.fullAuditUrls.size}`);

        // Show route patterns
        const patterns = this.routePatternDetector.getPatternSummary(allUrls);
        if (patterns.length > 0) {
          console.log(`\n  Detected route patterns:`);
          patterns.forEach(p => console.log(p));
        }

        // Reset visited pages to actually audit them now
        this.visitedPages.clear();
        this.pagesToVisit = [...allUrls];

        // Save for next viewport if running both
        if (viewport === 'desktop') {
          discoveredUrls = [...allUrls];
        }
      } else if (viewport === 'mobile' && this.fullAuditUrls.size > 0) {
        // Mobile reuses tier categorization from desktop
        console.log(`\n  Reusing tier categorization from desktop audit`);
        console.log(`  Full audits: ${this.fullAuditUrls.size}`);
        console.log(`  Accessibility-only: ${this.pagesToVisit.length - this.fullAuditUrls.size}`);
      } else if (viewport === 'mobile') {
        // Mobile without prior desktop categorization — categorize now
        const allUrls = [...this.pagesToVisit];
        this.categorizePagesForAudit(allUrls, highPriorityUrls);
        console.log(`\n📊 Mobile Audit Plan:`);
        console.log(`  Full audits (Lighthouse + Axe): ${this.fullAuditUrls.size}`);
        console.log(`  Accessibility-only audits (Axe): ${allUrls.length - this.fullAuditUrls.size}`);
      }

      // Phase 1: Full-audit pages (Lighthouse + Axe), processed sequentially.
      // Lighthouse records real traces during load — CPU/network contention from
      // other tabs would degrade those traces and produce artificially lower scores.
      const fullAuditPages = this.pagesToVisit.filter(url => this.fullAuditUrls.has(url));
      this.pagesToVisit = this.pagesToVisit.filter(url => !this.fullAuditUrls.has(url));

      if (fullAuditPages.length > 0) {
        console.log(`\n  Phase 1: Full audits (${fullAuditPages.length} pages, sequential)...`);
        for (const url of fullAuditPages) {
          if (this.visitedPages.size >= this.MAX_PAGES) break;
          await this.auditPage(url, viewport, viewport === 'desktop', 'full');
        }
      }

      // Phase 2: Axe-only pages in concurrent batches.
      // Axe is I/O-bound (page load + DOM analysis), so overlapping tabs is safe.
      const concurrency = this.auditStrategy.concurrency;
      if (this.pagesToVisit.length > 0) {
        console.log(`\n  Phase 2: Accessibility audits (${this.pagesToVisit.length} pages, ${concurrency} concurrent)...`);
        while (this.pagesToVisit.length > 0 && this.visitedPages.size < this.MAX_PAGES) {
          const batch = this.pagesToVisit.splice(0, concurrency);
          await Promise.all(batch.map(url =>
            this.auditPage(url, viewport, viewport === 'desktop', 'accessibility-only')
          ));
        }
      }
      
      if (this.visitedPages.size >= this.MAX_PAGES) {
        console.log(`  Reached maximum page limit (${this.MAX_PAGES}). Stopping crawl.`);
      }

      // Retry pass: one more attempt for pages that errored during this viewport
      const failedKeys = [...this.failedPages.keys()].filter(k => k.endsWith(`::${viewport}`));
      if (failedKeys.length > 0) {
        console.log(`\n  Retrying ${failedKeys.length} failed page(s)...`);
        failedKeys.forEach(k => this.failedPages.delete(k));
        const failedUrls = failedKeys.map(k => k.slice(0, k.lastIndexOf('::')));
        for (const url of failedUrls) {
          const tier = this.fullAuditUrls.has(url) ? 'full' : 'accessibility-only';
          await this.auditPage(url, viewport, false, tier);
        }
      }

      // Save discovered URLs after desktop audit
      if (viewport === 'desktop') {
        discoveredUrls = Array.from(this.visitedPages);
        if (this.auditStrategy.viewports === 'both') {
          console.log(`  Discovered ${discoveredUrls.length} pages for mobile audit`);
        }
      }

      const brokenLinks = this.linkChecker.getBrokenLinks();
      await this.csvWriter.writeBrokenLinks(brokenLinks, viewport);

      // Write detailed violations CSV
      const aggregatedViolations = this.violationsAggregator.getAggregatedViolations();
      await this.csvWriter.writeViolationDetails(aggregatedViolations, viewport);
      
      // HTML reports are now written immediately as each page is processed

      // Collect data for PDF
      if (viewport === 'desktop') {
        pdfData.desktop.pageReports = [...this.pageReports];
        pdfData.desktop.violations = [...aggregatedViolations];
        pdfData.desktop.brokenLinks = [...brokenLinks];
      } else {
        pdfData.mobile.pageReports = [...this.pageReports];
        pdfData.mobile.violations = [...aggregatedViolations];
        pdfData.mobile.brokenLinks = [...brokenLinks];
      }

      await this.closeBrowser();
      
      const cacheStats = this.linkChecker.getCacheStats();
      console.log(`\n${viewport.toUpperCase()} audit complete!`);
      console.log(`  Pages audited: ${this.visitedPages.size}`);
      console.log(`  Broken links found: ${brokenLinks.length}`);
      console.log(`  Accessibility issues found: ${aggregatedViolations.length} unique types`);
      console.log(`  Links checked (cached): ${cacheStats.total}`);
    }

    // Collect any pages that still failed after the retry pass
    const allFailedPages: FailedPageEntry[] = [...this.failedPages.entries()].map(([key, error]) => {
      const sep = key.lastIndexOf('::');
      return { url: key.slice(0, sep), viewport: key.slice(sep + 2), error };
    });
    pdfData.failedPages = allFailedPages;

    if (allFailedPages.length > 0) {
      console.log(`\n  ⚠️  ${allFailedPages.length} page(s) could not be audited after retry:`);
      allFailedPages.forEach(p => console.log(`    ${p.viewport}: ${p.url} — ${p.error}`));
      await this.csvWriter.writeFailedPages(allFailedPages);
    }

    // Save report data as JSON for --rebuild-report
    const reportDataPath = path.join(this.csvWriter.getResultsDirectory(), 'report-data.json');
    fs.writeFileSync(reportDataPath, JSON.stringify(pdfData, null, 2));
    console.log(`  Report data saved to: ${reportDataPath}`);

    // Generate PDF report
    console.log('\nGenerating PDF report...');
    const pdfGenerator = new PDFReportGenerator(this.csvWriter.getResultsDirectory(), this.domain);
    try {
      await pdfGenerator.generateReport(pdfData);
    } catch (pdfError: any) {
      console.log(`  ⚠️  PDF generation failed: ${pdfError.message?.slice(0, 100)}. HTML report still saved.`);
    }

    console.log(`\n✅ Audit complete for ${this.domain}`);
    console.log(`Results saved to: ${this.csvWriter.getResultsDirectory()}`);
    
    // Clean up memory
    this.cleanup();
  }
  
  private writeHtmlReportForPage(url: string, axeResults: AxeResults, viewport: string): void {
    const htmlDir = path.join(this.csvWriter.getResultsDirectory(), 'html-reports', viewport);
    
    if (!fs.existsSync(htmlDir)) {
      fs.mkdirSync(htmlDir, { recursive: true });
    }
    
    const sanitizedUrl = url
      .replace(/^https?:\/\//, '')
      .replace(/[^a-z0-9]/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
    
    const fileName = `${this.visitedPages.size}-${sanitizedUrl}.html`;
    const filePath = path.join(htmlDir, fileName);
    
    try {
      // axe-html-reporter has strict schema requirements, missing fields cause crashes
      const safeViolations = (axeResults.violations || []).map(v => ({
        id: v.id || 'unknown',
        impact: v.impact || 'minor',
        tags: v.tags || [],
        description: v.description || 'No description available',
        help: v.help || 'No help available',
        helpUrl: v.helpUrl || '#',
        nodes: (v.nodes || []).map(node => ({
          ...node,
          target: node.target || [],
          html: node.html || '',
          impact: node.impact || v.impact || 'minor',
          any: node.any || [],
          all: node.all || [],
          none: node.none || [],
          failureSummary: node.failureSummary || ''
        }))
      }));
      
      const { createHtmlReport } = require('axe-html-reporter');
      const htmlContent = createHtmlReport({
        results: {
          violations: safeViolations,
          passes: [],
          incomplete: [],
          inapplicable: []
        },
        options: {
          projectKey: 'Site Audit',
          customSummary: `<b>Page:</b> ${url}<br><b>Viewport:</b> ${viewport}<br><b>Violations Found:</b> ${safeViolations.length}`,
          doNotCreateReportFile: true
        }
      });
      
      if (htmlContent) {
        fs.writeFileSync(filePath, htmlContent);
      } else {
        console.error(`    HTML report was empty for ${url}`);
      }
    } catch (error: any) {
      console.error(`    HTML report was not created due to the error ${error.message}`);
      // Fallback ensures we always have some output even if the reporter fails
      const fallbackHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>Accessibility Report - Error</title></head>
        <body>
          <h1>Accessibility Report</h1>
          <p><strong>Page:</strong> ${url}</p>
          <p><strong>Viewport:</strong> ${viewport}</p>
          <p><strong>Error:</strong> Failed to generate detailed report</p>
          <p><strong>Violations Found:</strong> ${axeResults.violations?.length || 0}</p>
          <pre>${JSON.stringify(axeResults.violations?.slice(0, 2), null, 2)}</pre>
        </body>
        </html>
      `;
      fs.writeFileSync(filePath, fallbackHtml);
    }
  }
  
  private cleanup(): void {
    // Explicit cleanup helps Node's GC reclaim memory between site audits
    this.visitedPages.clear();
    this.pagesToVisit = [];
    this.pageReports = [];
    this.failedPages.clear();
    this.linkChecker.clearBrokenLinks();
    this.linkChecker.clearCache();
    this.violationsAggregator.clear();
    
    // Ensure browser is closed
    if (this.browser) {
      this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}