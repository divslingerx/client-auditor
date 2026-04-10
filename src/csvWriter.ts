import * as fs from 'fs';
import * as path from 'path';
import { createObjectCsvWriter } from 'csv-writer';
import { BrokenLink, PageReport, FailedPageEntry } from './types';
import { ViolationDetail } from './violationsAggregator';

export class CSVWriter {
  private resultsDir: string;

  constructor(domain: string) {
    this.resultsDir = path.join(process.cwd(), 'results', domain.replace(/[<>:"/\\|?*]/g, '-'));
    if (!fs.existsSync(this.resultsDir)) {
      fs.mkdirSync(this.resultsDir, { recursive: true });
    }
  }

  async writeBrokenLinks(brokenLinks: BrokenLink[], viewport: 'desktop' | 'mobile'): Promise<void> {
    const csvPath = path.join(this.resultsDir, `broken-links-${viewport}.csv`);
    
    const csvWriter = createObjectCsvWriter({
      path: csvPath,
      header: [
        { id: 'pageUrl', title: 'Page URL' },
        { id: 'linkUrl', title: 'Link URL' },
        { id: 'linkType', title: 'Link Type' },
        { id: 'linkText', title: 'Link Text' },
        { id: 'statusCode', title: 'Status Code' },
        { id: 'errorMessage', title: 'Error Message' }
      ]
    });

    await csvWriter.writeRecords(brokenLinks);
    console.log(`Broken links CSV saved to: ${csvPath}`);
  }

  async appendPageReport(report: PageReport): Promise<void> {
    const csvPath = path.join(this.resultsDir, `page-reports-${report.viewport}.csv`);
    
    const fileExists = fs.existsSync(csvPath);
    
    const csvWriter = createObjectCsvWriter({
      path: csvPath,
      header: [
        { id: 'url', title: 'Page URL' },
        { id: 'criticalIssues', title: 'Critical Issues' },
        { id: 'seriousIssues', title: 'Serious Issues' },
        { id: 'moderateIssues', title: 'Moderate Issues' },
        { id: 'minorIssues', title: 'Minor Issues' },
        { id: 'performanceScore', title: 'Performance Score' },
        { id: 'accessibilityScore', title: 'Accessibility Score' },
        { id: 'bestPracticesScore', title: 'Best Practices Score' },
        { id: 'seoScore', title: 'SEO Score' },
        { id: 'notes', title: 'Notes' }
      ],
      append: fileExists
    });

    await csvWriter.writeRecords([report]);
  }

  async writeViolationDetails(violations: ViolationDetail[], viewport: 'desktop' | 'mobile'): Promise<void> {
    const csvPath = path.join(this.resultsDir, `accessibility-violations-${viewport}.csv`);
    
    const csvWriter = createObjectCsvWriter({
      path: csvPath,
      header: [
        { id: 'violationType', title: 'Issue' },
        { id: 'severity', title: 'Severity' },
        { id: 'description', title: 'Description' },
        { id: 'totalInstances', title: 'Total Instances' },
        { id: 'pageCount', title: 'Pages Affected' },
        { id: 'avgPerPage', title: 'Avg Per Page' },
        { id: 'pageUrls', title: 'Affected Pages' },
        { id: 'sampleElements', title: 'Example Elements' }
      ]
    });

    const records = violations.map(v => ({
      violationType: v.violationType,
      severity: v.severity.charAt(0).toUpperCase() + v.severity.slice(1),
      description: v.description,
      totalInstances: v.totalInstances,
      pageCount: v.pageUrls.length,
      avgPerPage: v.pageUrls.length > 0 ? (v.totalInstances / v.pageUrls.length).toFixed(1) : '—',
      pageUrls: v.pageUrls.slice(0, 5).join('; ') + (v.pageUrls.length > 5 ? ` (+${v.pageUrls.length - 5} more)` : ''),
      sampleElements: v.elements.slice(0, 3).join('; ') + (v.elements.length > 3 ? '...' : '')
    }));

    await csvWriter.writeRecords(records);
    console.log(`  Violations detail CSV saved to: ${csvPath}`);
  }

  async writeFailedPages(failedPages: FailedPageEntry[]): Promise<void> {
    if (failedPages.length === 0) return;

    const byViewport = failedPages.reduce((acc, p) => {
      if (!acc[p.viewport]) acc[p.viewport] = [];
      acc[p.viewport].push(p);
      return acc;
    }, {} as Record<string, FailedPageEntry[]>);

    for (const [viewport, pages] of Object.entries(byViewport)) {
      const csvPath = path.join(this.resultsDir, `failed-pages-${viewport}.csv`);
      const csvWriter = createObjectCsvWriter({
        path: csvPath,
        header: [
          { id: 'url', title: 'Page URL' },
          { id: 'viewport', title: 'Viewport' },
          { id: 'error', title: 'Error' }
        ]
      });
      await csvWriter.writeRecords(pages);
      console.log(`  Failed pages CSV saved to: ${csvPath}`);
    }
  }

  getResultsDirectory(): string {
    return this.resultsDir;
  }
}