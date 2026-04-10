import { AxeResults } from './types';

export interface ViolationDetail {
  violationType: string;
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  description: string;
  pageUrls: string[];
  totalInstances: number;
  elements: string[]; // Sample elements affected
}

export class ViolationsAggregator {
  // Map key combines violation type and severity for unique aggregation
  private violations = new Map<string, ViolationDetail>();

  addAggregatedData(url: string, axeResults: AxeResults, viewport: string): void {
    // Memory-efficient aggregation - stores summaries not full violation data
    
    axeResults.violations.forEach(violation => {
      const key = `${violation.help}_${violation.impact}`;
      
      if (!this.violations.has(key)) {
        this.violations.set(key, {
          violationType: violation.help,
          severity: violation.impact,
          description: violation.description,
          pageUrls: [],
          totalInstances: 0,
          elements: []
        });
      }
      
      const detail = this.violations.get(key)!;
      
      // Add page URL if not already in list
      const pageIdentifier = `${url} (${viewport})`;
      if (!detail.pageUrls.includes(pageIdentifier)) {
        detail.pageUrls.push(pageIdentifier);
      }
      
      // Add instance count
      detail.totalInstances += violation.nodes.length;
      
      // Limited samples prevent memory bloat on sites with many violations
      violation.nodes.slice(0, 3).forEach(node => {
        const selector = node.target?.join(' > ') || 'Unknown element';
        const elementDesc = `${pageIdentifier}: ${selector}`;
        // Cap at 10 total examples across all pages for readability
        if (detail.elements.length < 10) {
          detail.elements.push(elementDesc);
        }
      });
    });
  }

  getAggregatedViolations(): ViolationDetail[] {
    return Array.from(this.violations.values())
      .sort((a, b) => {
        // Priority order: critical issues first, then by frequency
        const severityOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
        const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
        if (severityDiff !== 0) return severityDiff;
        return b.totalInstances - a.totalInstances;
      });
  }

  generateNoteSummary(axeResults: AxeResults): string {
    const violations = axeResults.violations;
    if (violations.length === 0) return 'No accessibility issues';

    // Group by severity
    const bySeverity = violations.reduce((acc, v) => {
      if (!acc[v.impact]) acc[v.impact] = [];
      acc[v.impact].push(v.help);
      return acc;
    }, {} as Record<string, string[]>);

    const notes: string[] = [];
    
    // Surface high-impact issues in summary for quick scanning
    ['critical', 'serious'].forEach(severity => {
      if (bySeverity[severity] && bySeverity[severity].length > 0) {
        const issueList = bySeverity[severity].slice(0, 2).join(', ');
        const count = bySeverity[severity].length;
        notes.push(`${severity.charAt(0).toUpperCase() + severity.slice(1)}: ${issueList}${count > 2 ? ` (+${count - 2} more)` : ''}`);
      }
    });

    return notes.slice(0, 2).join('; ') || 'Minor accessibility issues';
  }

  clear(): void {
    this.violations.clear();
  }
}