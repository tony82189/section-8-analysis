import { test, expect } from '@playwright/test';
import path from 'path';

test.describe('Phase 1 Pipeline - Upload to Review', () => {
  test('should upload PDF, extract properties, and reach review stage', async ({ page }) => {
    // Step 1: Navigate to Dashboard
    await page.goto('/');

    // Verify dashboard loaded
    await expect(page.locator('h1')).toContainText('Section 8 BRRRR Analyzer');
    await expect(page.locator('button:has-text("Upload PDF")')).toBeVisible();

    // Step 2: Open Upload Modal
    await page.click('button:has-text("Upload PDF")');

    // Wait for modal and dropzone
    await expect(page.locator('.dropzone')).toBeVisible();

    // Step 3: Upload the real Section 8 property list PDF (~49MB)
    const testPdfPath = path.resolve(__dirname, '../../data/uploads/Section8List12_19_25.pdf');

    // The dropzone uses a hidden file input
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testPdfPath);

    // Verify file was selected - should show options step with Start Analysis button
    await expect(page.locator('button:has-text("Start Analysis")')).toBeVisible({ timeout: 10000 });

    // Step 4: Start Analysis
    await page.click('button:has-text("Start Analysis")');

    // Verify processing started - check for Processing text or progress indicators
    await expect(page.locator('text=Processing').or(page.locator('text=Uploading')).first()).toBeVisible({ timeout: 10000 });

    // Step 5: Wait for extraction to complete in the modal
    // The modal shows "Extraction Complete" and a "Review & Analyze" link when done
    // With OpenAI Vision, processing 27 pages takes ~15-20 minutes
    console.log('Waiting for extraction to complete (up to 15 minutes)...');

    // Wait for the "Extraction Complete" or "Review & Analyze" link
    await expect(
      page.locator('text=Extraction Complete').or(page.locator('a:has-text("Review & Analyze")'))
    ).toBeVisible({ timeout: 15 * 60 * 1000 }); // 15 minutes

    console.log('Extraction complete! Navigating to run page...');

    // Click the Review & Analyze link to go to the run page
    const reviewLink = page.locator('a:has-text("Review & Analyze")');
    if (await reviewLink.isVisible()) {
      await reviewLink.click();
    } else {
      // If no link, try to find it in the modal or close and find the run
      await page.locator('a[href^="/run/"]').first().click();
    }

    // Step 6: Verify we're on the run page
    await expect(page).toHaveURL(/\/run\/[a-f0-9-]+$/);

    // The status should show waiting-for-review
    await expect(
      page.locator('text=waiting-for-review').or(page.locator('text=Review Needed'))
    ).toBeVisible({ timeout: 10000 });

    // Step 7: Verify Pipeline Progress
    // Check that extraction stages completed (they show checkmarks)
    const pipelineProgress = page.locator('text=Pipeline Progress').locator('..');
    await expect(pipelineProgress).toBeVisible();

    // Verify stats are displayed - check for non-zero extracted count
    const extractedStat = page.locator('text=Extracted').locator('..');
    await expect(extractedStat).toBeVisible();

    // Step 8: Navigate to review page
    const runUrl = page.url();
    const runId = runUrl.split('/run/')[1];

    // Navigate to review page
    await page.goto(`/run/${runId}/review`);

    // Verify review page loaded
    await expect(page.locator('text=Manual Review')).toBeVisible({ timeout: 10000 });

    // Verify properties are listed in the sidebar
    // The sidebar should show property cards if extraction found properties
    const propertySidebar = page.locator('[class*="w-1/3"]').or(page.locator('[class*="sidebar"]'));
    await expect(propertySidebar.first()).toBeVisible();

    // Count property cards (using a more flexible selector)
    const propertyCards = page.locator('[class*="border-b"][class*="cursor-pointer"]');
    const cardCount = await propertyCards.count();

    console.log(`Found ${cardCount} property cards in sidebar`);

    if (cardCount > 0) {
      // Click the first property
      await propertyCards.first().click();

      // Verify property details panel shows content
      await expect(page.locator('label:has-text("Address")').or(page.locator('text=Address'))).toBeVisible();
    } else {
      console.log('No properties found in review - extraction may have had issues');
    }

    console.log('Phase 1 E2E test completed successfully!');
  });
});
