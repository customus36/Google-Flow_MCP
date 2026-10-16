import { getPage } from '../browser/connect.js';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { getOutputDir } from '../utils/file-manager.js';
import { jobQueue } from '../queue/job-queue.js';
import fs from 'fs/promises';
import path from 'path';

// Extension sets from the P0-3 plan (.mp4/.webm → video; .png/.jpg/.webp
// → image; .jpeg included as the same format as .jpg). Anything else
// falls through to job-type routing, then to the neutral other/ bucket.
const VIDEO_EXTS = new Set(['mp4', 'webm']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp']);

/**
 * Pure routing decision for a download (P0-3), exported for unit tests.
 * Precedence: filename extension (ground truth about the bytes) →
 * originating job type → neutral 'other' fallback (never images/).
 */
export function resolveDownloadKind({ suggestedFilename = '', jobType = null } = {}) {
  const base = String(suggestedFilename).split('?')[0].split('#')[0];
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  if (VIDEO_EXTS.has(ext)) return { kind: 'video', detectedFrom: 'filename' };
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', detectedFrom: 'filename' };
  if (jobType === 'video_generation') return { kind: 'video', detectedFrom: 'job' };
  if (jobType === 'image_generation') return { kind: 'image', detectedFrom: 'job' };
  return { kind: 'other', detectedFrom: 'fallback' };
}

// Content-Type -> file extension for media fetched off the network.
const CT_EXT = {
  'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/gif': 'gif', 'image/avif': 'avif', 'video/mp4': 'mp4', 'video/webm': 'webm',
};

// Hard ceiling so a stray video URL can never be buffered as a giant base64 blob.
const MAX_FETCH_BYTES = 40 * 1024 * 1024;

/**
 * Current Flow serves every generated asset from https://flow.google.com/asb/<token>
 * and renders it in the project grid as <img alt="Tile displaying a user's image">.
 *
 * The click-a-button path below can only ever return 'download_initiated' when the
 * browser is attached with chromium.connectOverCDP(): that connection does not
 * install Playwright's download handling, so no 'download' event is ever emitted
 * even when Chrome really does save the file. Fetching the bytes out of the
 * authenticated page is therefore the reliable route.
 *
 * Returns { path, bytes, contentType, source } or null when nothing is fetchable.
 */
async function fetchLatestMedia(page) {
  const candidates = await page.evaluate(() => Array.from(document.querySelectorAll('img'))
    .filter(i => /\/asb\//.test(i.src || ''))
    .map(i => ({ src: i.src, alt: i.alt || '', w: i.naturalWidth, h: i.naturalHeight }))
    .filter(i => i.w >= 200 && i.h >= 200));

  if (!candidates.length) return null;

  // Flow renders the newest generation first in the project grid.
  const pick = candidates[0];
  // A trailing '=sNNNN-rw' is a Google image size hint. Replace it with '=s0'
  // to request the ORIGINAL full-resolution asset. Do NOT simply strip the
  // hint: measured against the live endpoint that returns a 512x286 rendition,
  // while '=s0' returns the true 1376x768 original.
  const mediaUrl = pick.src.includes('=')
    ? pick.src.replace(/=[^=]*$/, '=s0')
    : `${pick.src}=s0`;

  const res = await page.evaluate(async (u) => {
    try {
      const r = await fetch(u, { credentials: 'include' });
      if (!r.ok) return { ok: false, status: r.status };
      const buf = await r.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.length > 41943040) return { ok: false, status: r.status, tooLarge: bytes.length };
      let s = '';
      const CHUNK = 8192;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
      }
      return { ok: true, status: r.status, ct: r.headers.get('content-type'), len: bytes.length, b64: btoa(s) };
    } catch (e) { return { ok: false, err: e.message }; }
  }, mediaUrl);

  if (!res || !res.ok || !res.b64) return null;

  const mime = String(res.ct || '').split(';')[0].trim().toLowerCase();
  const ext = CT_EXT[mime] || 'bin';
  const kind = (ext === 'mp4' || ext === 'webm') ? 'video' : 'image';
  const dir = getOutputDir(kind);
  const savePath = path.join(dir, `${Date.now()}_flow-latest.${ext}`);
  await fs.writeFile(savePath, Buffer.from(res.b64, 'base64'));
  logger.info('Media fetched over the network', { path: savePath, mime, bytes: res.len, sourceAlt: pick.alt });
  return { path: savePath, bytes: res.len, contentType: mime, source: 'network' };
}

