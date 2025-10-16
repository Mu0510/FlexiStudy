"use client"

import { useEffect } from 'react';

const MOBILE_BREAKPOINT = 768; // This should match the breakpoint in use-mobile.tsx

export function ViewportController() {
  useEffect(() => {
    const viewportMeta = document.querySelector('meta[name="viewport"]');

    if (!viewportMeta) {
      console.warn("Viewport meta tag not found. The page might not be responsive.");
      return;
    }

    const originalContent = viewportMeta.getAttribute('content');

    const updateViewport = () => {
      if (window.innerWidth < MOBILE_BREAKPOINT) {
        viewportMeta.setAttribute('content', `width=device-width, initial-scale=1.0, maximum-scale=1`);
      } else {
        // Restore to the original or a default for desktop
        viewportMeta.setAttribute('content', originalContent || 'width=device-width, initial-scale=1.0');
      }
    };

    updateViewport(); // Set on initial load
    window.addEventListener('resize', updateViewport);

    // Cleanup listener on component unmount
    return () => {
      window.removeEventListener('resize', updateViewport);
      // Optionally restore original content on cleanup
      if(originalContent) {
        viewportMeta.setAttribute('content', originalContent);
      }
    }
  }, []);

  return null; // This component does not render anything visible
}
