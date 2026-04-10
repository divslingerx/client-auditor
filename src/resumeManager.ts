import * as fs from 'fs';
import * as path from 'path';

export class ResumeManager {
  private progressFile: string;
  // Tracks completed page+viewport combinations to avoid re-auditing after crashes
  private completedPages: Set<string> = new Set();
  // Track all discovered URLs so mobile can use them even after restart
  private discoveredUrls: Set<string> = new Set();
  
  constructor(domain: string) {
    const resultsDir = path.join(process.cwd(), 'results', domain.replace(/[<>:"/\\|?*]/g, '-'));
    this.progressFile = path.join(resultsDir, '.progress.json');
    this.loadProgress();
  }
  
  private loadProgress(): void {
    if (fs.existsSync(this.progressFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.progressFile, 'utf-8'));
        this.completedPages = new Set(data.completedPages || []);
        this.discoveredUrls = new Set(data.discoveredUrls || []);
        console.log(`  Resuming audit - found ${this.completedPages.size} completed pages`);
      } catch (error) {
        console.log('  Starting fresh audit (no valid progress file found)');
      }
    }
  }
  
  saveProgress(): void {
    const data = {
      completedPages: Array.from(this.completedPages),
      discoveredUrls: Array.from(this.discoveredUrls),
      lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(this.progressFile, JSON.stringify(data, null, 2));
  }
  
  isPageCompleted(url: string, viewport: string): boolean {
    // Viewport-specific tracking since mobile/desktop can have different issues
    return this.completedPages.has(`${url}::${viewport}`);
  }
  
  markPageCompleted(url: string, viewport: string): void {
    this.completedPages.add(`${url}::${viewport}`);
    // Immediate save ensures progress persists even if process crashes
    this.saveProgress();
  }
  
  getCompletedCount(viewport: string): number {
    return Array.from(this.completedPages).filter(p => p.endsWith(`::${viewport}`)).length;
  }
  
  clearProgress(): void {
    this.completedPages.clear();
    this.discoveredUrls.clear();
    if (fs.existsSync(this.progressFile)) {
      fs.unlinkSync(this.progressFile);
    }
  }
  
  // Add discovered URL to the list
  addDiscoveredUrl(url: string): void {
    this.discoveredUrls.add(url);
    this.saveProgress();
  }
  
  // Get all discovered URLs for mobile audit
  getDiscoveredUrls(): string[] {
    return Array.from(this.discoveredUrls);
  }
}