import { Page } from 'puppeteer';
import axios from 'axios';
import { BrokenLink } from './types';
import * as cheerio from 'cheerio';

const LINK_CACHE_MAX_SIZE = 10_000;

export class LinkChecker {
  private brokenLinks: BrokenLink[] = [];
  // Cache prevents redundant HTTP requests for the same link across pages
  private checkedLinks = new Map<string, { isValid: boolean; statusCode?: number; error?: string }>();
  private baseUrl: string;
  private domain: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    const url = new URL(baseUrl);
    this.domain = url.hostname;
  }

  private isExternalLink(url: string): boolean {
    try {
      const linkUrl = new URL(url, this.baseUrl);
      return linkUrl.hostname !== this.domain;
    } catch {
      return false;
    }
  }

  private normalizeUrl(url: string): string {
    try {
      const normalized = new URL(url, this.baseUrl);
      normalized.hash = '';
      return normalized.href;
    } catch {
      return url;
    }
  }

  private getLinkType(element: any, href: string): BrokenLink['linkType'] {
    if (element.name === 'img' || element.attribs?.src) {
      return 'image';
    }
    if (href?.startsWith('#')) {
      return 'anchor';
    }
    if (href?.startsWith('tel:')) {
      return 'tel';
    }
    if (href?.startsWith('mailto:')) {
      return 'mailto';
    }
    if (href?.match(/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|txt|csv)$/i)) {
      return 'document';
    }
    if (href?.match(/^https?:\/\//)) {
      return 'url';
    }
    return 'other';
  }

  async checkLink(url: string, linkType: BrokenLink['linkType']): Promise<{ isValid: boolean; statusCode?: number; error?: string }> {
    // Include linkType in cache key as validation logic differs per type
    const cacheKey = `${linkType}:${url}`;
    
    // Check if we've already tested this link
    if (this.checkedLinks.has(cacheKey)) {
      return this.checkedLinks.get(cacheKey)!;
    }

    let result: { isValid: boolean; statusCode?: number; error?: string };

    if (linkType === 'tel') {
      const telRegex = /^tel:[\+]?[\d\s\-\(\)]+$/;
      result = { isValid: telRegex.test(url) };
    } else if (linkType === 'mailto') {
      const emailRegex = /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/;
      result = { isValid: emailRegex.test(url) };
    } else if (linkType === 'anchor') {
      // Anchors are validated per-page since same ID can exist on different pages
      return { isValid: true };
    } else {
      try {
        const normalizedUrl = this.normalizeUrl(url);
        
        // Skip external link validation to avoid rate limiting and improve performance
        if (this.isExternalLink(normalizedUrl)) {
          result = { isValid: true };
        } else {
          // HEAD requests are faster than GET for checking link validity
          // Some servers reject HEAD requests, so we'll fall back to GET if needed
          let response;
          try {
            response = await axios.head(normalizedUrl, {
              timeout: 3000, // Short timeout to keep audit speed reasonable
              validateStatus: () => true,
              maxRedirects: 3,
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; SiteAuditor/1.0)' // Some servers require User-Agent
              }
            });
          } catch (headError: any) {
            // Fallback to GET for servers that don't support HEAD
            // Common cases: 405 Method Not Allowed, ECONNREFUSED, or network errors
            if (headError.code === 'ECONNREFUSED' || 
                headError.code === 'ENOTFOUND' ||
                headError.code === 'ETIMEDOUT' ||
                headError.response?.status === 405) {
              try {
                response = await axios.get(normalizedUrl, {
                  timeout: 3000,
                  validateStatus: () => true,
                  maxRedirects: 3,
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; SiteAuditor/1.0)',
                    'Range': 'bytes=0-1024' // Request only first 1KB to save bandwidth
                  }
                });
              } catch (getError: any) {
                // Only log if both HEAD and GET failed
                throw new Error(`Link check failed: ${getError.message || 'Unknown error'}`);
              }
            } else {
              throw headError;
            }
          }

          const isValid = response.status >= 200 && response.status < 400;
          result = { isValid, statusCode: response.status };
        }
      } catch (error: any) {
        result = { isValid: false, error: error.message };
      }
    }

    // Cache the result — evict oldest entry (FIFO) when cap is reached
    if (this.checkedLinks.size >= LINK_CACHE_MAX_SIZE) {
      const firstKey = this.checkedLinks.keys().next().value;
      this.checkedLinks.delete(firstKey!);
    }
    this.checkedLinks.set(cacheKey, result);
    return result;
  }

  async checkPageLinks(page: Page, pageUrl: string, viewport: 'desktop' | 'mobile'): Promise<BrokenLink[]> {
    const html = await page.content();
    const $ = cheerio.load(html);
    const links: Array<{ url: string; text?: string; element: any }> = [];
    let checkedCount = 0;

    $('a[href]').each((_, element) => {
      const href = $(element).attr('href');
      if (href) {
        links.push({
          url: href,
          text: $(element).text().trim(),
          element: element
        });
      }
    });

    $('img[src]').each((_, element) => {
      const src = $(element).attr('src');
      if (src) {
        links.push({
          url: src,
          text: $(element).attr('alt') || '',
          element: element
        });
      }
    });

    // Pre-filter broken anchors using cheerio DOM to avoid Puppeteer evaluation
    $('[href^="#"]').each((_, element) => {
      const href = $(element).attr('href');
      if (href && href !== '#') {
        const targetId = href.substring(1);
        // Check both id and name attributes for anchor targets
        const targetExists = $(`#${targetId}`).length > 0 || $(`[name="${targetId}"]`).length > 0;
        if (!targetExists) {
          links.push({
            url: href,
            text: $(element).text().trim(),
            element: element
          });
        }
      }
    });

    const brokenLinksForPage: BrokenLink[] = [];
    console.log(`    Found ${links.length} links to check`);

    for (const link of links) {
      const linkType = this.getLinkType(link.element, link.url);
      checkedCount++;
      
      // Progress updates help monitor long-running checks on large pages
      if (checkedCount % 10 === 0) {
        console.log(`    Checked ${checkedCount}/${links.length} links...`);
      }
      
      if (linkType === 'anchor' && link.url !== '#') {
        const targetId = link.url.substring(1);
        // Double-check anchor existence in live DOM (handles dynamic content)
        const targetExists = await page.evaluate((id: string) => {
          return !!document.getElementById(id) || !!document.querySelector(`[name="${id}"]`);
        }, targetId);

        if (!targetExists) {
          brokenLinksForPage.push({
            pageUrl,
            linkUrl: link.url,
            linkType,
            linkText: link.text,
            errorMessage: 'Anchor target not found',
            viewport
          });
        }
        continue;
      }

      // External validation would slow audits and trigger rate limits
      if (this.isExternalLink(link.url)) {
        continue;
      }

      const checkResult = await this.checkLink(link.url, linkType);
      
      if (!checkResult.isValid) {
        brokenLinksForPage.push({
          pageUrl,
          linkUrl: link.url,
          linkType,
          linkText: link.text,
          statusCode: checkResult.statusCode,
          errorMessage: checkResult.error,
          viewport
        });
      }
    }

    this.brokenLinks.push(...brokenLinksForPage);
    return brokenLinksForPage;
  }

  getBrokenLinks(): BrokenLink[] {
    return this.brokenLinks;
  }

  clearBrokenLinks(): void {
    this.brokenLinks = [];
  }

  clearCache(): void {
    this.checkedLinks.clear();
  }

  getCacheStats(): { total: number; cached: number } {
    return {
      total: this.checkedLinks.size,
      cached: this.checkedLinks.size
    };
  }
}