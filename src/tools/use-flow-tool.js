import { getPage } from '../browser/connect.js';
import { takeScreenshot, sanitizeFileName } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import { escapeRegExp } from '../utils/sanitize.js';
import { ensureProjectInContext, navigateToSidebar } from '../navigation/project-navigator.js';
import { gotoToolsSection } from '../navigation/tools-section.js';

export async function handleUseFlowTool(args) {
  const page = getPage();
  const toolName = args.tool_name || args.name;

  if (!toolName || typeof toolName !== 'string' || !toolName.trim()) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'Tool name is required');
  }
  const safeName = toolName.trim().slice(0, 100);

  await ensureProjectInContext(page, {
    name: args.project_name,
    campaign: args.campaign,
  });

  // Navigate to Tools sidebar
  await gotoToolsSection(page);

  // Find the tool in the tools section (escaped exact match — no injection)
  const toolLocator = page.locator('.applet-card-main, [class*="applet-card"]').filter({ hasText: new RegExp(escapeRegExp(safeName), 'i') }).first();

  if (await toolLocator.isVisible().catch(() => false)) {
    await toolLocator.click();
    await page.waitForTimeout(3000);
  } else {
    // No slug route exists in the current Flow UI. Clicking a tool card routes
    // in-tab to /project/<id>/tool/<uuid>, so click the card and wait for that.
    const nameSpan = page.locator('.applet-name').filter({ hasText: new RegExp(escapeRegExp(safeName), 'i') }).first();
    if (await nameSpan.isVisible().catch(() => false)) {
      await nameSpan.click({ force: true }).catch(() => {});
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(500);
        if (!/\/tools(\/|$)/.test(page.url())) break;
      }
    }
    if (/\/tools(\/|$)/.test(page.url())) {
      throw new FlowError(
        ErrorCodes.FLOW_PAGE_NOT_FOUND,
        'Tool "' + safeName + '" could not be opened from the Tools page.');
    }
  }

  const elements = await detectPageElements(page);

  if (args.params && typeof args.params === 'object') {
    for (const [key, value] of Object.entries(args.params)) {
      if (typeof value === 'string') {
        const input = await page.$(
          `[name="${key}"], [placeholder="${key}"], [aria-label="${key}"]`
        );
        if (input) {
          await input.click();
          await input.fill('');
          await page.waitForTimeout(200);
          await input.type(value, { delay: 10 });
        }
      }
    }
  }

  const shotBase = sanitizeFileName(`tool-${safeName}`);

  await takeScreenshot(page, `${shotBase}-setup`);

  return {
    status: 'tool_opened',
    tool: safeName,
    url: page.url(),
    elements,
    screenshot: await takeScreenshot(page, shotBase),
  };
}
