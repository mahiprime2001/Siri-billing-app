// lib/printUtils.ts

// Global state to prevent double printing
let isPrintInProgress = false;

// Debounce print requests
let printTimeout: NodeJS.Timeout | null = null;

/**
 * Single, clean print method - prevents double dialogs
 */
export async function openPrintWindow(htmlContent: string, paperSize: string): Promise<void> {
  // Prevent multiple print dialogs
  if (isPrintInProgress) {
    console.warn('⚠ [printUtils] Print already in progress, ignoring duplicate call');
    return;
  }

  // Debounce rapid calls
  if (printTimeout) {
    console.warn('⚠ [printUtils] Print request debounced');
    return;
  }

  isPrintInProgress = true;
  printTimeout = setTimeout(() => {
    printTimeout = null;
  }, 1000); // 1-second debounce

    try {
      console.log('📝 [printUtils] Starting print process');
      const printFrame = await createPrintFrame(paperSize);
      await writeFrameContent(printFrame, htmlContent);
      await waitForFrameLoad(printFrame);
      await triggerSinglePrint(printFrame);
      cleanupPrintFrame(printFrame);
  } catch (error) {
    console.error('❌ [printUtils] Print error:', error);
    isPrintInProgress = false;
    throw error;
  }
}

/** Create isolated print iframe */
async function createPrintFrame(paperSize: string): Promise<HTMLIFrameElement> {
  return new Promise((resolve, reject) => {
    // Remove old frames
    document.querySelectorAll('.tauri-print-frame').forEach(f => f.remove());

    const iframe = document.createElement('iframe');
    iframe.className = 'tauri-print-frame';
    const frameWidth = paperSize.includes("Thermal")
      ? paperSize === "Thermal 80mm"
        ? "80mm"
        : "58mm"
      : "210mm"; // Default to A4 width if not thermal

    iframe.style.cssText = `
      position: fixed!important;
      top: -10000px!important;
      left: -10000px!important;
      width: ${frameWidth}!important;
      height: 297mm!important; /* Height can remain A4 default or be dynamic if needed */
      border: none!important;
      visibility: hidden!important;
      z-index: -9999!important;
    `;
    document.body.appendChild(iframe);

    setTimeout(() => {
      if (iframe.contentWindow && iframe.contentDocument) {
        resolve(iframe);
      } else {
        reject(new Error('Failed to create print frame'));
      }
    }, 100);
  });
}

/** Write HTML into the iframe */
async function writeFrameContent(iframe: HTMLIFrameElement, htmlContent: string): Promise<void> {
  const doc = iframe.contentDocument!;
  const cleanHtml = prepareCleanHtml(htmlContent);
  doc.open();
  doc.write(cleanHtml);
  doc.close();
  console.log('📄 [printUtils] HTML content written to iframe');
}

/** Wait for frame content and resources to load */
async function waitForFrameLoad(iframe: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = iframe.contentDocument!;
    const timeout = setTimeout(() => reject(new Error('Frame load timeout')), 10000);

    const checkResources = () => {
      const images = Array.from(doc.images);
      const allImagesLoaded = images.every(img => img.complete && img.naturalWidth !== 0);
      if (doc.readyState === 'complete' && allImagesLoaded) {
        clearTimeout(timeout);
        console.log('✅ [printUtils] Frame content and resources fully loaded');
        resolve();
      } else {
        setTimeout(checkResources, 100);
      }
    };

    iframe.onload = () => {
      clearTimeout(timeout);
      console.log('✅ [printUtils] Iframe onload event fired');
      checkResources();
    };

    checkResources();
  });
}

/** Trigger the single print dialog */
async function triggerSinglePrint(iframe: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve) => {
    try {
      // Log iframe content for debugging
      const doc = iframe.contentDocument!;
      console.log('📋 [printUtils] Iframe content before print:', doc.body.innerHTML.substring(0, 200) + '...');

      console.log('✅ [printUtils] Triggering single print dialog');
      iframe.contentWindow!.focus();
      iframe.contentWindow!.print();

      const onAfter = () => {
        iframe.contentWindow!.removeEventListener('afterprint', onAfter);
        isPrintInProgress = false;
        console.log('✅ [printUtils] Print dialog closed');
        resolve();
      };
      iframe.contentWindow!.addEventListener('afterprint', onAfter);

      // Fallback to reset state
      setTimeout(() => {
        if (isPrintInProgress) {
          isPrintInProgress = false;
          console.log('🕒 [printUtils] Fallback reset print state');
          resolve();
        }
      }, 30000);
    } catch (error) {
      console.error('❌ [printUtils] Print trigger error:', error);
      isPrintInProgress = false;
      resolve();
    }
  });
}

/** Clean up the iframe */
function cleanupPrintFrame(iframe: HTMLIFrameElement): void {
  setTimeout(() => {
    if (document.body.contains(iframe)) {
      document.body.removeChild(iframe);
      console.log('🧹 [printUtils] Print frame cleaned up');
    }
  }, 2000);
}

/** Prepare a clean HTML document string */
function prepareCleanHtml(htmlContent: string): string {
  let content = htmlContent;
  const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    content = bodyMatch[1];
  }
  content = content.replace(/<script[\s\S]*?<\/script>/gi, '');
  content = content.replace(/<!--[\s\S]*?-->/g, '');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <title>Invoice Print</title>
      <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        html, body { font-family:Arial,sans-serif; font-size:12px; line-height:1.4; background:#fff; }
        @media print {
          html, body { margin:0!important; padding:0!important; -webkit-print-color-adjust:exact!important; }
          /* Removed @page margin here, as it's handled by generatePrintHTML */
          .no-print{display:none!important;}
        }
        .invoice-wrapper{width:100%; padding:10px;}
        table{width:100%; border-collapse:collapse;}
        th, td{padding:4px 8px; text-align:left; border-bottom:1px solid #ddd; font-size:11px;}
        .text-center{text-align:center;} .text-right{text-align:right;} .font-bold{font-weight:bold;}
      </style>
    </head>
    <body>
      <div class="invoice-wrapper">
        ${content}
      </div>
    </body>
    </html>
  `;
}

/** Safe print wrapper */
export async function safePrint(htmlContent: string, paperSize: string): Promise<{ success: boolean; error?: string }> {
  try {
    await openPrintWindow(htmlContent, paperSize);
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown printing error';
    console.error('❌ [printUtils] Safe print failed:', errorMessage);
    return { success: false, error: errorMessage };
  }
}
