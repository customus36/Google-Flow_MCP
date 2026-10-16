import { get } from '../utils/config.js';
import { ensureProjectInContext, extractProjectId, buildProjectUrl } from './project-navigator.js';

/** Navigate to the project's Tools page by URL.
 *  Flow's sidebar labels are localized and get renamed between releases, so
 *  label-based navigation is unreliable; the project-scoped /tools route is stable. */
export async function gotoToolsSection(page) {
  if (/\/tools(\/|$)/.test(page.url())) return;
  const flowUrl = get('flowUrl', 'https://flow.google.com/');
  const project = await ensureProjectInContext(page, {});
  const projectId = extractProjectId(project.url);
  const baseUrl = projectId
    ? buildProjectUrl(flowUrl, projectId)
    : (project.url || flowUrl).replace(/\/+$/, '');
  await page.goto(baseUrl + '/tools', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
}
