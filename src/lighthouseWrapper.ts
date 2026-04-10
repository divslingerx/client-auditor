import { fork, ChildProcess } from 'child_process';
import * as path from 'path';
import { Page } from 'puppeteer';
import { LighthouseResults } from './types';

/**
 * Resolve the worker script path. In dev mode (ts-node), we fork the .ts file
 * with ts-node/register. In production (compiled), we fork the .js file directly.
 */
function getWorkerPath(): { script: string; execArgv: string[] } {
  // Check if we're running under ts-node
  const isTsNode = !!(process as any)[Symbol.for('ts-node.register.instance')] ||
                    process.execArgv.some(arg => arg.includes('ts-node'));

  if (isTsNode) {
    return {
      script: path.join(__dirname, 'lighthouseWorker.ts'),
      execArgv: ['-r', 'ts-node/register']
    };
  }

  return {
    script: path.join(__dirname, 'lighthouseWorker.js'),
    execArgv: []
  };
}

/**
 * Run Lighthouse in a child process to isolate memory.
 *
 * Each Lighthouse run creates ~200-500MB of traces, CDP sessions, and artifacts.
 * By forking a child process, all that memory is reclaimed by the OS when the
 * child exits — the main process only ever holds the tiny scores object.
 */
function runInChildProcess(
  url: string,
  port: number,
  viewport: 'desktop' | 'mobile',
  minimal: boolean = false,
  timeoutMs: number = 90000
): Promise<LighthouseResults | null> {
  return new Promise((resolve) => {
    const { script, execArgv } = getWorkerPath();

    let child: ChildProcess;
    try {
      child = fork(script, [], {
        execArgv,
        // Don't inherit the parent's 4GB heap — the worker only needs enough for one run
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=2048' },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
      });
    } catch (forkError: any) {
      console.log(`    Failed to fork Lighthouse worker: ${forkError.message?.slice(0, 100)}`);
      resolve(null);
      return;
    }

    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.log(`    Lighthouse timeout after ${timeoutMs / 1000}s`);
        child.kill('SIGKILL');
        resolve(null);
      }
    }, timeoutMs);

    // Forward worker stdout/stderr to parent console
    child.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.log(`    [LH] ${msg}`);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      // Filter out noisy deprecation warnings and common non-errors
      if (msg && !msg.includes('DeprecationWarning') && !msg.includes('ExperimentalWarning')) {
        console.log(`    [LH] ${msg}`);
      }
    });

    child.on('message', (result: any) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);

        if (result.success && result.scores) {
          resolve({
            categories: {
              performance: { score: result.scores.performance },
              accessibility: { score: result.scores.accessibility },
              'best-practices': { score: result.scores['best-practices'] },
              seo: { score: result.scores.seo }
            }
          });
        } else {
          if (result.error) {
            console.log(`    Lighthouse error: ${result.error.slice(0, 100)}`);
          }
          resolve(null);
        }
      }
    });

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        console.log(`    Lighthouse worker error: ${err.message?.slice(0, 100)}`);
        resolve(null);
      }
    });

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (code !== 0) {
          console.log(`    Lighthouse worker exited with code ${code}`);
        }
        resolve(null);
      }
    });

    // Send the job to the worker
    child.send({ url, port, viewport, minimal });
  });
}

/**
 * Safe wrapper around Lighthouse — forks a child process per run.
 * Returns null if Lighthouse fails for any reason.
 */
export async function runLighthouseSafely(
  url: string,
  page: Page,
  viewport: 'desktop' | 'mobile'
): Promise<LighthouseResults | null> {
  try {
    const browser = page.browser();
    const wsEndpoint = browser.wsEndpoint();
    const port = parseInt(new URL(wsEndpoint).port, 10);

    return await runInChildProcess(url, port, viewport, false, 90000);
  } catch (error: any) {
    console.log(`    Lighthouse wrapper error: ${error.message?.slice(0, 100) || error}`);
    return null;
  }
}

/**
 * Minimal Lighthouse run — forks a child process with reduced audits.
 */
export async function runLighthouseMinimal(
  url: string,
  port?: string
): Promise<LighthouseResults | null> {
  if (!port) {
    console.log('    Minimal Lighthouse: no port available');
    return null;
  }

  try {
    return await runInChildProcess(url, parseInt(port, 10), 'desktop', true, 45000);
  } catch (error: any) {
    console.log(`    Minimal Lighthouse failed: ${error.message?.slice(0, 100)}`);
    return null;
  }
}
