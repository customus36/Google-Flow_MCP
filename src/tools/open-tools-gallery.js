import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot, sanitizeFileName } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { navigateToSidebar, ensureProjectInContext, extractProjectId, buildProjectUrl } from '../navigation/project-navigator.js';

/** Navigate to the project's Tools section by URL.
 *  Flow relocalized/renamed its sidebar labels (Vietnamese UI), so label-based
 *  navigation is unreliable; the {project}/tools route is stable. */
async function gotoToolsSection(page) {
  if (!/\/tools(\/|$)/.test(page.url())) {
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
}

import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import { escapeRegExp } from '../utils/sanitize.js';

export async function handleOpenToolsGallery() {
  const page = getPage();
  await gotoToolsSection(page);
  await page.waitForTimeout(1000);

  const elements = await detectPageElements(page);
  const screenshot = await takeScreenshot(page, 'tools-section');

  return {
    status: 'opened',
    url: page.url(),
    title: await page.title(),
    elements,
    screenshot,
  };
}

export async function handleListTools() {
  const page = getPage();
  await gotoToolsSection(page);
  await page.waitForTimeout(1000);

  const elements = await detectPageElements(page);

  return {
    tools_found: elements,
    screenshot: await takeScreenshot(page, 'tools-section'),
  };
}

export async function handleOpenTool(args) {
  const page = getPage();
  const toolName = args.name || args.tool_name;

  if (!toolName || typeof toolName !== 'string' || !toolName.trim()) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'Tool name is required');
  }
  const safeName = toolName.trim().slice(0, 100);

  logger.info('Opening tool', { toolName: safeName, projectName: args.project_name });

  await gotoToolsSection(page);
  await page.waitForTimeout(1000);

  // Try to find and click the tool within the project's tools section.
  // Use escaped exact text to avoid selector injection via `"`.
  const toolLocator = page.locator('a, button, [class*="applet"], [role="button"], li').filter({ hasText: new RegExp(`^${escapeRegExp(safeName)}`, 'i') }).first();
  if (await toolLocator.isVisible().catch(() => false)) {
    await toolLocator.click();
    await page.waitForTimeout(3000);
  } else {
    logger.warn('Tool card not found on Tools page', { toolName: safeName });
    const flowUrl = get('flowUrl', 'https://flow.google.com/');
    const project = await ensureProjectInContext(page, {});
    const projectId = extractProjectId(project.url);
    const listUrl = projectId ? buildProjectUrl(flowUrl, projectId) + '/tools' : page.url();
    throw new FlowError(
      ErrorCodes.FLOW_PAGE_NOT_FOUND,
      'Tool not found on the Tools page (' + listUrl + '). Open that page to see the available tools.');
  }

  const elements = await detectPageElements(page);
  const shot = sanitizeFileName(`tool-${safeName}`);
  return {
    status: 'opened',
    tool: safeName,
    url: page.url(),
    elements,
    screenshot: await takeScreenshot(page, shot),
  };
}