export async function handleDownloadLatest() {
  const page = getPage();
  logger.info('Attempting to download latest result');

  try {
    // Primary path: pull the bytes out of the authenticated session.
    const fetched = await fetchLatestMedia(page);
    if (fetched) {
      return {
        status: 'downloaded',
        message: 'Latest media saved.',
        path: fetched.path,
        bytes: fetched.bytes,
        contentType: fetched.contentType,
        kind: fetched.contentType.startsWith('video/') ? 'video' : 'image',
        detectedFrom: 'network',
      };
    }

    // Current Flow has no download control on the project page: clicking the
    // newest result tile opens the media EDITOR at /project/<id>/edit/<uuid>,
    // which exposes [aria-label*="Download"]. Open it before giving up.
    let downloadBtnLocator = page.locator('button:has-text("Download"), [aria-label*="download" i]').first();
    let downloadBtnVisible = await downloadBtnLocator.isVisible().catch(() => false);
    if (!downloadBtnVisible) {
      const tile = page.locator('img[alt*="Tile displaying" i], img[src*="/asb/"]').first();
      if (await tile.isVisible().catch(() => false)) {
        await tile.click().catch(() => {});
        await page.waitForTimeout(4000);
        downloadBtnLocator = page.locator('[aria-label*="Download" i], button:has-text("Download")').first();
        downloadBtnVisible = await downloadBtnLocator.isVisible().catch(() => false);
        if (downloadBtnVisible) logger.info('Download control found on media editor page');
      }
    }

    if (!downloadBtnVisible) {
      // Fallback: some builds hide Download inside a "More options" menu.
      const moreBtn = page.locator('[aria-label*="More options" i], button.mat-mdc-menu-trigger').first();
      if (await moreBtn.isVisible().catch(() => false)) {
        await moreBtn.click().catch(() => {});
        await page.waitForTimeout(1500);
        const menuItem = page.locator('.cdk-overlay-pane').getByText(/download/i).first();
        if (await menuItem.isVisible().catch(() => false)) {
          logger.info('Download found inside More-options menu');
          downloadBtnLocator = menuItem;
          downloadBtnVisible = true;
        }
      }
    }
    if (!downloadBtnVisible) {
      await takeScreenshot(page, 'download-btn-not-found');
      return { status: 'not_found', message: 'No download button found on current page' };
    }

    const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    await downloadBtnLocator.click();
    const download = await downloadPromise;
    if (!download) {
      // No download event (e.g. opens preview instead) — report honestly.
      await takeScreenshot(page, 'download-no-event');
      return { status: 'download_initiated', message: 'Download button clicked, but no download event was observed. Check the project page.' };
    }
    const suggested = download.suggestedFilename() || `flow-download-${Date.now()}`;
    // P0-3: route by actual filename/job type instead of hardcoded images/.
    const jobType = jobQueue.getCurrentJob()?.type
      ?? jobQueue.getStatus(1).history[0]?.type
      ?? null;
    const { kind, detectedFrom } = resolveDownloadKind({ suggestedFilename: suggested, jobType });
    const dir = getOutputDir(kind);
    const safe = suggested.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 120);
    const savePath = path.join(dir, `${Date.now()}_${safe}`);
    await download.saveAs(savePath);
    logger.info('Download saved', { path: savePath, kind, detectedFrom });
    return { status: 'downloaded', message: 'Download saved.', path: savePath, kind, detectedFrom };
  } catch (err) {
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Download failed: ${err.message}`);
  }
}
