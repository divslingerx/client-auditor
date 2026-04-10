import axios from 'axios';
import * as cheerio from 'cheerio';

export interface SitemapUrl {
  loc: string;
  priority?: number;
  changefreq?: string;
  lastmod?: string;
}

export class SitemapParser {
  private siteOrigin: string;

  constructor(siteOrigin: string) {
    // Always use the origin (scheme + host) so paths in the URL don't break sitemap lookup
    this.siteOrigin = new URL(siteOrigin).origin;
  }

  /**
   * Fetches and parses sitemap.xml from the site
   * Tries common sitemap locations if not found at default
   */
  async parseSitemap(): Promise<SitemapUrl[]> {
    const sitemapUrls = [
      `${this.siteOrigin}/sitemap.xml`,
      `${this.siteOrigin}/sitemap_index.xml`,
      `${this.siteOrigin}/sitemap1.xml`,
      `${this.siteOrigin}/wp-sitemap.xml`, // WordPress default
    ];

    for (const sitemapUrl of sitemapUrls) {
      try {
        console.log(`  Attempting to fetch sitemap: ${sitemapUrl}`);
        const response = await axios.get(sitemapUrl, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SiteAuditor/1.0; +http://example.com/bot)'
          }
        });

        if (response.status === 200) {
          console.log(`  ✓ Found sitemap at ${sitemapUrl}`);
          return this.parseXml(response.data);
        }
      } catch (error: any) {
        // Continue to next URL
        if (error.response?.status !== 404) {
          console.log(`    Failed to fetch ${sitemapUrl}: ${error.message?.slice(0, 50)}`);
        }
      }
    }

    console.log('  No sitemap.xml found, will rely on crawling');
    return [];
  }

  /**
   * Parses sitemap XML and handles both regular sitemaps and sitemap indexes
   */
  private async parseXml(xml: string): Promise<SitemapUrl[]> {
    const $ = cheerio.load(xml, { xmlMode: true });
    const urls: SitemapUrl[] = [];

    // Check if this is a sitemap index (contains other sitemaps)
    const sitemapTags = $('sitemap');
    if (sitemapTags.length > 0) {
      console.log(`  Found sitemap index with ${sitemapTags.length} sub-sitemaps`);

      // Parse each sub-sitemap
      for (let i = 0; i < Math.min(sitemapTags.length, 10); i++) { // Limit to 10 sub-sitemaps
        const loc = $(sitemapTags[i]).find('loc').text().trim();
        if (loc) {
          try {
            const response = await axios.get(loc, {
              timeout: 10000,
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; SiteAuditor/1.0)'
              }
            });
            const subUrls = this.parseUrlSet(response.data);
            urls.push(...subUrls);
            console.log(`    Loaded ${subUrls.length} URLs from ${loc}`);
          } catch (error: any) {
            console.log(`    Failed to fetch sub-sitemap ${loc}: ${error.message?.slice(0, 50)}`);
          }
        }
      }
    } else {
      // Regular sitemap with URLs
      urls.push(...this.parseUrlSet(xml));
    }

    console.log(`  Total URLs found in sitemap: ${urls.length}`);
    return urls;
  }

  /**
   * Parses a single sitemap's URL entries
   */
  private parseUrlSet(xml: string): SitemapUrl[] {
    const $ = cheerio.load(xml, { xmlMode: true });
    const urls: SitemapUrl[] = [];

    $('url').each((_, elem) => {
      const loc = $(elem).find('loc').text().trim();
      const priorityText = $(elem).find('priority').text().trim();
      const changefreq = $(elem).find('changefreq').text().trim();
      const lastmod = $(elem).find('lastmod').text().trim();

      if (loc) {
        urls.push({
          loc,
          priority: priorityText ? parseFloat(priorityText) : undefined,
          changefreq: changefreq || undefined,
          lastmod: lastmod || undefined
        });
      }
    });

    return urls;
  }

  /**
   * Gets high-priority URLs from sitemap (priority >= 0.8)
   */
  getHighPriorityUrls(sitemapUrls: SitemapUrl[]): string[] {
    return sitemapUrls
      .filter(url => (url.priority || 0.5) >= 0.8)
      .map(url => url.loc);
  }

  /**
   * Gets all URLs from sitemap
   */
  getAllUrls(sitemapUrls: SitemapUrl[]): string[] {
    return sitemapUrls.map(url => url.loc);
  }
}
